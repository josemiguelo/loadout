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
cat >> repo/loadout.toml <<'TOML'

[scripts.argscript]
file = "scripts/argscript.sh"
check = "test -f arg-marker.txt && grep -qx $1 arg-marker.txt"
TOML
printf '[setup]\nscripts = ["argscript fedora"]\n\n[packages.install]\ngit = "manual"\n' > repo/machines/m2.toml
"$BIN" --repo repo --machine m2 run argscript >/dev/null || fail "run with args exits 0"
grep -qx "fedora" repo/arg-marker.txt || fail "argument reached the script"
OUT=$("$BIN" --repo repo --machine m2 run argscript)
echo "$OUT" | grep -q "already done" || fail "check with args should pass after run"
ok "script arguments reach the file script and its check"

# A long opt-in can be a TOML multi-line string: its lines are arguments,
# never commands. If the newline reached the shell, `touch pwned.txt` would run.
printf '#!/bin/sh\nprintf "%%s\\n" "$#:$*" > argcount.txt\n' > repo/scripts/argcount.sh
cat >> repo/loadout.toml <<'TOML'

[scripts.argcount]
file = "scripts/argcount.sh"
TOML
printf "[setup]\nscripts = ['''argcount one\n  touch pwned.txt''']\n\n[packages.install]\ngit = \"manual\"\n" > repo/machines/m3.toml
"$BIN" --repo repo --machine m3 run argcount >/dev/null || fail "run with a multi-line entry exits 0"
grep -qx "3:one touch pwned.txt" repo/argcount.txt || fail "a multi-line entry's lines arrive as arguments"
[ -e repo/pwned.txt ] && fail "a multi-line entry's line must never run as a command" || true
# The name alone on the first line works too.
printf "[setup]\nscripts = ['''argcount\n  a\n  b''']\n\n[packages.install]\ngit = \"manual\"\n" > repo/machines/m4.toml
"$BIN" --repo repo --machine m4 run argcount >/dev/null || fail "a name alone on the first line is still the name"
grep -qx "2:a b" repo/argcount.txt || fail "the lines after a lone name are its arguments"
ok "a multi-line script entry passes its lines as arguments"

# A fragment's paths are relative to its own folder, and its commands run
# there: the script reads a sibling file with no $(dirname "$0").
mkdir -p repo/maintenance/greet
printf 'hello from greet\n' > repo/maintenance/greet/message.txt
printf '#!/bin/sh\ncat message.txt > greeted.txt\nprintf "%%s|%%s|%%s|%%s\\n" "$LOADOUT_REPO" "$LOADOUT_FRAGMENT_DIR" "$LOADOUT_MACHINE" "$LOADOUT_OS" > env.txt\n' > repo/maintenance/greet/greet.sh
cat > repo/maintenance/greet/greet.toml <<'TOML'
[scripts.greet]
file = "greet.sh"
check = "test -f greeted.txt"
TOML
printf '[setup]\nscripts = ["greet"]\n\n[packages.install]\ngit = "manual"\n' > repo/machines/m5.toml
"$BIN" --repo repo --machine m5 run greet >/dev/null || fail "a fragment's script runs"
grep -qx "hello from greet" repo/maintenance/greet/greeted.txt || fail "the script ran in its fragment's folder"
[ -e repo/greeted.txt ] && fail "nothing lands in the repo root" || true
REPO_ABS=$(cd repo && pwd -P)
grep -qx "$REPO_ABS|$REPO_ABS/maintenance/greet|m5|$(uname -s | sed 's/Darwin/macos/; s/Linux/linux/')" repo/maintenance/greet/env.txt ||
    fail "the script gets LOADOUT_REPO, LOADOUT_FRAGMENT_DIR, LOADOUT_MACHINE, LOADOUT_OS: $(cat repo/maintenance/greet/env.txt)"
OUT=$("$BIN" --repo repo --machine m5 run greet)
echo "$OUT" | grep -q "already done" || fail "the check runs in the fragment's folder too"
ok "a fragment's script and check run in its folder, with the LOADOUT_* variables"
