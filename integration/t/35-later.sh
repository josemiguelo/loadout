# `later = "…"`: setup-new-machine's later phase, after every core program
# and script; --skip-later stops before it; compile refuses a core step that
# waits on a later one.

# Every step appends its name to order.log in the repo root and leaves a
# .done file its check looks for.
later_repo() {
    hcl_root "$1" <<'HCL'
program "core-prog" {
  custom "manual" {
    command = "echo core-prog >> order.log && touch core-prog.done"
    present = "test -f core-prog.done"
  }
}

program "later-prog" {
  later = "a big download"
  custom "manual" {
    command = "echo later-prog >> order.log && touch later-prog.done"
    present = "test -f later-prog.done"
  }
}

script "core-script" {
  run   = "echo core-script >> order.log && touch core-script.done"
  check = "test -f core-script.done"
}

script "later-script" {
  later     = "gigabytes of models"
  run       = "echo later-script >> order.log && touch later-script.done"
  check     = "test -f later-script.done"
  run_after = [script.core-script]
}

machine "m1" {
  install = [program.core-prog, program.later-prog]
  run     = [script.core-script, script.later-script]
}
HCL
    compile_repo "$1"
}

later_repo repo

# --- the plan --------------------------------------------------------------
OUT=$("$BIN" --repo repo --machine m1 setup-new-machine --dry-run)
core_at=$(echo "$OUT" | grep -n "core-script" | cut -d: -f1)
title_at=$(echo "$OUT" | grep -n "Later, after everything above:" | cut -d: -f1)
later_at=$(echo "$OUT" | grep -n "later-prog" | cut -d: -f1)
[ -n "$title_at" ] || { echo "$OUT"; fail "the plan has a later section"; }
[ "$core_at" -lt "$title_at" ] && [ "$title_at" -lt "$later_at" ] || { echo "$OUT"; fail "core rows, then the later heading, then later rows"; }
[ ! -f repo/order.log ] || fail "dry-run must not execute"
ok "setup-new-machine --dry-run shows what's later under its own heading"

# --- --skip-later ----------------------------------------------------------
OUT=$("$BIN" --repo repo --machine m1 setup-new-machine --yes --skip-later 2>&1) || { echo "$OUT"; fail "--skip-later exits 0"; }
echo "$OUT" | grep -q "Later, skipped (--skip-later):" || { echo "$OUT"; fail "the plan says what it skips"; }
[ "$(cat repo/order.log)" = "core-prog
core-script" ] || { cat repo/order.log; fail "only the core steps ran"; }
ok "setup-new-machine --skip-later runs the core phase only"

# --- both phases, in order -------------------------------------------------
rm -f repo/order.log repo/*.done
OUT=$("$BIN" --repo repo --machine m1 setup-new-machine --yes 2>&1) || { echo "$OUT"; fail "setup exits 0"; }
[ "$(cat repo/order.log)" = "core-prog
core-script
later-prog
later-script" ] || { cat repo/order.log; fail "core programs, core scripts, later programs, later scripts"; }
echo "$OUT" | grep -q "==> later: what can wait" || { echo "$OUT"; fail "the later phase is announced"; }
ok "setup-new-machine runs the later phase after every core step"

# Run again after a stop: only what's left, the core already done.
rm -f repo/order.log repo/later-script.done
"$BIN" --repo repo --machine m1 setup-new-machine --yes >/dev/null 2>&1 || fail "the rerun exits 0"
[ "$(cat repo/order.log)" = "later-script" ] || { cat repo/order.log; fail "only the unfinished later step runs"; }
ok "running setup again finishes what the later phase left"

# --- a later program whose core dependency failed is skipped ---------------
hcl_root dep <<'HCL'
program "base" {
  custom "manual" {
    command = "false"
    present = "test -f base.done"
  }
}

program "big" {
  later      = "large"
  depends_on = [program.base]
  custom "manual" {
    command = "touch big.done"
    present = "test -f big.done"
  }
}

machine "m1" {
  install = [program.base, program.big]
}
HCL
compile_repo dep
OUT=$("$BIN" --repo dep --machine m1 setup-new-machine --yes 2>&1) && { echo "$OUT"; fail "a failed install exits 1"; }
echo "$OUT" | grep -q "skipping big" || { echo "$OUT"; fail "the later phase skips what the core phase failed"; }
[ ! -f dep/big.done ] || fail "big must not install"
ok "a later install whose dependency failed in the core phase is skipped"

# --- explain and compile -----------------------------------------------------
"$BIN" --repo repo --machine m1 explain later-prog | grep -q "later .*a big download" || fail "explain shows a program's later"
"$BIN" --repo repo --machine m1 explain later-script | grep -q "later .*gigabytes of models" || fail "explain shows a script's later"
ok "explain shows why a step is later"

hcl_root bad <<'HCL'
program "slow" {
  later = "slow"
  custom "manual" {
    command = "true"
    present = "true"
  }
}

script "eager" {
  run       = "true"
  run_after = [program.slow]
}

machine "m1" {
  install = [program.slow]
  run     = [script.eager]
}
HCL
OUT=$("$BIN" --repo bad compile 2>&1) && fail "compile refuses a core step after a later one"
echo "$OUT" | grep -q "script 'eager' runs after program 'slow', which is later" || { echo "$OUT"; fail "compile names the step and the fix"; }
[ ! -f bad/loadout.lock.json ] || fail "nothing is written when compile refuses"
ok "compile refuses a core script that runs after a later program"
