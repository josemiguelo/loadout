# The live view (src/cli/live.ts) on a real terminal, and the plain lines
# without one: steps run as an inner loadout on a pseudo-terminal of its
# own, a finished step is one line, a failed one keeps its output, and keys
# typed reach a step's prompt. The suite runs with LOADOUT_PLAIN=1; these
# unset it.

ts_root lrepo <<'TS'
const chatty = script("chatty", {
  runCommand: "for i in 1 2 3; do echo chatty-line-$i; done",
  checkCommand: "false",
});

const asks = script("asks", {
  runCommand: "printf 'name? '; read -r name; echo hi-$name; exit 3",
  checkCommand: "false",
});

machine("m1", { run: [chatty, asks] });
TS
compile_repo lrepo

OUT=$(env -u LOADOUT_PLAIN "$BIN" --repo lrepo --machine m1 script run --all 2>&1 </dev/null) && fail "a failed script exits non-zero: $OUT"
echo "$OUT" | grep -qE "━━ [12]/2 chatty" || fail "without a terminal, each step starts with its line: $OUT"
echo "$OUT" | grep -qE "✔ chatty +[0-9]+s" || fail "and ends with one: $OUT"
echo "$OUT" | grep -q "chatty-line-3" || fail "and its output passes through: $OUT"
echo "$OUT" | grep -qE "✘ asks +exit 3" || fail "a failed step's line says how: $OUT"
echo "$OUT" | grep -q "]777;loadout" && fail "no events without a live run: $OUT"
ok "without a terminal, every step gets a start line and an end line"

if has_pty; then
    # A real size (script's own pty has none: the view needs 40 columns),
    # and the answer only once the prompt shows, as a person types it.
    run_live() {
        if [ "$(uname)" = "Darwin" ]; then
            script -qF live.log sh -c 'stty cols 100 rows 30; unset LOADOUT_PLAIN; exec "$@"' sh "$BIN" "$@" >/dev/null || true
        else
            script -qfec "stty cols 100 rows 30; unset LOADOUT_PLAIN; exec \"$BIN\" $*" live.log >/dev/null || true
        fi
    }
    TERM=xterm-256color; export TERM
    { wait_screen live.log 'name\?'; printf 'bob\r'; sleep 2; } | run_live --repo lrepo --machine m1 script run --all
    SCREEN=$(plain_screen live.log)
    grep -qa ']777;loadout' live.log && fail "the inner loadout's events never reach the terminal"
    echo "$SCREEN" | grep -qE "chatty +[12]/2" || fail "the running step shows its name and where the run is: $SCREEN"
    echo "$SCREEN" | grep -qE "✔ chatty +[0-9]+s" || fail "a finished step is one line: $SCREEN"
    echo "$SCREEN" | grep -qE "│ hi-bob" || fail "a key typed reached the step's prompt, and its failed output stays: $SCREEN"
    echo "$SCREEN" | grep -qE "✘ asks +exit 3" || fail "the failed step's line says how: $SCREEN"
    echo "$SCREEN" | grep -qE "━━ " && fail "no plain start lines in a live run: $SCREEN"
    ok "on a terminal, steps run live: one line each when done, a failed one's output kept, keys reach its prompt"

    LOG=$(ls "$XDG_STATE_HOME"/loadout/runs/*.log 2>/dev/null | tail -1)
    [ -n "$LOG" ] || fail "a live run writes its log in the state folder"
    echo "$SCREEN" | grep -qF "Full output: $LOG" || fail "and names it at the end: $SCREEN"
    grep -q "chatty-line-3" "$LOG" || fail "the log keeps a successful step's output: $(cat "$LOG")"
    grep -q "hi-bob" "$LOG" || fail "and a failed one's"
    grep -qE "^━━ [12]/2 chatty" "$LOG" || fail "with each step's start line"
    grep -q "$(printf '\033')" "$LOG" && fail "as plain text"
    ok "a live run's log keeps every step's whole output, as plain text, and the run names it"

    # The inner loadout's step has the pseudo-terminal as its controlling
    # terminal (sudo's /dev/tty, Ctrl-C), and Ctrl-C stops the run.
    ts_root crepo <<'TS'
const tty = script("a-tty", { runCommand: "echo tty-is-$(ps -o tty= -p $$ | tr -d ' '); exit 1", checkCommand: "false" });
const slow = script("slow", { runCommand: "echo slow-started; sleep 30; echo slow-finished", checkCommand: "false" });
machine("m1", { run: [tty, slow] });
TS
    compile_repo crepo
    rm -f live.log
    { wait_screen live.log 'slow-started'; printf '\003'; sleep 3; } | run_live --repo crepo --machine m1 script run --all
    SCREEN=$(plain_screen live.log)
    echo "$SCREEN" | grep -q "tty-is-pts/" || fail "the step has a controlling terminal: $SCREEN"
    echo "$SCREEN" | grep -qE "✘ slow +stopped" || fail "Ctrl-C stops the running step: $SCREEN"
    echo "$SCREEN" | grep -q "slow-finished" && fail "before it finishes"
    pgrep -f "sleep 30" >/dev/null 2>&1 && pgrep -a -x sleep | grep -q " 30$" && fail "and leaves nothing running"
    ok "a live step has a terminal of its own, and Ctrl-C stops the run"
fi
