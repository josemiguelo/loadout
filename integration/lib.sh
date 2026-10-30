# Shared by every integration/t/*.sh — sourced by run-tests.sh, never run.
# Expects BIN (absolute path to the binary) and WORK (the suite's scratch
# dir) to be set; each test file starts in its own fresh dir under WORK.

ok() { PASS=$((PASS + 1)); echo "ok $PASS - $1"; }
fail() { echo "FAIL - $1"; exit 1; }

# A fresh working directory for one test file: nothing leaks between files.
new_work() { mktemp -d -p "$WORK"; }

# A config repo is HCL compiled to loadout.lock.json: loadout.hcl at the
# root (the repo block, always compiled) and the *.loadout.hcl files its
# sources globs match. A declaration's folder is its file's, so what must
# run from the repo root (scripts beside loadout.hcl, files a command
# writes there) is declared in loadout.hcl itself.

# loadout.hcl in <dir>: a repo named test, its state in machines/state/,
# globbing init's plain layout (programs/, maintenance/, machines/); stdin
# follows the repo block, as declarations at the repo root.
hcl_root() {
    mkdir -p "$1/machines/state"
    {
        cat <<'HCL'
repo {
  name    = "test"
  state   = "machines/state"
  sources = ["programs/**/*.loadout.hcl", "maintenance/**/*.loadout.hcl", "machines/**/*.loadout.hcl"]
}
HCL
        printf '\n'
        cat
    } > "$1/loadout.hcl"
}

# hcl_root with nothing at the root: fixtures add manifests with hcl_file.
hcl_repo() { hcl_root "$1" </dev/null; }

# stdin as the manifest file <path>.
hcl_file() {
    mkdir -p "$(dirname "$1")"
    cat > "$1"
}

# Adds the attribute line <attr> (`configs = "configs"`) to the repo block
# of loadout.hcl <file>, as its first line. awk, not sed: BSD and GNU sed
# disagree on inserting a line.
repo_attr() {
    awk -v line="$2" '{ print } /^repo \{/ { print "  " line }' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}

# `loadout compile` repo <dir>, failing the test with its output when it
# doesn't compile.
compile_repo() {
    out=$("$BIN" --repo "$1" compile 2>&1) || { echo "$out"; fail "fixture $1 compiles"; }
}

# `loadout init` scaffold with a git identity so sync/commit tests can run.
scaffold_repo() {
    "$BIN" init "$1" >/dev/null || fail "init exits 0"
    git -C "$1" config user.email test@example.com
    git -C "$1" config user.name "Integration Test"
}

# The workhorse fixture: git (installed everywhere) plus a marker script.
# "manual" is a variant of git's own so the tests don't depend on which
# package manager the host actually has. m1 runs the marker script; m2
# deliberately does NOT.
basic_repo() {
    scaffold_repo "$1"
    rm -f "$1/programs/cli.loadout.hcl"
    cat >> "$1/loadout.hcl" <<'HCL'

program "git" {
  version = "git --version"
  regex   = "git version ([0-9.]+)"
  via "dnf" {
    command = "sudo dnf install -y git"
  }
  custom "manual" {
    command = "echo install git yourself && false"
  }
}

script "marker" {
  file  = "scripts/marker.sh"
  check = "test -f marker.txt"
}
HCL
    hcl_file "$1/machines/machines.loadout.hcl" <<'HCL'
machine "m1" {
  install = [variant(program.git, "manual")]
  run     = [script.marker]
}

machine "m2" {
  install = [variant(program.git, "manual")]
}
HCL
    mkdir -p "$1/scripts"
    printf '#!/bin/sh\necho created > marker.txt\n' > "$1/scripts/marker.sh"
    compile_repo "$1"
}

# basic_repo, but laid out as a bare repo ($1) plus one linked worktree
# ($2) checked out from it (`git worktree add`, not a plain clone) — the
# bare-repo-plus-worktree shape `workmux` uses. Same manifest/machines as
# basic_repo (its lock committed), so the same assertions apply once
# pointed at $2.
worktree_repo() {
    # Absolute: git -C changes into $seed before resolving its arguments, so
    # a relative bare/worktree path would land inside $seed instead of here.
    bare=$PWD/$1
    wt=$PWD/$2
    seed=$(new_work)
    basic_repo "$seed"
    git -C "$seed" add -A
    git -C "$seed" commit -qm "initial manifest" >/dev/null
    branch=$(git -C "$seed" symbolic-ref --short HEAD)
    git init -q --bare "$bare"
    git -C "$seed" push -q "$bare" "$branch"
    git -C "$bare" worktree add -q "$wt" "$branch"
    git -C "$wt" config user.email test@example.com
    git -C "$wt" config user.name "Integration Test"
}

