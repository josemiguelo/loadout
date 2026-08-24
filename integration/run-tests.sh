#!/bin/sh
# Black-box integration tests: drive the real binary against a temp config repo
# with a local bare git remote. Usage: integration/run-tests.sh [path-to-binary]
set -eu

BIN=${1:-app/build/bin/linuxX64/debugExecutable/loadout.kexe}
BIN=$(realpath "$BIN")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PASS=0

ok() { PASS=$((PASS + 1)); echo "ok $PASS - $1"; }
fail() { echo "FAIL - $1"; exit 1; }

cd "$WORK"

# --- init ---------------------------------------------------------------
"$BIN" init repo >/dev/null || fail "init exits 0"
[ -f repo/manifest.toml ] || fail "init creates manifest"
[ -d repo/scripts ] && [ -d repo/state ] && [ -d repo/machines ] && [ -d repo/manifest.d ] || fail "init creates dirs"
[ -f repo/machines/example.toml.sample ] || fail "init creates machine example"
[ -f repo/manifest.d/example.toml.sample ] || fail "init creates fragment example"
[ -f repo/manifest.d/00_installers.toml ] || fail "init creates the installers fragment"
# .sample files must not be picked up by the loader
"$BIN" --repo repo status >/dev/null || fail "samples must not break loading"
git -C repo rev-parse --is-inside-work-tree >/dev/null || fail "init git-inits"
ok "init scaffolds a repo"

"$BIN" init repo >/dev/null 2>&1 && fail "init refuses to overwrite" || true
ok "init refuses to overwrite an existing manifest"

git -C repo config user.email test@example.com
git -C repo config user.name "Integration Test"

# --- manifest: only git (installed everywhere), plus a marker script ----
# "manual" is a custom install key so the tests don't depend on which
# package manager the host actually has.
cat > repo/manifest.toml <<'EOF'
[programs.git]
[programs.git.version]
command = "git --version"
regex = "git version ([0-9.]+)"
[programs.git.install.dnf]
command = "sudo dnf install -y git"
[programs.git.install.manual]
command = "echo install git yourself && false"

[scripts.marker]
file = "scripts/marker.sh"
check = "test -f marker.txt"
EOF
printf 'scripts = ["marker"]\n\n[pm]\ngit = "manual"\n' > repo/machines/m1.toml
# m2 deliberately does NOT opt into any scripts.
printf '[pm]\ngit = "manual"\n' > repo/machines/m2.toml
printf '#!/bin/sh\necho created > marker.txt\n' > repo/scripts/marker.sh

# --- status -------------------------------------------------------------
"$BIN" --repo repo --machine m1 status >/dev/null || fail "status exits 0"
[ -f repo/state/m1.json ] || fail "status writes state file"
grep -q '"status": "installed"' repo/state/m1.json || fail "git detected as installed"
grep -q '"machine": "m1"' repo/state/m1.json || fail "machine name recorded"
# The marker script never ran, but its check is observed -> pending.
grep -q '"marker"' repo/state/m1.json || fail "script check observed on status"
grep -q '"status": "pending"' repo/state/m1.json || fail "unrun script recorded as pending"
ok "status detects git, observes script checks, and writes state"

"$BIN" --repo repo --machine m1 status --json | grep -q '"schemaVersion": 1' || fail "status --json"
ok "status --json emits the state document"

# --- install (dry run + already installed) ------------------------------
OUT=$("$BIN" --repo repo --machine m1 setup-new-machine --dry-run)
echo "$OUT" | grep -q "git" || fail "dry-run mentions git"
echo "$OUT" | grep -qE "~ marker +script" || fail "dry-run lists the script"
[ ! -f repo/marker.txt ] || fail "dry-run must not execute scripts"
ok "setup-new-machine --dry-run plans without executing"

"$BIN" --repo repo --machine m1 setup-new-machine --yes --skip-scripts >/dev/null || fail "install (all installed) exits 0"
ok "setup-new-machine with everything installed is a no-op"

# --- run (script + check gate + force) ----------------------------------
"$BIN" --repo repo --machine m1 run marker >/dev/null || fail "run exits 0"
[ -f repo/marker.txt ] || fail "script created marker.txt"
grep -q '"marker"' repo/state/m1.json || fail "script state recorded"
grep -q '"status": "done"' repo/state/m1.json || fail "script marked done"
ok "run executes a script and records state"

OUT=$("$BIN" --repo repo --machine m1 run marker)
echo "$OUT" | grep -q "already done" || fail "check gate skips a done script"
ok "run respects the check gate"

