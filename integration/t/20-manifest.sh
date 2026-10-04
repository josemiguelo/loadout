# Manifest loading: params, removed templates, layout merging, bases,
# file: validation, and the errors a bad manifest must raise at load.

# --- installer params ----------------------------------------------------
mkdir -p paramrepo/machines
cat > paramrepo/loadout.yaml <<'YAML'
installers:
  faux:
    params: [flavor]
    install: 'echo installing {pkg} from {flavor}'
    check: 'echo {pkg} 1.0'
    regex: '([0-9.]+)'

programs:
  tool:
    install:
      faux:
        with:
          flavor: vanilla
YAML
add_layout "paramrepo"
printf 'tool:\n  install_with: faux\n' > paramrepo/machines/m1.yaml
OUT=$("$BIN" --repo paramrepo --machine m1 explain tool)
echo "$OUT" | grep -q "echo installing tool from vanilla" || fail "installer params substitute"
cat > paramrepo/loadout.yaml <<'YAML'
installers:
  faux:
    params: [flavor]
    install: 'echo {flavor}'

programs:
  tool:
    install:
      faux: {}
YAML
add_layout "paramrepo"
OUT=$("$BIN" --repo paramrepo --machine m1 explain tool 2>&1 || true)
echo "$OUT" | grep -q "needs a value for 'flavor'" || fail "a missing param must fail the load"
ok "installers take declared params, and a missing one is a load error"

# A file: param is a path next to the program's own file, wherever the
# installer's command runs (here: the repo root, where loadout.yaml is).
mkdir -p fparam/machines fparam/programs/tool
cat > fparam/loadout.yaml <<'YAML'
installers:
  copyin:
    params: [src]
    install: 'cp {src} installed-{pkg}.txt'
    check: 'cat installed-{pkg}.txt'
    regex: '([0-9.]+)'
YAML
add_layout "fparam"
cat > fparam/programs/tool/tool.yaml <<'YAML'
install:
  copyin:
    with:
      src: 'file:payload.txt'
YAML
printf 'tool 4.2\n' > fparam/programs/tool/payload.txt
printf 'tool:\n  install_with: copyin\n' > fparam/machines/m1.yaml
"$BIN" --repo fparam --machine m1 install tool --yes >/dev/null 2>&1 || fail "an install with a file: param runs"
grep -qx "tool 4.2" fparam/installed-tool.txt || fail "the file: param reached the file next to tool.yaml"
rm fparam/programs/tool/payload.txt
OUT=$("$BIN" --repo fparam --machine m1 explain tool 2>&1) && fail "a missing file: param must fail the load"
echo "$OUT" | grep -q "with.src: file 'payload.txt' not found (relative to programs/tool/)" || fail "the missing param file is named: $OUT"
ok "a file: param resolves next to its program and is checked at load"

# --- templates were removed: a repo using them must not load empty --------
mkdir -p tmplrepo
cat > tmplrepo/loadout.yaml <<'YAML'
templates:
  rpm:
    packages: [vlc]
    install:
      dnf:
        command: 'sudo dnf install -y {name}'
YAML
add_layout "tmplrepo"
OUT=$("$BIN" --repo tmplrepo explain 2>&1 || true)
echo "$OUT" | grep -q "removed in loadout 0.9.0" || fail "a templated manifest must fail loudly"
ok "templates are gone, and a manifest still using them says so"

# --- split layout: a fragment + machines/<name>.yaml ------------------------
basic_repo repo
cat > repo/programs/splitprog.yaml <<'YAML'
version:
  command: 'git --version'
  regex: 'git version ([0-9.]+)'
install:
  manual:
    command: 'false'
YAML
cat > repo/machines/m3.yaml <<'YAML'
git:
  install_with: manual
splitprog:
  install_with: manual
YAML
"$BIN" --repo repo --machine m3 status >/dev/null || fail "status with split layout"
grep -q '"splitprog"' repo/state/m3.json || fail "fragment program checked"
"$BIN" --repo repo --machine m3 setup-new-machine --dry-run >/dev/null || fail "machine file mapping used for plan"
rm repo/programs/splitprog.yaml repo/machines/m3.yaml repo/state/m3.json
ok "fragments and machine files are merged"

cp repo/loadout.yaml repo/loadout.yaml.bak
cat >> repo/loadout.yaml <<'YAML'

machines:
  m9:
    pm:
      git: manual
YAML
OUT=$("$BIN" --repo repo --machine m1 status 2>&1 || true)
echo "$OUT" | grep -q "sections are not allowed" || fail "inline machines should be rejected"
mv repo/loadout.yaml.bak repo/loadout.yaml
ok "inline machines sections in the manifest are rejected"

# --- profiles, flat machines ----------------------------------------------
mkdir -p repo/profiles
cat > repo/profiles/testbase.yaml <<'YAML'
git:
  install_with: manual
  scripts: [marker]