# A repo whose one program installs through a fake installer (no host
# package manager involved) and whose scripts cover every verdict: one
# passing, one whose check keeps failing, one setup-only.
scripts_repo() {
    hcl_root "$1" <<'HCL'
installer "fake" {
  probe   = "sh"
  install = "echo installed-{pkg} > fake-install.txt"
  check   = "test -f fake-install.txt && echo mytool 1.0"
  regex   = "mytool ([0-9.]+)"
}

program "mytool" {
  install_via = [fake]
}

script "healthy" {
  run   = "true"
  check = "true"
}

script "drifted" {
  run   = "true"
  check = "echo missing: nodejs 16 npm firebase-tools; false"
}

script "bootstrap-only" {
  run        = "echo bootstrapped > bootstrap-marker.txt"
  check      = "test -f bootstrap-marker.txt"
  setup_only = true
}
HCL
    hcl_file "$1/machines/machines.loadout.hcl" <<'HCL'
machine "m1" {
  install = [program.mytool]
  run     = [script.healthy, script.drifted, script.bootstrap-only]
}
HCL
    compile_repo "$1"
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
    # The pty is ours, so is its type: CI runners leave TERM unset (Linux) or
    # set one less can't drive (macOS), and less (v at the pause) then stops
    # on "terminal is not fully functional".
    TERM=xterm-256color; export TERM
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

# The capture $1 as text: escape sequences (colours, cursor moves) removed.
plain_screen() {
    perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\][^\a\e]*(\a|\e\\)//g' "$1"
}

# Fail with [message] $2, showing the end of the capture $1: a CI log
# otherwise says only which check failed, not what the screen showed.
fail_screen() {
    echo "--- last lines of $1 ---"
    plain_screen "$1" | tail -n "${SCREEN_LINES:-60}"
    echo "---"
    fail "$2"
}

# [pattern] is on screen in the capture $1, colours or not.
seen() {
    plain_screen "$1" | grep -qaE -- "$2"
}

# --- the home screen ------------------------------------------------------
# Bubble Tea's renderer writes only the cells that changed, so the raw
# capture can't be grepped for what is on screen. The screen writes its
# current frame as plain text to LOADOUT_SCREEN_DUMP after every render
# (atomically): these helpers read that file, <name>.screen.

# Drive the home screen on a pseudo-terminal of PTY_SIZE cells (default
# 140x40: the wide layout), keys from stdin, like pty_run: the raw output
# goes to <name>.log, the frames to <name>.screen. The size is set inside
# the pty (stty) before loadout starts.
screen_run() {
    name=$1; shift
    size=${PTY_SIZE:-140x40}
    cols=${size%x*}; rows=${size#*x}
    # CI sets no COLORTERM: without it the screen drops to 256 colours, and
    # the theme's assertions look for its truecolor escapes.
    TERM=xterm-256color; COLORTERM=truecolor; export TERM COLORTERM
    if [ "$(uname)" = "Darwin" ]; then
        LOADOUT_SCREEN_DUMP="$PWD/$name.screen" script -qF "$name.log" \
            sh -c 'stty cols "$1" rows "$2"; shift 2; exec "$@"' sh "$cols" "$rows" "$BIN" "$@" >/dev/null || true
    else
        LOADOUT_SCREEN_DUMP="$PWD/$name.screen" script -qfec "stty cols $cols rows $rows; exec \"$BIN\" $*" "$name.log" >/dev/null || true
    fi
}

# For key feeders: block until the current frame of <name> shows every
# extended regex that follows — or give up after WAIT_SCREEN_TIMEOUT
# seconds (default 30), say so, and return 1.
wait_frame() {
    name=$1; shift
    deadline=$(( $(date +%s) + ${WAIT_SCREEN_TIMEOUT:-30} ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if [ -f "$name.screen" ]; then
            hit=1
            for pattern in "$@"; do
                grep -qaE -- "$pattern" "$name.screen" || { hit=0; break; }
            done
            [ "$hit" = 1 ] && return 0
        fi
        sleep 0.1
    done
    echo "wait_frame: $name never showed: $*" >&2
    return 1
}

# Every subject has answered: the sidebar shows each one's count, which a
# subject still being checked leaves out (the refresh starts before the
# first frame). Keys before this can land on a row that refuses them.
wait_settled() {
    wait_frame "$1" 'programs +[0-9]+/[0-9]+' 'scripts +[0-9]+/[0-9]+' 'remote +(up to date|unavailable|[0-9?]+)'
}

# The run in the panel has ended, whatever the outcome.
wait_done() {
    wait_frame "$1" 'Run .*(✓ done|× exit [0-9]+|interrupted)'
}

# [pattern] is in the current frame of <name>.
frame_seen() {
    grep -qaE -- "$2" "$1.screen"
}

# Fail with [message] $2, showing the last frame of <name>.
fail_frame() {
    echo "--- last frame of $1 ---"
    cat "$1.screen" 2>/dev/null
    echo "---"
    fail "$2"
}