OUT=$("$BIN" --repo repo --machine m1 run marker --force)
echo "$OUT" | grep -q "ran marker" || fail "--force reruns"
ok "run --force ignores the check gate"

# m2 never opted into the marker script.
"$BIN" --repo repo --machine m2 run marker >/dev/null 2>&1 && fail "run without opt-in should fail" || true
OUT=$("$BIN" --repo repo --machine m2 run marker 2>&1 || true)
echo "$OUT" | grep -q "not enabled for machine 'm2'" || fail "not-enabled error message"
grep -q '"marker"' repo/state/m2.json && fail "m2 must not observe un-opted script" || true
ok "scripts are opt-in per machine"

# Arguments flow to file scripts and their checks as positional params.
printf '#!/bin/sh\necho "$1" > arg-marker.txt\n' > repo/scripts/argscript.sh
cat >> repo/manifest.toml <<'EOF'

[scripts.argscript]
file = "scripts/argscript.sh"
check = "test -f arg-marker.txt && grep -qx $1 arg-marker.txt"
EOF
printf 'scripts = ["argscript fedora"]\n\n[pm]\ngit = "manual"\n' > repo/machines/m2.toml
"$BIN" --repo repo --machine m2 run argscript >/dev/null || fail "run with args exits 0"
grep -qx "fedora" repo/arg-marker.txt || fail "argument reached the script"
OUT=$("$BIN" --repo repo --machine m2 run argscript)
echo "$OUT" | grep -q "already done" || fail "check with args should pass after run"
rm repo/arg-marker.txt repo/scripts/argscript.sh
python3 - <<'PYCLEAN' 2>/dev/null || sed -i '/argscript/d' repo/manifest.toml
import pathlib
m = pathlib.Path("repo/manifest.toml")
m.write_text(m.read_text().split("[scripts.argscript]")[0].rstrip() + "\n")
PYCLEAN
printf '[pm]\ngit = "manual"\n' > repo/machines/m2.toml
ok "script arguments reach the file script and its check"

# --- install runs eligible scripts --------------------------------------
rm repo/marker.txt
"$BIN" --repo repo --machine m1 setup-new-machine --yes >/dev/null || fail "install with script exits 0"
[ -f repo/marker.txt ] || fail "install ran the script"
ok "setup-new-machine runs eligible scripts"

# --- diff ---------------------------------------------------------------
"$BIN" --repo repo --machine m2 status >/dev/null
"$BIN" --repo repo diff >/dev/null || fail "diff exits 0 when in sync"
ok "diff exits 0 when machines agree"

cat >> repo/manifest.toml <<'EOF'

[programs.definitely-not-installed-xyz]
[programs.definitely-not-installed-xyz.version]
command = "definitely-not-installed-xyz --version"
regex = "([0-9.]+)"
[programs.definitely-not-installed-xyz.install.manual]
command = "false"
EOF
printf 'definitely-not-installed-xyz = "manual"\n' >> repo/machines/m1.toml
printf 'definitely-not-installed-xyz = "manual"\n' >> repo/machines/m2.toml
"$BIN" --repo repo --machine m1 status >/dev/null
"$BIN" --repo repo --machine m2 status >/dev/null
"$BIN" --repo repo diff >/dev/null 2>&1 && fail "diff should exit 1 on missing" || true
OUT=$("$BIN" --repo repo diff || true)
echo "$OUT" | grep -q "missing" || fail "diff shows missing"
ok "diff exits 1 and reports missing programs"

"$BIN" --repo repo diff --machines m1 >/dev/null 2>&1 && true
OUT=$("$BIN" --repo repo diff --machines m1 || true)
echo "$OUT" | grep -q "m2" && fail "--machines filter leaked m2" || true
ok "diff --machines filters columns"

# --- sync ---------------------------------------------------------------
git -C repo add -A && git -C repo commit -qm "manifest + state"
git init -q --bare origin.git
git -C repo remote add origin "$WORK/origin.git"
git -C repo push -qu origin HEAD 2>/dev/null

"$BIN" --repo repo --machine m1 sync -m "m1: test sync" >/dev/null || fail "sync exits 0"
git -C origin.git log --oneline | grep -q "m1: test sync" && ok "sync commits and pushes state" || {
    # State may have been unchanged; force a change and retry.
    rm repo/state/m1.json
    "$BIN" --repo repo --machine m1 sync -m "m1: test sync 2" >/dev/null || fail "sync exits 0 (retry)"
    git -C origin.git log --oneline | grep -q "m1: test sync 2" || fail "sync pushed to remote"
    ok "sync commits and pushes state"
}

