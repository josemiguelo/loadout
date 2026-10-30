# sudo upfront: a run whose plan holds a step that needs sudo (declared
# `sudo: true`, or a command that says sudo) asks for the password once,
# before the first step; the steps then find it cached. Nothing needing it,
# or nothing left to run, asks nothing.

mkdir -p srepo
# -n: never prompts, so it only succeeds on credentials asked for earlier.
cat > srepo/needs.sh <<'SH'
sudo -n true && touch needs-ran.txt
SH
cat > srepo/plain.sh <<'SH'
touch plain-ran.txt
SH
hcl_root srepo <<'HCL'
script "needs" {
  file       = "needs.sh"
  check      = "test -f needs-ran.txt"
  needs_sudo = true
}

script "plain" {
  file  = "plain.sh"
  check = "test -f plain-ran.txt"
}

machine "m1" {
  run = [script.needs, script.plain]
}
HCL
compile_repo srepo
fake_sudo

OUT=$(PATH="$FAKE_SUDO_PATH:$PATH" "$BIN" --repo srepo --machine m1 run plain </dev/null 2>&1)
echo "$OUT" | grep -q "sudo" && fail "a run with nothing needing sudo asks nothing" || true
[ -f srepo/plain-ran.txt ] || fail "the plain script ran"
ok "a run with no step needing sudo doesn't ask for it"

OUT=$("$BIN" --repo srepo --machine m1 explain needs)
echo "$OUT" | grep -q "sudo .*asks for the password first" || fail "explain shows a script's sudo declaration"
ok "explain shows a declared sudo"

if has_pty; then
    # Three wrong passwords: the run stops before the step.
    { wait_screen sudo-refused.log '\[sudo\] password for tester'; printf 'a\r'
      wait_screen sudo-refused.log 'Sorry, try again'; printf 'b\r'; sleep 0.5; printf 'c\r'; sleep 1; } \
        | PATH="$FAKE_SUDO_PATH:$PATH" pty_run sudo-refused.log --repo srepo --machine m1 run needs
    seen sudo-refused.log "A step needs your sudo password" || fail_screen sudo-refused.log "the run says why it asks"
    seen sudo-refused.log "Aborted" || fail_screen sudo-refused.log "a refused password stops the run"
    [ -f srepo/needs-ran.txt ] && fail "nothing runs without the password" || true
    ok "a refused sudo password stops the run before any step"

    # The right one, once: the script's own `sudo -n` finds it cached.
    { wait_screen sudo-asked.log '\[sudo\] password for tester'; printf 'secret\r'; sleep 1; } \
        | PATH="$FAKE_SUDO_PATH:$PATH" pty_run sudo-asked.log --repo srepo --machine m1 run needs
    [ "$(plain_screen sudo-asked.log | grep -c '\[sudo\] password for tester')" = 1 ] ||
        fail_screen sudo-asked.log "sudo asks exactly once"
    [ -f srepo/needs-ran.txt ] || fail_screen sudo-asked.log "the step ran on the password asked for upfront"
    ok "a step that needs sudo is asked for once, upfront, and runs on it"

    # setup-new-machine asks the same way.
    rm -f srepo/needs-ran.txt "$FAKE_SUDO_STAMP"
    { wait_screen sudo-setup.log '\[sudo\] password for tester'; printf 'secret\r'; sleep 1; } \
        | PATH="$FAKE_SUDO_PATH:$PATH" pty_run sudo-setup.log --repo srepo --machine m1 setup-new-machine --yes
    seen sudo-setup.log "A step needs your sudo password" || fail_screen sudo-setup.log "setup asks upfront"
    [ -f srepo/needs-ran.txt ] || fail_screen sudo-setup.log "setup's step ran on the password asked for upfront"
    ok "setup-new-machine asks for sudo upfront too"
fi

# Done already: nothing pending needs sudo, so nothing asks, even with no
# credentials cached.
rm -f "$FAKE_SUDO_STAMP"; touch srepo/needs-ran.txt
OUT=$(PATH="$FAKE_SUDO_PATH:$PATH" "$BIN" --repo srepo --machine m1 run needs </dev/null 2>&1)
echo "$OUT" | grep -q "sudo password" && fail "a done step asks nothing" || true
echo "$OUT" | grep -q "already done" || fail "the done step is skipped"
ok "a step that needs sudo but is already done asks nothing"

# Credentials still cached: nothing to ask, the step just runs.
touch "$FAKE_SUDO_STAMP"; rm -f srepo/needs-ran.txt
OUT=$(PATH="$FAKE_SUDO_PATH:$PATH" "$BIN" --repo srepo --machine m1 run needs </dev/null 2>&1)
echo "$OUT" | grep -q "sudo password" && fail "cached credentials ask nothing" || true
[ -f srepo/needs-ran.txt ] || fail "the step ran on the cached credentials"
ok "with sudo's credentials still cached, nothing is asked"
