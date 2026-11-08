# run: check gate, --force, --all, per-machine opt-in, arguments.

basic_repo repo

"$BIN" --repo repo --machine m1 run marker >/dev/null || fail "run exits 0"
[ -f repo/marker.txt ] || fail "script created marker.txt"
grep -q '"marker"' repo/machines/state/m1.json || fail "script state recorded"
grep -q '"status": "done"' repo/machines/state/m1.json || fail "script marked done"
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
echo "$OUT" | grep -q "is not run on machine 'm2'" || fail "not-enabled error message: $OUT"
"$BIN" --repo repo --machine m2 status >/dev/null
grep -q '"marker"' repo/machines/state/m2.json && fail "m2 must not observe un-opted script" || true
ok "scripts are opt-in per machine"

# Arguments flow to file scripts and their checks as positional params. The
# scripts sit in their file's folder, so they run (and write) there.
mkdir -p repo/maintenance/args repo/maintenance/greet
printf '#!/bin/sh\necho "$1" > arg-marker.txt\n' > repo/maintenance/args/argscript.sh
printf '#!/bin/sh\nprintf "%%s\\n" "$#:$*" > argcount.txt\n' > repo/maintenance/args/argcount.sh
printf 'hello from greet\n' > repo/maintenance/greet/message.txt
printf '#!/bin/sh\ncat message.txt > greeted.txt\nprintf "%%s|%%s|%%s|%%s\\n" "$LOADOUT_REPO" "$LOADOUT_FRAGMENT_DIR" "$LOADOUT_MACHINE" "$LOADOUT_OS" > env.txt\n' > repo/maintenance/greet/greet.sh
hcl_file repo/maintenance/args/args.loadout.hcl <<'HCL'
script "argscript" {
  file  = "argscript.sh"
  check = "test -f arg-marker.txt && grep -qx $1 arg-marker.txt"
}

script "argcount" {
  file = "argcount.sh"
}

machine "m3" {
  install = [variant(program.git, "manual")]
  run = [
    args(script.argscript, "fedora"),
    # A long entry may span lines: its lines are arguments, never commands.
    # If the newline reached the shell, `touch pwned.txt` would run.
    args(script.argcount, "one\ntouch pwned.txt"),
  ]
}

machine "m5" {
  install = [variant(program.git, "manual")]
  run     = [script.greet]
}
HCL
hcl_file repo/maintenance/greet/greet.loadout.hcl <<'HCL'
script "greet" {
  file  = "greet.sh"
  check = "test -f greeted.txt"
}
HCL
compile_repo repo
"$BIN" --repo repo --machine m3 run argscript >/dev/null || fail "run with args exits 0"
grep -qx "fedora" repo/maintenance/args/arg-marker.txt || fail "argument reached the script"
OUT=$("$BIN" --repo repo --machine m3 run argscript)
echo "$OUT" | grep -q "already done" || fail "check with args should pass after run"
ok "script arguments reach the file script and its check"

"$BIN" --repo repo --machine m3 run argcount >/dev/null || fail "run with a multi-line argument exits 0"
grep -qx "3:one touch pwned.txt" repo/maintenance/args/argcount.txt || fail "a multi-line argument's lines arrive as arguments: $(cat repo/maintenance/args/argcount.txt)"
[ -e repo/maintenance/args/pwned.txt ] && fail "a multi-line argument's line must never run as a command" || true
ok "a multi-line script argument passes its lines as arguments"

# A file's paths are relative to its folder, and its commands run there:
# the script reads a sibling file with no $(dirname "$0").
"$BIN" --repo repo --machine m5 run greet >/dev/null || fail "a folder's script runs"
grep -qx "hello from greet" repo/maintenance/greet/greeted.txt || fail "the script ran in its folder"
[ -e repo/greeted.txt ] && fail "nothing lands in the repo root" || true
REPO_ABS=$(cd repo && pwd -P)
grep -qx "$REPO_ABS|$REPO_ABS/maintenance/greet|m5|$(uname -s | sed 's/Darwin/macos/; s/Linux/linux/')" repo/maintenance/greet/env.txt ||
    fail "the script gets LOADOUT_REPO, LOADOUT_FRAGMENT_DIR, LOADOUT_MACHINE, LOADOUT_OS: $(cat repo/maintenance/greet/env.txt)"
OUT=$("$BIN" --repo repo --machine m5 run greet)
echo "$OUT" | grep -q "already done" || fail "the check runs in the folder too"
ok "a file's script and check run in its folder, with the LOADOUT_* variables"

# A script file runs with the interpreter its #! line names, found in the
# folder a program provides it at even when that folder isn't on PATH (bun
# from brew on a fresh Mac); a file without #! runs with sh.
hcl_repo interp
TOOLS=$(pwd -P)/interp-tools
mkdir -p "$TOOLS"
printf '#!/bin/sh\necho "fakeinterp: $*" >> "$LOADOUT_FRAGMENT_DIR/ran.txt"\n[ "$2" != check ] || exit 1\n' > "$TOOLS/loadout-test-interp"
chmod +x "$TOOLS/loadout-test-interp"
hcl_file interp/maintenance/interp.loadout.hcl <<HCL
program "interp" {
  custom {
    command = "false"
    present = "test -x $TOOLS/loadout-test-interp"
    provides "loadout-test-interp" {
      at = "$TOOLS"
    }
  }
}

script "hashbang" {
  managed_by = "hashbang.ts"
}

script "plain" {
  file = "plain.sh"
}
HCL
printf '#!/usr/bin/env loadout-test-interp\nignored by sh\n' > interp/maintenance/hashbang.ts
printf 'echo "sh: $0" > "$LOADOUT_FRAGMENT_DIR/plain-ran.txt"\n' > interp/maintenance/plain.sh
hcl_file interp/machines/machines.loadout.hcl <<'HCL'
machine "m1" {
  install = [program.interp]
  run     = [script.hashbang, script.plain]
}
HCL
compile_repo interp
command -v loadout-test-interp >/dev/null 2>&1 && fail "the interpreter must not be on PATH for this test" || true
"$BIN" --repo interp --machine m1 run hashbang >/dev/null || fail "a #! script runs: $("$BIN" --repo interp --machine m1 run hashbang 2>&1)"
grep -qx "fakeinterp: hashbang.ts" interp/maintenance/ran.txt || fail "the #! interpreter ran the script: $(cat interp/maintenance/ran.txt 2>/dev/null)"
"$BIN" --repo interp --machine m1 status --no-write >/dev/null 2>&1
grep -qx "fakeinterp: hashbang.ts check" interp/maintenance/ran.txt || fail "its check runs with the interpreter too: $(cat interp/maintenance/ran.txt)"
"$BIN" --repo interp --machine m1 run plain >/dev/null || fail "a script without #! runs"
grep -qx "sh: plain.sh" interp/maintenance/plain-ran.txt || fail "a script without #! runs with sh: $(cat interp/maintenance/plain-ran.txt 2>/dev/null)"
OUT=$("$BIN" --repo interp --machine m1 setup-new-machine --dry-run 2>&1)
echo "$OUT" | grep -q "head -n 1" && fail "the plan shows the script, not how it's launched: $OUT" || true
ok "a script file runs with its #! interpreter, found where a program provides it; without #!, with sh"