OUT=$("$BIN" --repo repo --machine m1 sync)
echo "$OUT" | grep -q "nothing to commit" || fail "unchanged sync is a no-op"
ok "sync with unchanged state commits nothing"

# --- error handling -----------------------------------------------------
"$BIN" --repo /nonexistent status >/dev/null 2>&1 && fail "missing manifest should exit 1" || true
OUT=$("$BIN" --repo /nonexistent status 2>&1 || true)
echo "$OUT" | grep -q "error: Manifest not found" || fail "clean manifest error"
ok "missing manifest gives a clean error"

# Membership: a program no machine maps is skipped by converge, errors when
# explicitly requested, and is not observed in state.
cat >> repo/manifest.toml <<'EOF'

[programs.never-mapped]
[programs.never-mapped.install.manual]
command = "false"
EOF
OUT=$("$BIN" --repo repo --machine m1 setup-new-machine --dry-run) || fail "converge with unmapped program should succeed"
echo "$OUT" | grep -q "never-mapped" && fail "converge must skip unmapped programs" || true
"$BIN" --repo repo --machine m1 setup-new-machine never-mapped --dry-run >/dev/null 2>&1 && fail "explicit unmapped should fail" || true
OUT=$("$BIN" --repo repo --machine m1 setup-new-machine never-mapped --dry-run 2>&1 || true)
echo "$OUT" | grep -q "no pm defined for machine 'm1'" || fail "unmapped-program error message"
"$BIN" --repo repo --machine m1 status >/dev/null
grep -q '"never-mapped"' repo/state/m1.json && fail "unmapped program must not be observed" || true
ok "unmapped programs are not part of the machine's loadout"

# Machine without a config file at all.
OUT=$("$BIN" --repo repo --machine ghost setup-new-machine --dry-run 2>&1 || true)
echo "$OUT" | grep -q "machines/ghost.toml" || fail "missing machine-config error message"
ok "setup-new-machine fails for a machine with no config file"

# Mapped pm binary not present on this machine.
mkdir pmrepo pmrepo/state pmrepo/machines
cat > pmrepo/manifest.toml <<'EOF'
[installers.pacman]
probe = "pacman"
install = "sudo pacman -S --noconfirm {pkg}"
check = "pacman -Q {pkg}"
regex = "([0-9.]+)"

[programs.tool]
via = ["pacman"]
EOF
printf '[pm]\ntool = "pacman"\n' > pmrepo/machines/m1.toml
if ! command -v pacman >/dev/null 2>&1; then
    OUT=$("$BIN" --repo pmrepo --machine m1 setup-new-machine --dry-run 2>&1 || true)
    echo "$OUT" | grep -q "required binary 'pacman'" || fail "pm-not-installed error message"
    ok "setup-new-machine fails when the mapped pm is not installed"
else
    ok "skipped pm-not-installed check (pacman present on host)"
fi

# Split layout: manifest.d fragment + machines/<name>.toml config file.
mkdir -p repo/manifest.d repo/machines
cat > repo/manifest.d/extra.toml <<'EOF'
[programs.splitprog]
[programs.splitprog.version]
command = "git --version"
regex = "git version ([0-9.]+)"
[programs.splitprog.install.manual]
command = "false"
EOF
cat > repo/machines/m3.toml <<'EOF'
[pm]
git = "manual"
splitprog = "manual"
definitely-not-installed-xyz = "manual"
EOF
"$BIN" --repo repo --machine m3 status >/dev/null || fail "status with split layout"
grep -q '"splitprog"' repo/state/m3.json || fail "fragment program checked"
"$BIN" --repo repo --machine m3 setup-new-machine --dry-run >/dev/null || fail "machine file mapping used for plan"
ok "manifest.d fragments and machines/*.toml files are merged"

cp repo/manifest.toml repo/manifest.toml.bak
cat >> repo/manifest.toml <<'EOF'

[machines.m9.pm]
git = "manual"
EOF
OUT=$("$BIN" --repo repo --machine m1 status 2>&1 || true)
echo "$OUT" | grep -q "sections are not allowed" || fail "inline machines should be rejected"
mv repo/manifest.toml.bak repo/manifest.toml
rm repo/manifest.d/extra.toml repo/machines/m3.toml
ok "inline [machines.*] sections in the manifest are rejected"

