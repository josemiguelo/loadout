# run: check gate, --force, --all, per-machine opt-in, arguments.

basic_repo repo

"$BIN" --repo repo --machine m1 script run marker >/dev/null || fail "run exits 0"
[ -f repo/marker.txt ] || fail "script created marker.txt"
grep -q '"marker"' repo/machines/state/m1.json || fail "script state recorded"
grep -q '"status": "done"' repo/machines/state/m1.json || fail "script marked done"
ok "run executes a script and records state"

OUT=$("$BIN" --repo repo --machine m1 script run marker)
echo "$OUT" | grep -q "already done" || fail "check gate skips a done script"
ok "run respects the check gate"

OUT=$("$BIN" --repo repo --machine m1 script run marker --force)
echo "$OUT" | grep -q "ran marker" || fail "--force reruns"
ok "run --force ignores the check gate"

OUT=$("$BIN" --repo repo --machine m1 script run --all --force)
echo "$OUT" | grep -q "ran marker" || fail "run --all runs every opted-in script"
"$BIN" --repo repo --machine m1 script run --all marker >/dev/null 2>&1 && fail "--all with names should fail" || true
"$BIN" --repo repo --machine m1 script run >/dev/null 2>&1 && fail "run with no names and no --all should fail" || true
OUT=$("$BIN" --repo repo --machine m2 script run --all)
echo "$OUT" | grep -q "No scripts opted in" || fail "run --all on a machine with no scripts says so"
ok "run --all covers this machine's opted-in scripts, and rejects names alongside it"

# m2 never opted into the marker script.
"$BIN" --repo repo --machine m2 script run marker >/dev/null 2>&1 && fail "run without opt-in should fail" || true
OUT=$("$BIN" --repo repo --machine m2 script run marker 2>&1 || true)
echo "$OUT" | grep -q "is not run on machine 'm2'" || fail "not-enabled error message: $OUT"
"$BIN" --repo repo --machine m2 machine status >/dev/null
grep -q '"marker"' repo/machines/state/m2.json && fail "m2 must not observe un-opted script" || true
ok "scripts are opt-in per machine"

# A script file and its check run as declared. The
# scripts sit in their file's folder, so they run (and write) there.
mkdir -p repo/maintenance/args repo/maintenance/greet
printf '#!/bin/sh\nprintf "%%s|" "$@" > arg-marker.txt\n' > repo/maintenance/args/argscript.sh
printf 'hello from greet\n' > repo/maintenance/greet/message.txt
printf '#!/bin/sh\ncat message.txt > greeted.txt\nprintf "%%s|%%s|%%s|%%s\\n" "$LOADOUT_REPO" "$LOADOUT_FRAGMENT_DIR" "$LOADOUT_MACHINE" "$LOADOUT_OS" > env.txt\n' > repo/maintenance/greet/greet.sh
ts_file repo/maintenance/args/args.loadout.ts <<'TS'
import { git } from "../../root.loadout.ts";
import { greet } from "../greet/greet.loadout.ts";

const argscript = script("argscript", {
  runCommand: runFile("argscript.sh", "a  b", "it's", "$(touch pwned)"),
  checkCommand: "test -f arg-marker.txt",
});


machine("m3", {
  install: [git("manual")],
  run: [
    argscript,
  ],
});

machine("m5", {
  install: [git("manual")],
  run: [greet],
});
TS
ts_file repo/maintenance/greet/greet.loadout.ts <<'TS'
export const greet = script("greet", {
  runCommand: runFile("greet.sh"),
  checkCommand: "test -f greeted.txt",
});
TS
compile_repo repo
"$BIN" --repo repo --machine m3 script run argscript >/dev/null || fail "run exits 0"
[ "$(cat repo/maintenance/args/arg-marker.txt)" = "a  b|it's|\$(touch pwned)|" ] || fail "each argument arrives as one word: $(cat repo/maintenance/args/arg-marker.txt)"
[ -e repo/maintenance/args/pwned ] && fail "an argument must never run as a command" || true
OUT=$("$BIN" --repo repo --machine m3 script run argscript)
echo "$OUT" | grep -q "already done" || fail "its check should pass after run"
ok "runFile() runs a file with its arguments as written, gated by its check"

# A file's paths are relative to its folder, and its commands run there:
# the script reads a sibling file with no $(dirname "$0").
"$BIN" --repo repo --machine m5 script run greet >/dev/null || fail "a folder's script runs"
grep -qx "hello from greet" repo/maintenance/greet/greeted.txt || fail "the script ran in its folder"
[ -e repo/greeted.txt ] && fail "nothing lands in the repo root" || true
REPO_ABS=$(cd repo && pwd -P)
grep -qx "$REPO_ABS|$REPO_ABS/maintenance/greet|m5|$(uname -s | sed 's/Darwin/macos/; s/Linux/linux/')" repo/maintenance/greet/env.txt ||
    fail "the script gets LOADOUT_REPO, LOADOUT_FRAGMENT_DIR, LOADOUT_MACHINE, LOADOUT_OS: $(cat repo/maintenance/greet/env.txt)"
