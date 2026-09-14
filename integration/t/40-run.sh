# run: check gate, --force, --all, per-machine opt-in, arguments.

basic_repo repo

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

OUT=$("$BIN" --repo repo --machine m1 run --all --force)
echo "$OUT" | grep -q "ran marker" || fail "run --all runs every opted-in script"
"$BIN" --repo repo --machine m1 run --all marker >/dev/null 2>&1 && fail "--all with names should fail" || true
"$BIN" --repo repo --machine m1 run >/dev/null 2>&1 && fail "run with no names and no --all should fail" || true
OUT=$("$BIN" --repo repo --machine m2 run --all)
echo "$OUT" | grep -q "No scripts opted in" || fail "run --all on a machine with no scripts says so"
ok "run --all covers this machine's opted-in scripts, and rejects names alongside it"

# m2 never opted into the marker script.
"$BIN" --repo repo --machine m2 run marker >/dev/null 2>&1 && fail "run without opt-in should fail" || true
OUT=$("$BIN" --repo repo --machine m2 run marker 2>&1 || true)
echo "$OUT" | grep -q "not enabled for machine 'm2'" || fail "not-enabled error message"
"$BIN" --repo repo --machine m2 status >/dev/null
grep -q '"marker"' repo/state/m2.json && fail "m2 must not observe un-opted script" || true
ok "scripts are opt-in per machine"

# Arguments flow to file scripts and their checks as positional params.
printf '#!/bin/sh\necho "$1" > arg-marker.txt\n' > repo/scripts/argscript.sh
cat >> repo/manifest.toml <<'TOML'

[scripts.argscript]
file = "scripts/argscript.sh"
check = "test -f arg-marker.txt && grep -qx $1 arg-marker.txt"
TOML
printf 'scripts = ["argscript fedora"]\n\n[pm]\ngit = "manual"\n' > repo/machines/m2.toml
"$BIN" --repo repo --machine m2 run argscript >/dev/null || fail "run with args exits 0"
grep -qx "fedora" repo/arg-marker.txt || fail "argument reached the script"
OUT=$("$BIN" --repo repo --machine m2 run argscript)
echo "$OUT" | grep -q "already done" || fail "check with args should pass after run"
ok "script arguments reach the file script and its check"
