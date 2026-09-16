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
fi