YAML
cat > repo/machines/m9.yaml <<'YAML'
extends: [testbase]
YAML
OUT=$("$BIN" --repo repo --machine m9 setup-new-machine --dry-run) || fail "inherited machine plans"
echo "$OUT" | grep -q "git" || fail "the machine inherits the profile's mapping"
echo "$OUT" | grep -qE "~ marker +script" || fail "the machine inherits the profile's script opt-ins"
"$BIN" --repo repo --machine m9 status --no-write >/dev/null || fail "status works for inherited machine"
"$BIN" --repo repo diff 2>/dev/null | grep -q "testbase" && fail "profiles must not appear as machines" || true
OUT=$("$BIN" --repo repo --machine m9 explain)
echo "$OUT" | grep -qE "extends +testbase" || fail "explain names the machine's profiles: $OUT"
mkdir -p repo/machines/hosts
mv repo/machines/m9.yaml repo/machines/hosts/m9.yaml
OUT=$("$BIN" --repo repo --machine m9 status --no-write 2>&1) && fail "a machine file in a subfolder must be refused"
echo "$OUT" | grep -q "machines/hosts/m9.yaml: machine files live directly in machines/" || fail "the subfolder is named: $OUT"
rm -rf repo/profiles/testbase.yaml repo/machines/hosts
ok "machines extend profiles from profiles/ and sit directly in machines/"

# --- install_with: programs listed per variant ----------------------------
cat > repo/profiles/testbase.yaml <<'YAML'
install_with:
  manual: [git]
git:
  scripts: [marker]
YAML
cat > repo/machines/m9.yaml <<'YAML'
extends: [testbase]
YAML
OUT=$("$BIN" --repo repo --machine m9 setup-new-machine --dry-run) || fail "a listed program plans"
echo "$OUT" | grep -q "git" || fail "the listed program is mapped: $OUT"
echo "$OUT" | grep -qE "~ marker +script" || fail "its own entry still opts into scripts: $OUT"
cat > repo/machines/m9.yaml <<'YAML'
install_with:
  manual: [git]
git:
  scripts: [marker]
YAML
OUT=$("$BIN" --repo repo --machine m9 explain)
echo "$OUT" | grep -qE "^ *git +install_with manual · scripts marker" || fail "explain shows a listed program as one row: $OUT"
cat > repo/machines/m9.yaml <<'YAML'
install_with:
  manual: [git]
git:
  install_with: manual
YAML
OUT=$("$BIN" --repo repo --machine m9 status --no-write 2>&1) && fail "a program mapped twice must be refused"
echo "$OUT" | grep -q "machines/m9.yaml: git is listed under install_with.manual and has its own install_with: manual" ||
    fail "the double mapping is named: $OUT"
rm -f repo/profiles/testbase.yaml repo/machines/m9.yaml
ok "install_with lists programs per variant; a program's own entry adds scripts, never a second mapping"

# --- data: declared in loadout.yaml, overridden per profile and machine -
cp repo/loadout.yaml repo/loadout.yaml.bak
cat >> repo/loadout.yaml <<'YAML'

data:
  omarchy: false
  kitty:
    opacity: 0.85
YAML
cat > repo/profiles/omarchy.yaml <<'YAML'
data:
  omarchy: true
YAML
cat > repo/machines/m9.yaml <<'YAML'
extends: [omarchy]
git:
  install_with: manual
data:
  kitty:
    opacity: 0.99
YAML
OUT=$("$BIN" --repo repo --machine m9 explain) || fail "explain shows a machine with data"
echo "$OUT" | grep -qE "data.kitty.opacity +0.99" || fail "the machine's own value wins: $OUT"
echo "$OUT" | grep -qE "data.omarchy +true" || fail "the profile's value comes through: $OUT"
echo "$OUT" | grep -qE "^ *git +install_with manual" || fail "explain shows each program the machine names: $OUT"
OUT=$("$BIN" --repo repo --machine m2 explain)
echo "$OUT" | grep -qE "data.omarchy +false" || fail "a machine without data gets the defaults: $OUT"
cat > repo/machines/m9.yaml <<'YAML'
git:
  install_with: manual
data:
  kitty:
    opacty: 0.5
YAML
OUT=$("$BIN" --repo repo --machine m9 status --no-write 2>&1) && fail "an undeclared data key must be refused"
echo "$OUT" | grep -q "machines/m9.yaml: data key 'kitty.opacty' is not declared in loadout.yaml" ||
    fail "the undeclared key is named: $OUT"
mv repo/loadout.yaml.bak repo/loadout.yaml
rm -f repo/profiles/omarchy.yaml repo/machines/m9.yaml
ok "data defaults, profile and machine values merge, and explain shows them; a typo is refused"

# --- script file that doesn't exist -> caught at manifest load -----------
# A fragment of its own: the root already holds the repo's scripts map.
cat > repo/maintenance/ghost.loadout.yaml <<'YAML'
scripts:
  ghost-script:
    file: scripts/does-not-exist.sh
YAML
OUT=$("$BIN" --repo repo status 2>&1 || true)
echo "$OUT" | grep -q "file 'scripts/does-not-exist.sh' not found" || fail "missing script file should error at load"
rm repo/maintenance/ghost.loadout.yaml
ok "script file that doesn't exist is caught at manifest load"

