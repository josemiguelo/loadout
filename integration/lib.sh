# Shared by every integration/t/*.sh — sourced by run-tests.sh, never run.
# Expects BIN (absolute path to the binary) and WORK (the suite's scratch
# dir) to be set; each test file starts in its own fresh dir under WORK.

ok() { PASS=$((PASS + 1)); echo "ok $PASS - $1"; }
fail() { echo "FAIL - $1"; exit 1; }

# A fresh working directory for one test file: nothing leaks between files.
new_work() { mktemp -d -p "$WORK"; }

# Append the [layout] every fixture shares to <dir>/loadout.toml. A table of
# its own, so it can follow the fixture's tables and precede appended ones.
add_layout() {
    printf '\n[layout]\nfragments = ["programs/**/*.toml", "maintenance/**/*.toml"]\nmachines = "machines"\nstate = "state"\n' >> "$1/loadout.toml"
}

# `loadout init` scaffold with a git identity so sync/commit tests can run.
scaffold_repo() {
    "$BIN" init "$1" >/dev/null || fail "init exits 0"
    git -C "$1" config user.email test@example.com
    git -C "$1" config user.name "Integration Test"
}

# The workhorse fixture: git (installed everywhere) plus a marker script.
# "manual" is a custom install key so the tests don't depend on which
# package manager the host actually has. m1 opts into the marker script;
# m2 deliberately does NOT.
basic_repo() {
    scaffold_repo "$1"
    cat > "$1/loadout.toml" <<'TOML'
[programs.git]
[programs.git.version]
command = "git --version"
regex = "git version ([0-9.]+)"
[programs.git.install.dnf]
command = "sudo dnf install -y git"
[programs.git.install.manual]
command = "echo install git yourself && false"

[scripts.marker]
file = "scripts/marker.sh"
check = "test -f marker.txt"
TOML
    add_layout "$1"
    printf 'scripts = ["marker"]\n\n[pm]\ngit = "manual"\n' > "$1/machines/m1.toml"
    printf '[pm]\ngit = "manual"\n' > "$1/machines/m2.toml"
    mkdir -p "$1/scripts"
    printf '#!/bin/sh\necho created > marker.txt\n' > "$1/scripts/marker.sh"
}

# A repo whose one program installs through a fake installer (no host
# package manager involved) and whose scripts cover every verdict: one
# passing, one whose check keeps failing, one setup-only.
scripts_repo() {
    mkdir -p "$1/state" "$1/machines"
    cat > "$1/loadout.toml" <<'TOML'
[installers.fake]
probe = "sh"
install = "echo installed-{pkg} > fake-install.txt"
check = "test -f fake-install.txt && echo mytool 1.0"
regex = "mytool ([0-9.]+)"

[programs.mytool]
via = ["fake"]

[scripts.healthy]
run = "true"
check = "true"

[scripts.drifted]
run = "true"
check = "echo missing: nodejs 16 npm firebase-tools; false"

[scripts.bootstrap-only]
run = "echo bootstrapped > bootstrap-marker.txt"
check = "test -f bootstrap-marker.txt"
modes = ["setup"]
TOML
    add_layout "$1"
    printf 'scripts = ["healthy", "drifted", "bootstrap-only"]\n\n[pm]\nmytool = "fake"\n' > "$1/machines/m1.toml"
}

# A stand-in sudo on PATH that asks like the real one: `-n` succeeds only
# once a stamp file exists; anything else, unstamped, prompts on the
# terminal (/dev/tty, echo off), stamps on "secret" and runs the command,
# says "Sorry, try again." otherwise — three tries. Sets FAKE_SUDO_PATH to
# put in front of PATH.
fake_sudo() {
    mkdir -p fakebin
    cat > fakebin/sudo <<'SUDO'
#!/bin/sh
STAMP=$FAKE_SUDO_STAMP
case "$1" in
  -n) shift; [ "${1:-}" = "-v" ] && shift; [ -f "$STAMP" ] || { echo "sudo: a password is required" >&2; exit 1; }; [ $# -gt 0 ] && exec "$@"; exit 0 ;;
esac
tries=0
while [ ! -f "$STAMP" ]; do
  [ "$tries" -ge 3 ] && { echo "sudo: 3 incorrect password attempts" >&2; exit 1; }
  printf '[sudo] password for tester: ' >/dev/tty
  stty -echo </dev/tty
  read -r pw </dev/tty
  stty echo </dev/tty
  printf '\n' >/dev/tty
  if [ "$pw" = "secret" ]; then touch "$STAMP"; else echo "Sorry, try again." >/dev/tty; fi
  tries=$((tries + 1))
done
[ "${1:-}" = "-v" ] && exit 0
exec "$@"
SUDO
    chmod +x fakebin/sudo
    FAKE_SUDO_PATH=$PWD/fakebin
    FAKE_SUDO_STAMP=$PWD/sudo-stamp
    export FAKE_SUDO_STAMP
    rm -f "$FAKE_SUDO_STAMP"
}

