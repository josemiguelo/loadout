# Manifest loading: params, removed templates, layout merging, bases,
# file: validation, and the errors a bad manifest must raise at load.

# --- installer params ----------------------------------------------------
mkdir -p paramrepo/machines
cat > paramrepo/loadout.toml <<'PARAM'
[installers.faux]
params = ["flavor"]
install = "echo installing {pkg} from {flavor}"
check = "echo {pkg} 1.0"
regex = "([0-9.]+)"

[programs.tool]
[programs.tool.install.faux]
[programs.tool.install.faux.with]
flavor = "vanilla"
PARAM
add_layout "paramrepo"
printf '[packages.install]\ntool = "faux"\n' > paramrepo/machines/m1.toml
OUT=$("$BIN" --repo paramrepo --machine m1 explain tool)
echo "$OUT" | grep -q "echo installing tool from vanilla" || fail "installer params substitute"
printf '[installers.faux]\nparams = ["flavor"]\ninstall = "echo {flavor}"\n\n[programs.tool]\n[programs.tool.install.faux]\n' > paramrepo/loadout.toml
add_layout "paramrepo"
OUT=$("$BIN" --repo paramrepo --machine m1 explain tool 2>&1 || true)
echo "$OUT" | grep -q "needs a value for 'flavor'" || fail "a missing param must fail the load"
ok "installers take declared params, and a missing one is a load error"

# --- templates were removed: a repo using them must not load empty --------
mkdir -p tmplrepo
printf '[templates.rpm]\npackages = ["vlc"]\n[templates.rpm.install.dnf]\ncommand = "sudo dnf install -y {name}"\n' > tmplrepo/loadout.toml
add_layout "tmplrepo"
OUT=$("$BIN" --repo tmplrepo explain 2>&1 || true)
echo "$OUT" | grep -q "removed in loadout 0.9.0" || fail "a templated manifest must fail loudly"
ok "templates are gone, and a manifest still using them says so"

# --- split layout: manifest.d fragment + machines/<name>.toml -------------
basic_repo repo
cat > repo/programs/extra.toml <<'TOML'
[programs.splitprog]
[programs.splitprog.version]
command = "git --version"
regex = "git version ([0-9.]+)"
[programs.splitprog.install.manual]
command = "false"
TOML
cat > repo/machines/m3.toml <<'TOML'
[git]
install = "manual"

[splitprog]
install = "manual"
TOML
"$BIN" --repo repo --machine m3 status >/dev/null || fail "status with split layout"
grep -q '"splitprog"' repo/state/m3.json || fail "fragment program checked"
"$BIN" --repo repo --machine m3 setup-new-machine --dry-run >/dev/null || fail "machine file mapping used for plan"
rm repo/programs/extra.toml repo/machines/m3.toml repo/state/m3.json
ok "manifest.d fragments and machines/*.toml files are merged"

cp repo/loadout.toml repo/loadout.toml.bak
cat >> repo/loadout.toml <<'TOML'

[machines.m9.pm]
git = "manual"
TOML
OUT=$("$BIN" --repo repo --machine m1 status 2>&1 || true)
echo "$OUT" | grep -q "sections are not allowed" || fail "inline machines should be rejected"
mv repo/loadout.toml.bak repo/loadout.toml
ok "inline [machines.*] sections in the manifest are rejected"

# --- profiles, flat machines ----------------------------------------------
mkdir -p repo/profiles
cat > repo/profiles/testbase.toml <<'TOML'
[git]
install = "manual"
scripts = ["marker"]
TOML
cat > repo/machines/m9.toml <<'TOML'
extends = ["testbase"]
TOML
OUT=$("$BIN" --repo repo --machine m9 setup-new-machine --dry-run) || fail "inherited machine plans"
echo "$OUT" | grep -q "git" || fail "the machine inherits the profile's mapping"
echo "$OUT" | grep -qE "~ marker +script" || fail "the machine inherits the profile's script opt-ins"
"$BIN" --repo repo --machine m9 status --no-write >/dev/null || fail "status works for inherited machine"
"$BIN" --repo repo diff 2>/dev/null | grep -q "testbase" && fail "profiles must not appear as machines" || true
OUT=$("$BIN" --repo repo --machine m9 explain)
echo "$OUT" | grep -qE "extends +testbase" || fail "explain names the machine's profiles: $OUT"
mkdir -p repo/machines/hosts
mv repo/machines/m9.toml repo/machines/hosts/m9.toml
OUT=$("$BIN" --repo repo --machine m9 status --no-write 2>&1) && fail "a machine file in a subfolder must be refused"
echo "$OUT" | grep -q "machines/hosts/m9.toml: machine files live directly in machines/" || fail "the subfolder is named: $OUT"
rm -rf repo/profiles/testbase.toml repo/machines/hosts
ok "machines extend profiles from profiles/ and sit directly in machines/"

