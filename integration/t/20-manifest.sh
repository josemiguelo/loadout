# Manifest loading: params, removed templates, layout merging, bases,
# file: validation, and the errors a bad manifest must raise at load.

# --- installer params ----------------------------------------------------
mkdir -p paramrepo/machines
cat > paramrepo/manifest.toml <<'PARAM'
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
printf '[pm]\ntool = "faux"\n' > paramrepo/machines/m1.toml
OUT=$("$BIN" --repo paramrepo --machine m1 explain tool)
echo "$OUT" | grep -q "echo installing tool from vanilla" || fail "installer params substitute"
printf '[installers.faux]\nparams = ["flavor"]\ninstall = "echo {flavor}"\n\n[programs.tool]\n[programs.tool.install.faux]\n' > paramrepo/manifest.toml
OUT=$("$BIN" --repo paramrepo --machine m1 explain tool 2>&1 || true)
echo "$OUT" | grep -q "needs a value for 'flavor'" || fail "a missing param must fail the load"
ok "installers take declared params, and a missing one is a load error"

# --- templates were removed: a repo using them must not load empty --------
mkdir -p tmplrepo
printf '[templates.rpm]\npackages = ["vlc"]\n[templates.rpm.install.dnf]\ncommand = "sudo dnf install -y {name}"\n' > tmplrepo/manifest.toml
OUT=$("$BIN" --repo tmplrepo explain 2>&1 || true)
echo "$OUT" | grep -q "removed in loadout 0.9.0" || fail "a templated manifest must fail loudly"
ok "templates are gone, and a manifest still using them says so"

# --- split layout: manifest.d fragment + machines/<name>.toml -------------
basic_repo repo
cat > repo/manifest.d/extra.toml <<'TOML'
[programs.splitprog]
[programs.splitprog.version]
command = "git --version"
regex = "git version ([0-9.]+)"
[programs.splitprog.install.manual]
command = "false"
TOML
cat > repo/machines/m3.toml <<'TOML'
[pm]
git = "manual"
splitprog = "manual"
TOML
"$BIN" --repo repo --machine m3 status >/dev/null || fail "status with split layout"
grep -q '"splitprog"' repo/state/m3.json || fail "fragment program checked"
"$BIN" --repo repo --machine m3 setup-new-machine --dry-run >/dev/null || fail "machine file mapping used for plan"
rm repo/manifest.d/extra.toml repo/machines/m3.toml repo/state/m3.json
ok "manifest.d fragments and machines/*.toml files are merged"

cp repo/manifest.toml repo/manifest.toml.bak
cat >> repo/manifest.toml <<'TOML'

[machines.m9.pm]
git = "manual"
TOML
OUT=$("$BIN" --repo repo --machine m1 status 2>&1 || true)
echo "$OUT" | grep -q "sections are not allowed" || fail "inline machines should be rejected"
mv repo/manifest.toml.bak repo/manifest.toml
ok "inline [machines.*] sections in the manifest are rejected"

# --- machine bases + subfolders -----------------------------------------
mkdir -p repo/machines/base repo/machines/hosts
cat > repo/machines/base/testbase.toml <<'TOML'
base = true
scripts = ["marker"]

[pm]
git = "manual"
TOML
cat > repo/machines/hosts/m9.toml <<'TOML'
extends = "testbase"
TOML
OUT=$("$BIN" --repo repo --machine m9 setup-new-machine --dry-run) || fail "inherited machine plans"
echo "$OUT" | grep -q "git" || fail "child inherits the base's pm mapping"
echo "$OUT" | grep -qE "~ marker +script" || fail "child inherits the base's script opt-ins"
"$BIN" --repo repo --machine m9 status --no-write >/dev/null || fail "status works for inherited machine"
"$BIN" --repo repo diff 2>/dev/null | grep -q "testbase" && fail "bases must not appear as machines" || true
rm -rf repo/machines/base repo/machines/hosts
ok "machine files inherit from bases and live in subfolders"

# --- script file that doesn't exist -> caught at manifest load -----------
cp repo/manifest.toml repo/manifest.toml.bak
cat >> repo/manifest.toml <<'TOML'

[scripts.ghost-script]
file = "scripts/does-not-exist.sh"
TOML
OUT=$("$BIN" --repo repo status 2>&1 || true)
echo "$OUT" | grep -q "file 'scripts/does-not-exist.sh' not found" || fail "missing script file should error at load"
mv repo/manifest.toml.bak repo/manifest.toml
ok "script file that doesn't exist is caught at manifest load"

# --- mapping to a nonexistent install key --------------------------------
mkdir -p badmap/machines
cat > badmap/manifest.toml <<'TOML'
[programs.tool]
[programs.tool.install.dnf]
command = "sudo dnf install -y tool"
TOML
printf '[pm]\ntool = "brew"\n' > badmap/machines/m1.toml
OUT=$("$BIN" --repo badmap status 2>&1 || true)
echo "$OUT" | grep -q "no 'brew' entry" || fail "bad-mapping validation message"
ok "manifest rejects mappings to nonexistent install keys"

# --- file: install values run as repo scripts, repo-root cwd, from anywhere
mkdir -p filerepo/scripts filerepo/state filerepo/machines
cat > filerepo/manifest.toml <<'TOML'
[programs.filetool]
[programs.filetool.version]
command = "test -f installed-marker.txt && echo filetool 1.0"
regex = "filetool ([0-9.]+)"
[programs.filetool.install.script]
command = "file:scripts/install-filetool.sh install"
TOML
# Requires the "install" argument and writes relative to cwd — proves both
# argument passing and repo-root cwd.
printf '#!/bin/sh\n[ "${1:-}" = "install" ] || exit 9\necho done > installed-marker.txt\n' > filerepo/scripts/install-filetool.sh
printf '[pm]\nfiletool = "script"\n' > filerepo/machines/m1.toml

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
cat > filerepo/manifest.toml <<'TOML'
[programs.filetool]
[programs.filetool.install.script]
command = "true"
check = "file:scripts/check-filetool.sh"
regex = "(done)"
TOML
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