# --- mapping to a nonexistent install key --------------------------------
mkdir -p badmap/machines
cat > badmap/loadout.yaml <<'YAML'
programs:
  tool:
    install:
      dnf:
        command: 'sudo dnf install -y tool'
YAML
add_layout "badmap"
printf 'tool:\n  install_with: brew\n' > badmap/machines/m1.yaml
OUT=$("$BIN" --repo badmap status 2>&1 || true)
echo "$OUT" | grep -q "no 'brew' entry" || fail "bad-mapping validation message"
ok "manifest rejects mappings to nonexistent install keys"

# --- file: install values run as repo scripts, repo-root cwd, from anywhere
mkdir -p filerepo/scripts filerepo/state filerepo/machines
cat > filerepo/loadout.yaml <<'YAML'
programs:
  filetool:
    version:
      command: 'test -f installed-marker.txt && echo filetool 1.0'
      regex: 'filetool ([0-9.]+)'
    install:
      script:
        command: 'file:scripts/install-filetool.sh install'
YAML
add_layout "filerepo"
# Requires the "install" argument and writes relative to cwd — proves both
# argument passing and repo-root cwd.
printf '#!/bin/sh\n[ "${1:-}" = "install" ] || exit 9\necho done > installed-marker.txt\n' > filerepo/scripts/install-filetool.sh
printf 'filetool:\n  install_with: script\n' > filerepo/machines/m1.yaml

OUT=$("$BIN" --repo filerepo --machine m1 setup-new-machine --dry-run)
echo "$OUT" | grep -q "sh 'scripts/install-filetool.sh' install" || fail "file: value with args translated in plan"
"$BIN" --repo filerepo --machine m1 setup-new-machine --yes >/dev/null || fail "file: install exits 0"
[ -f filerepo/installed-marker.txt ] || fail "install ran with repo-root cwd and args"
ok "file: install values run repo scripts with arguments from the repo root"

rm filerepo/scripts/install-filetool.sh
OUT=$("$BIN" --repo filerepo --machine m1 status 2>&1 || true)
echo "$OUT" | grep -q "file 'scripts/install-filetool.sh' not found" || fail "missing file: script should error at load"
ok "missing file: install script is caught at manifest load"

# file: works in check commands too, and missing check files fail at load.
cat > filerepo/loadout.yaml <<'YAML'
programs:
  filetool:
    install:
      script:
        command: 'true'
        check: 'file:scripts/check-filetool.sh'
        regex: '(done)'
YAML
add_layout "filerepo"
OUT=$("$BIN" --repo filerepo --machine m1 status 2>&1 || true)
echo "$OUT" | grep -q "file 'scripts/check-filetool.sh' not found" || fail "missing file: check should error at load"
printf '#!/bin/sh\necho done\n' > filerepo/scripts/check-filetool.sh
"$BIN" --repo filerepo --machine m1 status >/dev/null || fail "file: check runs"
grep -q '"version": "done"' filerepo/state/m1.json || fail "file: check observed"
ok "file: works in check commands and is validated at load"

# --- missing manifest ----------------------------------------------------
"$BIN" --repo /nonexistent status >/dev/null 2>&1 && fail "missing manifest should exit 1" || true
OUT=$("$BIN" --repo /nonexistent status 2>&1 || true)
echo "$OUT" | grep -q "error: Manifest not found" || fail "clean manifest error"
ok "missing manifest gives a clean error"

# --- the root file and its layout ----------------------------------------
# A repo with no loadout.yaml is refused in one line, naming the root it wants.
mkdir -p oldrepo
OUT=$("$BIN" --repo oldrepo status 2>&1) && fail "a repo without loadout.yaml must be refused"
echo "$OUT" | grep -q "error: Manifest not found: .*loadout.yaml" || fail "a missing root is named: $OUT"
ok "a repo without loadout.yaml is refused in one line"

mkdir -p nolayout
cat > nolayout/loadout.yaml <<'YAML'
meta:
  name: x
YAML
OUT=$("$BIN" --repo nolayout status 2>&1) && fail "a root file without layout must be refused"
echo "$OUT" | grep -q "has no layout table" || fail "the missing layout is named: $OUT"
ok "layout is required"

mkdir -p custom/hosts custom/tools
cat > custom/loadout.yaml <<'YAML'
layout:
  fragments: ['tools/*.yaml']
  machines: hosts
  state: observed
YAML
cat > custom/tools/git.yaml <<'YAML'
version:
  command: 'git --version'
  regex: 'git version ([0-9.]+)'
install:
  manual:
    command: 'false'
YAML
cat > custom/hosts/m1.yaml <<'YAML'
git:
  install_with: manual
YAML
"$BIN" --repo custom --machine m1 status >/dev/null || fail "a custom layout loads"
[ -f custom/observed/m1.json ] || fail "state lands in layout state"
[ -d custom/state ] && fail "nothing is written to a default state dir" || true
OUT=$("$BIN" --repo custom installers --eject 2>&1) && fail "--eject must refuse a file no glob loads"
echo "$OUT" | grep -q "no layout fragments glob loads programs/installers/builtin.loadout.yaml" || fail "--eject says why: $OUT"
ok "fragments, machines and state come from layout; --eject only writes what loads"