# file: install values — run as repo scripts with repo-root cwd, from anywhere.
mkdir -p filerepo/scripts filerepo/state filerepo/machines
cat > filerepo/manifest.toml <<'EOF'
[programs.filetool]
[programs.filetool.version]
command = "test -f installed-marker.txt && echo filetool 1.0"
regex = "filetool ([0-9.]+)"
[programs.filetool.install.script]
command = "file:scripts/install-filetool.sh install"
EOF
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

# Script file that doesn't exist -> caught at manifest load.
cp repo/manifest.toml repo/manifest.toml.bak
cat >> repo/manifest.toml <<'EOF'

[scripts.ghost-script]
file = "scripts/does-not-exist.sh"
EOF
OUT=$("$BIN" --repo repo status 2>&1 || true)
echo "$OUT" | grep -q "file 'scripts/does-not-exist.sh' not found" || fail "missing script file should error at load"
mv repo/manifest.toml.bak repo/manifest.toml
ok "script file that doesn't exist is caught at manifest load"

# Manifest validation: mapping to a nonexistent install key.
cat > pmrepo/manifest.toml <<'EOF'
[programs.tool]
[programs.tool.install.dnf]
command = "sudo dnf install -y tool"
EOF
printf '[pm]\ntool = "brew"\n' > pmrepo/machines/m1.toml
OUT=$("$BIN" --repo pmrepo status 2>&1 || true)
echo "$OUT" | grep -q "no 'brew' entry" || fail "bad-mapping validation message"
ok "manifest rejects mappings to nonexistent install keys"

# Installers: {pkg} substitution in install + check, probe, via shorthand.
mkdir -p instrepo/state instrepo/machines
cat > instrepo/manifest.toml <<'TOML'
[installers.fake]
probe = "sh"
install = "echo installed-{pkg} > fake-install.txt"
check = "test -f fake-install.txt && echo mytool 1.0"
regex = "mytool ([0-9.]+)"

[programs.mytool]
via = ["fake"]
TOML
printf '[pm]\nmytool = "fake"\n' > instrepo/machines/m1.toml
OUT=$("$BIN" --repo instrepo --machine m1 setup-new-machine --dry-run)
echo "$OUT" | grep -q "echo installed-mytool > fake-install.txt" || fail "installer pattern substitutes {pkg}"
"$BIN" --repo instrepo --machine m1 setup-new-machine --yes >/dev/null || fail "installer-backed install exits 0"
grep -q "installed-mytool" instrepo/fake-install.txt || fail "installer command ran"
grep -q '"version": "1.0"' instrepo/state/m1.json || fail "installer check observed the version"
ok "installers supply install/check/probe mechanics via {pkg}"

# outdated: each installer's oracle reports the remote candidate per program.
cat > instrepo/manifest.toml <<'TOML'
[installers.fake]
probe = "sh"
install = "echo installed-{pkg} > fake-install.txt"
check = "test -f fake-install.txt && echo mytool 1.0"
outdated = "echo 2.0"
regex = "([0-9][0-9.]*)"

[installers.fake2]
probe = "sh"
install = "true"
check = "echo other 1.0"
outdated = "true"
regex = "([0-9][0-9.]*)"

[installers.fake3]
probe = "sh"
install = "true"
check = "echo batchtool 1.0"
outdated-all = "printf 'batchtool 3.0\\nuptodate 1.0\\n'"
regex = "([0-9][0-9.]*)"

[programs.mytool]
via = ["fake"]

[programs.othertool]
via = ["fake2"]

[programs.batchtool]
via = ["fake3"]

[programs.uptodate]
via = ["fake3"]
TOML
printf '[pm]\nmytool = "fake"\nothertool = "fake2"\nbatchtool = "fake3"\nuptodate = "fake3"\n' > instrepo/machines/m1.toml
"$BIN" --repo instrepo --machine m1 status >/dev/null || fail "status before outdated"
OUT=$("$BIN" --repo instrepo --machine m1 outdated) || fail "outdated exits 0"
echo "$OUT" | grep -qE "mytool +1.0 +-> 2.0" || fail "outdated reports the newer candidate"
echo "$OUT" | grep -q "othertool" && fail "up-to-date program must not be listed" || true
echo "$OUT" | grep -qE "batchtool +1.0 +-> 3.0" || fail "batch oracle (outdated-all) reports its candidate"
echo "$OUT" | grep -q "uptodate" && fail "batch-covered up-to-date program must not be listed" || true
ok "outdated uses per-pkg oracles and installer-wide outdated-all batches"

# check: script checks with their detail output, structured.
cat >> instrepo/manifest.toml <<'TOML'

[scripts.healthy]
run = "true"
check = "true"