OUT=$("$BIN" --repo repo --machine m5 script run greet)
echo "$OUT" | grep -q "already done" || fail "the check runs in the folder too"
ok "a file's script and check run in its folder, with the LOADOUT_* variables"

# A script file runs with the interpreter its #! line names, found in the
# folder a program provides it at even when that folder isn't on PATH (bun
# from brew on a fresh Mac); a file without #! runs with sh.
ts_repo interp
TOOLS=$(pwd -P)/interp-tools
mkdir -p "$TOOLS"
printf '#!/bin/sh\necho "fakeinterp: $*" >> "$LOADOUT_FRAGMENT_DIR/ran.txt"\n[ "$2" != check ] || exit 1\n' > "$TOOLS/loadout-test-interp"
chmod +x "$TOOLS/loadout-test-interp"
ts_file interp/maintenance/interp.loadout.ts <<TS
export const interp = program("interp", {
  canBeInstalled: [
    withCustomSteps({
      installCommand: "false",
      isInstalled: "test -x $TOOLS/loadout-test-interp",
      addsToPath: { "loadout-test-interp": "$TOOLS" },
    }),
  ],
});

export const hashbang = script("hashbang", { runCommand: runFile("hashbang.ts"), checkCommand: runFile("hashbang.ts", "check") });

export const plain = script("plain", { runCommand: runFile("plain.sh") });
TS
printf '#!/usr/bin/env loadout-test-interp\nignored by sh\n' > interp/maintenance/hashbang.ts
printf 'echo "sh: $0" > "$LOADOUT_FRAGMENT_DIR/plain-ran.txt"\n' > interp/maintenance/plain.sh
ts_file interp/machines/machines.loadout.ts <<'TS'
import { hashbang, interp, plain } from "../maintenance/interp.loadout.ts";

machine("m1", { install: [interp], run: [hashbang, plain] });
TS
compile_repo interp
command -v loadout-test-interp >/dev/null 2>&1 && fail "the interpreter must not be on PATH for this test" || true
"$BIN" --repo interp --machine m1 script run hashbang >/dev/null || fail "a #! script runs: $("$BIN" --repo interp --machine m1 script run hashbang 2>&1)"
grep -qx "fakeinterp: hashbang.ts" interp/maintenance/ran.txt || fail "the #! interpreter ran the script: $(cat interp/maintenance/ran.txt 2>/dev/null)"
"$BIN" --repo interp --machine m1 machine status --no-write >/dev/null 2>&1
grep -qx "fakeinterp: hashbang.ts check" interp/maintenance/ran.txt || fail "its check runs with the interpreter too: $(cat interp/maintenance/ran.txt)"
"$BIN" --repo interp --machine m1 script run plain >/dev/null || fail "a script without #! runs"
grep -qx "sh: plain.sh" interp/maintenance/plain-ran.txt || fail "a script without #! runs with sh: $(cat interp/maintenance/plain-ran.txt 2>/dev/null)"
OUT=$("$BIN" --repo interp --machine m1 machine new --dry-run 2>&1)
echo "$OUT" | grep -q "head -n 1" && fail "the plan shows the script, not how it's launched: $OUT" || true
ok "a script file runs with its #! interpreter, found where a program provides it; without #!, with sh"

# --- loadout 6.0's names ----------------------------------------------------------
OUT=$("$BIN" --repo repo --machine m1 run-script marker --force 2>&1) || fail "run-script still runs: $OUT"
echo "$OUT" | grep -q "loadout run-script is now loadout script run" || fail "run-script says what to run now: $OUT"
echo "$OUT" | grep -q "marker" || fail "and runs the script: $OUT"
OUT=$("$BIN" --repo repo --machine m1 setup-new-machine --dry-run 2>&1) || fail "setup-new-machine still plans: $OUT"
echo "$OUT" | grep -q "loadout setup-new-machine is now loadout machine new" || fail "setup-new-machine says what to run now: $OUT"
OUT=$("$BIN" --repo repo --machine m1 status --no-write 2>&1) || fail "status still observes: $OUT"
echo "$OUT" | grep -q "loadout status is now loadout machine status" || fail "status says what to run now: $OUT"
ok "loadout 6.0's command names still work, each saying what to run now"

OUT=$("$BIN" --repo repo script 2>&1) || fail "a bare group shows its help: $OUT"
echo "$OUT" | grep -q "Usage: loadout script" && echo "$OUT" | grep -qE '^  run ' && echo "$OUT" | grep -qE '^  check ' || fail "loadout script lists its verbs: $OUT"
OUT=$("$BIN" --repo repo script nope 2>&1) && fail "an unknown verb is refused"
echo "$OUT" | grep -q "no such subcommand nope" || fail "and named: $OUT"
ok "loadout script lists its verbs, and refuses one it doesn't have"