# A fresh self-version cache, so a PTY test of the remote row doesn't wait
# on curl: the check reads this file instead of asking GitHub (0.0.1 is
# older than any build, so no self-update row appears either). Sets
# FAKE_CACHE to pass as XDG_CACHE_HOME — never exported, because the next
# test file runs in a different directory.
fake_release_cache() {
    mkdir -p cache/loadout
    echo 0.0.1 > cache/loadout/latest-release
    FAKE_CACHE=$PWD/cache
}

# The PTY tests need `script`, which both platforms have — with different
# calling conventions (see pty_run).
has_pty() { command -v script >/dev/null; }

# Drive the binary on a pseudo-terminal: keys come from stdin (a subshell
# of printf and wait_screen), the screen is captured to $1 — flushed as it
# is drawn (-F / -f), so the key feeder can wait on what is on screen. Never
# fails the test by itself — assert on the capture. Each run needs a log
# name of its own: the feeder starts before this truncates the file.
pty_run() {
    log=$1; shift
    if [ "$(uname)" = "Darwin" ]; then
        # BSD script takes the log, then the command as plain argv — no -e
        # (it already exits with the child's status) and no shell in
        # between, so nothing re-splits the arguments.
        script -qF "$log" "$BIN" "$@" >/dev/null || true
    else
        script -qfec "\"$BIN\" $*" "$log" >/dev/null || true
    fi
}

# For key feeders: block until the live capture $1 shows every extended
# regex that follows (escape codes stripped), then return — or give up after
# WAIT_SCREEN_TIMEOUT seconds (default 30), say so, and let the assertions
# fail. Waiting on the screen instead of a fixed sleep is what keeps a key
# off a row still busy asking: the remote row answered in ~1s on one machine
# and after 6 on another, and every fixed sleep was too short somewhere.
wait_screen() {
    log=$1; shift
    deadline=$(( $(date +%s) + ${WAIT_SCREEN_TIMEOUT:-30} ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if [ -f "$log" ]; then
            screen=$(perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\][^\a\e]*(\a|\e\\)//g' "$log" 2>/dev/null)
            seen=1
            for pattern in "$@"; do
                printf '%s' "$screen" | grep -qaE -- "$pattern" || { seen=0; break; }
            done
            [ "$seen" = 1 ] && return 0
        fi
        sleep 0.2
    done
    echo "wait_screen: $log never showed: $*" >&2
    return 1
}

# The home screen has answered on every subject row: a busy row shows no
# verb, so each verb on screen is an answer landed (the model starts its
# refresh before the first frame, so none is left over from the stored
# state). Keys before this can land on a row that refuses them. Verbs are
# matched by their start: the row under the cursor clips its own
# ("install what's mis…").
wait_settled() {
    wait_screen "$1" 'review th' '(nothing miss|install wh)' '(nothing pend|run wh)'
}

# A hand-off's command finished, whatever the outcome: the way-back prompt
# is on screen.
wait_back() {
    wait_screen "$1" 'enter returns to loadout'
}

# The capture $1 as text: escape sequences (colours, cursor moves) removed.
plain_screen() {
    perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\][^\a\e]*(\a|\e\\)//g' "$1"
}

# [pattern] is on screen in the capture $1, colours or not.
seen() {
    plain_screen "$1" | grep -qaE -- "$2"
}

# [pattern] is drawn after the way-back prompt, i.e. by the reopened screen.
seen_after_back() {
    plain_screen "$1" | sed -n '/enter returns to loadout/,$p' | grep -qaE -- "$2"
}
