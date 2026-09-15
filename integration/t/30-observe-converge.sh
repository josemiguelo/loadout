# status observes; setup-new-machine / install converge; explain resolves.

basic_repo repo

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

# --- setup-new-machine (dry run + already installed) ----------------------
OUT=$("$BIN" --repo repo --machine m1 setup-new-machine --dry-run)
echo "$OUT" | grep -q "git" || fail "dry-run mentions git"
echo "$OUT" | grep -qE "~ marker +script" || fail "dry-run lists the script"
[ ! -f repo/marker.txt ] || fail "dry-run must not execute scripts"
ok "setup-new-machine --dry-run plans without executing"

"$BIN" --repo repo --machine m1 setup-new-machine --yes --skip-scripts >/dev/null || fail "install (all installed) exits 0"
ok "setup-new-machine with everything installed is a no-op"

# --- install (targeted programs; scripts are run's job) ------------------
OUT=$("$BIN" --repo repo --machine m1 install git --dry-run) || fail "install with names exits 0"
echo "$OUT" | grep -q "git" || fail "install plans the named program"
echo "$OUT" | grep -q "marker" && fail "install must not touch scripts" || true
"$BIN" --repo repo --machine m1 install ghost-prog --dry-run >/dev/null 2>&1 && fail "unknown program should fail" || true
"$BIN" --repo repo --machine m1 setup-new-machine git --dry-run >/dev/null 2>&1 && fail "setup-new-machine must not accept names" || true
ok "install targets named programs; setup-new-machine takes no names"

OUT=$("$BIN" --repo repo --machine m1 install --all --dry-run) || fail "install --all exits 0"
echo "$OUT" | grep -q "git" || fail "install --all plans every mapped program"
echo "$OUT" | grep -q "marker" && fail "install --all must not touch scripts" || true
"$BIN" --repo repo --machine m1 install --all git --dry-run >/dev/null 2>&1 && fail "--all with names should fail" || true
"$BIN" --repo repo --machine m1 install --dry-run >/dev/null 2>&1 && fail "install with no names and no --all should fail" || true
ok "install --all covers this machine's mapped programs, and rejects names alongside it"

# --- setup-new-machine runs eligible scripts -----------------------------
"$BIN" --repo repo --machine m1 setup-new-machine --yes >/dev/null || fail "install with script exits 0"
[ -f repo/marker.txt ] || fail "install ran the script"
ok "setup-new-machine runs eligible scripts"

# --- membership: a program no machine maps ------------------------------
# Skipped by converge, an error when explicitly requested, not observed.
cat >> repo/manifest.toml <<'TOML'

[programs.never-mapped]
[programs.never-mapped.install.manual]
command = "false"
TOML
OUT=$("$BIN" --repo repo --machine m1 setup-new-machine --dry-run) || fail "converge with unmapped program should succeed"
echo "$OUT" | grep -q "never-mapped" && fail "converge must skip unmapped programs" || true
"$BIN" --repo repo --machine m1 install never-mapped --dry-run >/dev/null 2>&1 && fail "explicit unmapped should fail" || true
OUT=$("$BIN" --repo repo --machine m1 install never-mapped --dry-run 2>&1 || true)
echo "$OUT" | grep -q "no pm defined for machine 'm1'" || fail "unmapped-program error message"
"$BIN" --repo repo --machine m1 status >/dev/null
grep -q '"never-mapped"' repo/state/m1.json && fail "unmapped program must not be observed" || true
ok "unmapped programs are not part of the machine's loadout"

# --- machine without a config file at all --------------------------------
OUT=$("$BIN" --repo repo --machine ghost setup-new-machine --dry-run 2>&1 || true)
echo "$OUT" | grep -q "machines/ghost.toml" || fail "missing machine-config error message"
ok "setup-new-machine fails for a machine with no config file"

# --- mapped pm binary not present on this machine ------------------------
mkdir -p pmrepo/state pmrepo/machines
cat > pmrepo/manifest.toml <<'TOML'
[installers.pacman]
probe = "pacman"
install = "sudo pacman -S --noconfirm {pkg}"
check = "pacman -Q {pkg}"
regex = "([0-9.]+)"

[programs.tool]
via = ["pacman"]
TOML
printf '[pm]\ntool = "pacman"\n' > pmrepo/machines/m1.toml
if ! command -v pacman >/dev/null 2>&1; then
    OUT=$("$BIN" --repo pmrepo --machine m1 setup-new-machine --dry-run 2>&1 || true)
    echo "$OUT" | grep -q "required binary 'pacman'" || fail "pm-not-installed error message"
    ok "setup-new-machine fails when the mapped pm is not installed"
else
    ok "skipped pm-not-installed check (pacman present on host)"
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

# --- a check whose TOOL is absent is "not checked", never "missing" ------
# brew off PATH once reported every brew program missing. A check through
# a mechanism (its installer has a probe) that dies with the shell's own
# "command not found" is a question that couldn't be asked; a check that IS
# the program (`rg --version`, no probe) means what it says.
mkdir -p probed/state probed/machines
cat > probed/manifest.toml <<'TOML'
[installers.ghostpm]
probe = "ghostpm-definitely-not-here"
install = "ghostpm-definitely-not-here install {pkg}"
check = "ghostpm-definitely-not-here query {pkg}"
regex = "([0-9.]+)"

[programs.viapm]
via = ["ghostpm"]

[programs.byitself]
[programs.byitself.version]
command = "byitself-definitely-not-here --version"
regex = "([0-9.]+)"
[programs.byitself.install.manual]
command = "false"
TOML
printf '[pm]\nviapm = "ghostpm"\nbyitself = "manual"\n' > probed/machines/m1.toml
OUT=$("$BIN" --repo probed --machine m1 status) || fail "status exits 0 with an unrunnable check"
echo "$OUT" | grep -qE "viapm +not checked" || fail "a check whose tool is absent is 'not checked'"
echo "$OUT" | grep -q "ghostpm-definitely-not-here: command not found" || fail "status says what wasn't there"
echo "$OUT" | grep -qE "byitself +missing" || fail "a program's own check not found means missing"
grep -q '"reason"' probed/state/m1.json || fail "the reason is recorded in state"
echo "$OUT" | grep -q "ghostpm-definitely-not-here is not on PATH — 1 program(s) not checked" || fail "status says, once and in words, which tool was missing"
ok "a check whose tool is absent is 'not checked' with the reason, not 'missing'"
