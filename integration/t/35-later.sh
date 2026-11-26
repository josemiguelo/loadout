# `later = "…"`: machine new's later phase, after every core program
# and script; --skip-later stops before it; compile refuses a core step that
# waits on a later one.

# Every step appends its name to order.log in the repo root and leaves a
# .done file its check looks for.
later_repo() {
    ts_root "$1" <<'TS'
const coreProg = program("core-prog", {
  canBeInstalled: [
    withCustomSteps("manual", {
      installCommand: "echo core-prog >> order.log && touch core-prog.done",
      isInstalled: "test -f core-prog.done",
    }),
  ],
});

const laterProg = program("later-prog", {
  canWait: "a big download",
  canBeInstalled: [
    withCustomSteps("manual", {
      installCommand: "echo later-prog >> order.log && touch later-prog.done",
      isInstalled: "test -f later-prog.done",
    }),
  ],
});

const coreScript = script("core-script", {
  runCommand: "echo core-script >> order.log && touch core-script.done",
  checkCommand: "test -f core-script.done",
});

const laterScript = script("later-script", {
  canWait: "gigabytes of models",
  runCommand: "echo later-script >> order.log && touch later-script.done",
  checkCommand: "test -f later-script.done",
  runAfter: [coreScript],
});

machine("m1", {
  install: [coreProg, laterProg],
  run: [coreScript, laterScript],
});
TS
    compile_repo "$1"
}

later_repo repo

# --- the plan --------------------------------------------------------------
OUT=$("$BIN" --repo repo --machine m1 machine new --dry-run)
core_at=$(echo "$OUT" | grep -n "core-script" | cut -d: -f1)
title_at=$(echo "$OUT" | grep -n "Later, after everything above:" | cut -d: -f1)
later_at=$(echo "$OUT" | grep -n "later-prog" | cut -d: -f1)
[ -n "$title_at" ] || { echo "$OUT"; fail "the plan has a later section"; }
[ "$core_at" -lt "$title_at" ] && [ "$title_at" -lt "$later_at" ] || { echo "$OUT"; fail "core rows, then the later heading, then later rows"; }
[ ! -f repo/order.log ] || fail "dry-run must not execute"
ok "machine new --dry-run shows what's later under its own heading"

# --- --skip-later ----------------------------------------------------------
OUT=$("$BIN" --repo repo --machine m1 machine new --yes --skip-later 2>&1) || { echo "$OUT"; fail "--skip-later exits 0"; }
echo "$OUT" | grep -q "Later, skipped (--skip-later):" || { echo "$OUT"; fail "the plan says what it skips"; }
[ "$(cat repo/order.log)" = "core-prog
core-script" ] || { cat repo/order.log; fail "only the core steps ran"; }
ok "machine new --skip-later runs the core phase only"

# --- both phases, in order -------------------------------------------------
rm -f repo/order.log repo/*.done
OUT=$("$BIN" --repo repo --machine m1 machine new --yes 2>&1) || { echo "$OUT"; fail "setup exits 0"; }
[ "$(cat repo/order.log)" = "core-prog
core-script
later-prog
later-script" ] || { cat repo/order.log; fail "core programs, core scripts, later programs, later scripts"; }
echo "$OUT" | grep -q "==> later: what can wait" || { echo "$OUT"; fail "the later phase is announced"; }
ok "machine new runs the later phase after every core step"

# Run again after a stop: only what's left, the core already done.
rm -f repo/order.log repo/later-script.done
"$BIN" --repo repo --machine m1 machine new --yes >/dev/null 2>&1 || fail "the rerun exits 0"
[ "$(cat repo/order.log)" = "later-script" ] || { cat repo/order.log; fail "only the unfinished later step runs"; }
ok "running setup again finishes what the later phase left"

# --- a later program whose core dependency failed is skipped ---------------
ts_root dep <<'TS'
const base = program("base", {
  canBeInstalled: [withCustomSteps("manual", { installCommand: "false", isInstalled: "test -f base.done" })],
});

const big = program("big", {
  canWait: "large",
  dependsOn: [base],
  canBeInstalled: [withCustomSteps("manual", { installCommand: "touch big.done", isInstalled: "test -f big.done" })],
});

machine("m1", { install: [base, big] });
TS
compile_repo dep
OUT=$("$BIN" --repo dep --machine m1 machine new --yes 2>&1) && { echo "$OUT"; fail "a failed install exits 1"; }
echo "$OUT" | grep -q "skipping big" || { echo "$OUT"; fail "the later phase skips what the core phase failed"; }
[ ! -f dep/big.done ] || fail "big must not install"
ok "a later install whose dependency failed in the core phase is skipped"

# --- explain and compile -----------------------------------------------------
"$BIN" --repo repo --machine m1 program explain later-prog | grep -q "canWait .*a big download" || fail "explain shows a program's canWait"
"$BIN" --repo repo --machine m1 script explain later-script | grep -q "canWait .*gigabytes of models" || fail "explain shows a script's canWait"
ok "explain shows why a step is later"

ts_root bad <<'TS'
const slow = program("slow", {
  canWait: "slow",
  canBeInstalled: [withCustomSteps("manual", { installCommand: "true", isInstalled: "true" })],
});

const eager = script("eager", { runCommand: "true", runAfter: [slow] });

machine("m1", { install: [slow], run: [eager] });
TS
OUT=$("$BIN" --repo bad repo compile 2>&1) && fail "compile refuses a core step after a later one"
echo "$OUT" | grep -q "script 'eager' runs after program 'slow', which is later" || { echo "$OUT"; fail "compile names the step and the fix"; }
[ ! -f bad/loadout.lock.json ] || fail "nothing is written when compile refuses"
ok "compile refuses a core script that runs after a later program"
