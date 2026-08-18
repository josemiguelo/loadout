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
[programs.git.install]
dnf = "sudo dnf install -y git"
apt = "sudo apt-get install -y git"
brew = "brew install git"
manual = "echo install git yourself && false"

[scripts.marker]
file = "scripts/marker.sh"
check = "test -f marker.txt"
EOF
printf '[pm]\ngit = "manual"\n' > repo/machines/m1.toml
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
OUT=$("$BIN" --repo repo --machine m1 install --dry-run)
echo "$OUT" | grep -q "git" || fail "dry-run mentions git"
echo "$OUT" | grep -q "script marker" || fail "dry-run lists the script"
[ ! -f repo/marker.txt ] || fail "dry-run must not execute scripts"
ok "install --dry-run plans without executing"

"$BIN" --repo repo --machine m1 install --yes --skip-scripts >/dev/null || fail "install (all installed) exits 0"
ok "install with everything installed is a no-op"

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

# --- install runs eligible scripts --------------------------------------
rm repo/marker.txt
"$BIN" --repo repo --machine m1 install --yes >/dev/null || fail "install with script exits 0"
[ -f repo/marker.txt ] || fail "install ran the script"
ok "install runs eligible scripts"

# --- diff ---------------------------------------------------------------
"$BIN" --repo repo --machine m2 status >/dev/null
"$BIN" --repo repo diff >/dev/null || fail "diff exits 0 when in sync"
ok "diff exits 0 when machines agree"

cat >> repo/manifest.toml <<'EOF'

[programs.definitely-not-installed-xyz]
[programs.definitely-not-installed-xyz.version]
command = "definitely-not-installed-xyz --version"
regex = "([0-9.]+)"
[programs.definitely-not-installed-xyz.install]
manual = "false"
EOF
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

# Unmapped program: definitely-not-installed-xyz is not in machines.m1.pm.
"$BIN" --repo repo --machine m1 install --dry-run >/dev/null 2>&1 && fail "unmapped program should fail" || true
OUT=$("$BIN" --repo repo --machine m1 install --dry-run 2>&1 || true)
echo "$OUT" | grep -q "no pm defined for machine 'm1'" || fail "unmapped-program error message"
ok "install fails when a program has no pm mapped for the machine"

# Machine without a config file at all.
OUT=$("$BIN" --repo repo --machine ghost install --dry-run 2>&1 || true)
echo "$OUT" | grep -q "machines/ghost.toml" || fail "missing machine-config error message"
ok "install fails for a machine with no config file"

# Mapped pm binary not present on this machine.
mkdir pmrepo pmrepo/state pmrepo/machines
cat > pmrepo/manifest.toml <<'EOF'
[programs.tool]
[programs.tool.version]
command = "tool --version"
regex = "([0-9.]+)"
[programs.tool.install]
pacman = "sudo pacman -S --noconfirm tool"
EOF
printf '[pm]\ntool = "pacman"\n' > pmrepo/machines/m1.toml
if ! command -v pacman >/dev/null 2>&1; then
    OUT=$("$BIN" --repo pmrepo --machine m1 install --dry-run 2>&1 || true)
    echo "$OUT" | grep -q "package manager 'pacman'" || fail "pm-not-installed error message"
    ok "install fails when the mapped pm is not installed"
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
[programs.splitprog.install]
manual = "false"
EOF
cat > repo/machines/m3.toml <<'EOF'
[pm]
git = "manual"
splitprog = "manual"
definitely-not-installed-xyz = "manual"
EOF
"$BIN" --repo repo --machine m3 status >/dev/null || fail "status with split layout"
grep -q '"splitprog"' repo/state/m3.json || fail "fragment program checked"
"$BIN" --repo repo --machine m3 install --dry-run >/dev/null || fail "machine file mapping used for plan"
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
[programs.filetool.install]
script = "file:scripts/install-filetool.sh"
EOF
# Writes relative to cwd — proves installs run from the repo root.
printf '#!/bin/sh\necho done > installed-marker.txt\n' > filerepo/scripts/install-filetool.sh
printf '[pm]\nfiletool = "script"\n' > filerepo/machines/m1.toml

OUT=$("$BIN" --repo filerepo --machine m1 install --dry-run)
echo "$OUT" | grep -q "sh 'scripts/install-filetool.sh'" || fail "file: value translated in plan"
"$BIN" --repo filerepo --machine m1 install --yes >/dev/null || fail "file: install exits 0"
[ -f filerepo/installed-marker.txt ] || fail "install ran with repo-root cwd"
ok "file: install values run repo scripts from the repo root"

rm filerepo/scripts/install-filetool.sh
OUT=$("$BIN" --repo filerepo --machine m1 status 2>&1 || true)
echo "$OUT" | grep -q "file 'scripts/install-filetool.sh' not found" || fail "missing file: script should error at load"
ok "missing file: install script is caught at manifest load"

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
[programs.tool.install]
dnf = "sudo dnf install -y tool"
EOF
printf '[pm]\ntool = "brew"\n' > pmrepo/machines/m1.toml
OUT=$("$BIN" --repo pmrepo status 2>&1 || true)
echo "$OUT" | grep -q "no 'brew' entry" || fail "bad-mapping validation message"
ok "manifest rejects mappings to nonexistent install keys"

# --- versioning ---------------------------------------------------------
mkdir -p verrepo/state
cat > verrepo/manifest.toml <<'EOF'
[meta]
min-tool-version = "999.0.0"

[programs.git]
[programs.git.install]
manual = "false"
EOF
OUT=$("$BIN" --repo verrepo status 2>&1 || true)
echo "$OUT" | grep -q "requires loadout >= 999.0.0" || fail "min-tool-version not enforced"
ok "manifest min-tool-version blocks an outdated binary"

cat > verrepo/manifest.toml <<'EOF'
[programs.git]
[programs.git.version]
command = "git --version"
regex = "git version ([0-9.]+)"
[programs.git.install]
manual = "false"
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
