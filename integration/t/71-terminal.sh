# Commands on a real terminal. Colour is TTY-gated, and the palette comes
# from a REAL background-colour query — which some terminals never answer.
# `script`'s pty is one of them (there is no emulator behind it), so these
# tests are the regression for the hang that took out every command on a
# mac inside a nested tmux: the palette is built while the Clikt context is
# assembled, so `status` never printed a byte either.
basic_repo repo
ESC=$(printf '\033')

OUT=$("$BIN" --repo repo --machine m1 status) || fail "status exits 0"
printf '%s' "$OUT" | grep -q "$ESC" && fail "piped output must stay plain" || true
printf '%s' "$OUT" | grep -q ']11;?' && fail "piped output must never query the terminal" || true
ok "piped output is plain text and asks the terminal nothing"

if has_pty; then
    printf '' | pty_run tty-status.log --repo repo --machine m1 status
    grep -qa ']11;?' tty-status.log || fail "on a TTY the palette comes from a real background-colour query"
    grep -qa "$ESC" tty-status.log || fail "on a TTY the output is styled"
    grep -qa "PROGRAM" tty-status.log || fail "a terminal that never answers the query still gets its table"
    grep -qa "State written" tty-status.log || fail "and the command runs all the way to the end"
    ok "a terminal that ignores the background-colour query doesn't stall the command"

    # Some terminals can't be asked at all — a tmux popup running its own
    # tmux client answers nothing, so a light one would be painted dark.
    # LOADOUT_THEME is the answer for those, and having been told, loadout
    # doesn't ask.
    export LOADOUT_THEME=light
    printf '' | pty_run forced-theme.log --repo repo --machine m1 status
    grep -qa ']11;?' forced-theme.log && fail "a told palette asks the terminal nothing" || true
    grep -qa "PROGRAM" forced-theme.log || fail "and the command still runs"
    unset LOADOUT_THEME
    ok "LOADOUT_THEME picks the palette without asking the terminal"
fi

LOADOUT_THEME=lite "$BIN" --repo repo --machine m1 status >lite.out 2>&1 && fail "an unreadable LOADOUT_THEME must refuse"
grep -q 'error: LOADOUT_THEME must be dark or light, not "lite"' lite.out || fail "and say so in one clean line: $(cat lite.out)"
grep -q 'Uncaught Kotlin exception' lite.out && fail "never as a stack trace" || true
ok "an unreadable LOADOUT_THEME is refused in one line, not ignored"