[scripts.drifted]
run = "true"
check = "echo missing: nodejs 16 npm firebase-tools; false"
TOML
printf 'scripts = ["healthy", "drifted"]\n\n[pm]\nmytool = "fake"\nothertool = "fake2"\n' > instrepo/machines/m1.toml
OUT=$("$BIN" --repo instrepo --machine m1 status) || fail "status exits 0 even with pending scripts"
echo "$OUT" | grep -qE "healthy +done" || fail "status lists passing scripts"
echo "$OUT" | grep -qE "drifted +pending" || fail "status lists failing scripts"
echo "$OUT" | grep -q "missing: nodejs 16 npm firebase-tools" || fail "status surfaces the failing check's detail"
ok "status shows scripts with each failing check's detail"

# maintain (interactive): PTY-drive select-all -> run scripts -> view a log.
# linux-only: macOS `script` has a different syntax; reducers are unit-tested.
"$BIN" --repo instrepo --machine m1 maintain </dev/null >/dev/null 2>&1 && fail "maintain without a TTY should fail" || true
if [ "$(uname)" = "Linux" ] && command -v script >/dev/null; then
    # select all, run, cursor down to the drifted row, open its log viewer, quit
    { sleep 2; printf 'a'; sleep 1; printf '\r'; sleep 3; printf '\033[B'; sleep 1; printf '\r'; sleep 1; printf '\033'; sleep 1; printf 'q'; sleep 1; } \
        | script -qec "\"$BIN\" --repo instrepo --machine m1 maintain" tui-maintain.log >/dev/null \
        && fail "maintain should exit 1 while drifted's check still fails" || true
    grep -qa "loadout maintain" tui-maintain.log || fail "maintain renders its title bar"
    grep -qa "check: still failing" tui-maintain.log || fail "maintain reruns the check after the script and records the verdict"
    grep -q '"drifted"' instrepo/state/m1.json || fail "maintain records the run in the state file"
    grep -q '"status": "pending"' instrepo/state/m1.json || fail "maintain state status comes from the rerun check"
    ok "maintain runs selected scripts in a PTY, exits 1 when a check still fails"
fi

# --- explain ------------------------------------------------------------
OUT=$("$BIN" --repo repo --machine m1 explain git marker)
echo "$OUT" | grep -q "program git" || fail "explain prints the program"
echo "$OUT" | grep -qE "install\.manual +echo install git yourself && false +<- m1" || fail "explain marks this machine's mapped key"
echo "$OUT" | grep -q "script marker" || fail "explain prints the script"
echo "$OUT" | grep -qE "file +scripts/marker.sh" || fail "explain prints the script file"
"$BIN" --repo repo explain ghost-name >/dev/null 2>&1 && fail "explain of unknown name should fail" || true
OUT=$("$BIN" --repo repo --machine m1 explain)
echo "$OUT" | grep -q "program git" && echo "$OUT" | grep -q "script marker" || fail "bare explain covers the whole manifest"
ok "explain prints expanded programs and scripts (all of them with no names)"

# --- versioning ---------------------------------------------------------
mkdir -p verrepo/state
cat > verrepo/manifest.toml <<'EOF'
[meta]
min-tool-version = "999.0.0"

[programs.git]
[programs.git.install.manual]
command = "false"
EOF
OUT=$("$BIN" --repo verrepo status 2>&1 || true)
echo "$OUT" | grep -q "requires loadout >= 999.0.0" || fail "min-tool-version not enforced"
echo "$OUT" | grep -q "install.sh | sh" || fail "refusal should include the upgrade one-liner"
ok "manifest min-tool-version blocks an outdated binary with recovery hint"

cat > verrepo/manifest.toml <<'EOF'
[programs.git]
[programs.git.version]
command = "git --version"
regex = "git version ([0-9.]+)"
[programs.git.install.manual]
command = "false"
EOF
cat > verrepo/state/future.json <<'EOF'
{"schemaVersion": 99, "machine": "future", "os": "linux", "arch": "x86_64",
 "toolVersion": "9.9.9", "updatedAt": "2027-01-01T00:00:00Z"}
EOF
"$BIN" --repo verrepo --machine m1 status >/dev/null || fail "status works despite future state file"
OUT=$("$BIN" --repo verrepo diff 2>&1 || true)
echo "$OUT" | grep -q "newer loadout" || fail "future state file should warn"
echo "$OUT" | grep -q "future" && echo "$OUT" | grep -q '"future"' && fail "future machine must not appear as data" || true
ok "state files from a newer loadout are skipped with a warning"

echo ""
echo "All $PASS integration tests passed."