# --- [data]: declared in loadout.toml, overridden per profile and machine -
cp repo/loadout.toml repo/loadout.toml.bak
printf '\n[data]\nomarchy = false\n\n[data.kitty]\nopacity = 0.85\n' >> repo/loadout.toml
printf '[data]\nomarchy = true\n' > repo/profiles/omarchy.toml
printf 'extends = ["omarchy"]\n\n[git]\ninstall = "manual"\n\n[kitty.data]\nopacity = 0.99\n' > repo/machines/m9.toml
OUT=$("$BIN" --repo repo --machine m9 explain) || fail "explain shows a machine with data"
echo "$OUT" | grep -qE "data.kitty.opacity +0.99" || fail "the machine's own value wins: $OUT"
echo "$OUT" | grep -qE "data.omarchy +true" || fail "the profile's value comes through: $OUT"
echo "$OUT" | grep -qE "\[git\] +git = manual" || fail "explain shows the machine's own groups: $OUT"
OUT=$("$BIN" --repo repo --machine m2 explain)
echo "$OUT" | grep -qE "data.omarchy +false" || fail "a machine without [data] gets the defaults: $OUT"
printf '[packages.install]\ngit = "manual"\n\n[data.kitty]\nopacty = 0.5\n' > repo/machines/m9.toml
OUT=$("$BIN" --repo repo --machine m9 status --no-write 2>&1) && fail "an undeclared [data] key must be refused"
echo "$OUT" | grep -q "machines/m9.toml: \[data\] key 'kitty.opacty' is not declared in loadout.toml \[data\]" ||
    fail "the undeclared key is named: $OUT"
mv repo/loadout.toml.bak repo/loadout.toml
rm -f repo/profiles/omarchy.toml repo/machines/m9.toml
ok "[data] defaults, profile and machine values merge, and explain shows them; a typo is refused"

# --- script file that doesn't exist -> caught at manifest load -----------
cp repo/loadout.toml repo/loadout.toml.bak
cat >> repo/loadout.toml <<'TOML'

[scripts.ghost-script]
file = "scripts/does-not-exist.sh"
TOML
OUT=$("$BIN" --repo repo status 2>&1 || true)
echo "$OUT" | grep -q "file 'scripts/does-not-exist.sh' not found" || fail "missing script file should error at load"
mv repo/loadout.toml.bak repo/loadout.toml
ok "script file that doesn't exist is caught at manifest load"

# --- mapping to a nonexistent install key --------------------------------
mkdir -p badmap/machines
cat > badmap/loadout.toml <<'TOML'
[programs.tool]
[programs.tool.install.dnf]
command = "sudo dnf install -y tool"
TOML
add_layout "badmap"
printf '[packages.install]\ntool = "brew"\n' > badmap/machines/m1.toml
OUT=$("$BIN" --repo badmap status 2>&1 || true)
echo "$OUT" | grep -q "no 'brew' entry" || fail "bad-mapping validation message"
ok "manifest rejects mappings to nonexistent install keys"

# --- file: install values run as repo scripts, repo-root cwd, from anywhere
mkdir -p filerepo/scripts filerepo/state filerepo/machines
cat > filerepo/loadout.toml <<'TOML'
[programs.filetool]
[programs.filetool.version]
command = "test -f installed-marker.txt && echo filetool 1.0"
regex = "filetool ([0-9.]+)"
[programs.filetool.install.script]
command = "file:scripts/install-filetool.sh install"
TOML
add_layout "filerepo"
# Requires the "install" argument and writes relative to cwd — proves both
# argument passing and repo-root cwd.
printf '#!/bin/sh\n[ "${1:-}" = "install" ] || exit 9\necho done > installed-marker.txt\n' > filerepo/scripts/install-filetool.sh
printf '[packages.install]\nfiletool = "script"\n' > filerepo/machines/m1.toml

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
cat > filerepo/loadout.toml <<'TOML'
[programs.filetool]
[programs.filetool.install.script]
command = "true"
check = "file:scripts/check-filetool.sh"
regex = "(done)"
TOML
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

# --- the root file and its [layout] ---------------------------------------
mkdir -p oldrepo
printf '[meta]\nname = "old"\n' > oldrepo/manifest.toml
OUT=$("$BIN" --repo oldrepo status 2>&1) && fail "a 0.x repo must be refused"
echo "$OUT" | grep -q "error: .*loadout 0.x repo" || fail "a 0.x repo is named as one: $OUT"
ok "a 0.x repo (manifest.toml) is refused in one line"

mkdir -p nolayout
printf '[meta]\nname = "x"\n' > nolayout/loadout.toml
OUT=$("$BIN" --repo nolayout status 2>&1) && fail "a root file without [layout] must be refused"
echo "$OUT" | grep -q "has no \[layout\] table" || fail "the missing [layout] is named: $OUT"
ok "[layout] is required"

mkdir -p custom/hosts custom/tools
printf '[layout]\nfragments = ["tools/*.toml"]\nmachines = "hosts"\nstate = "observed"\n' > custom/loadout.toml
printf '[programs.git]\n[programs.git.version]\ncommand = "git --version"\nregex = "git version ([0-9.]+)"\n[programs.git.install.manual]\ncommand = "false"\n' > custom/tools/git.toml
printf '[git]\ninstall = "manual"\n' > custom/hosts/m1.toml
"$BIN" --repo custom --machine m1 status >/dev/null || fail "a custom layout loads"
[ -f custom/observed/m1.json ] || fail "state lands in [layout] state"
[ -d custom/state ] && fail "nothing is written to a default state dir" || true
OUT=$("$BIN" --repo custom installers --eject 2>&1) && fail "--eject must refuse a file no glob loads"
echo "$OUT" | grep -q "no \[layout\] fragments glob loads programs/installers/builtin.toml" || fail "--eject says why: $OUT"
ok "fragments, machines and state come from [layout]; --eject only writes what loads"
