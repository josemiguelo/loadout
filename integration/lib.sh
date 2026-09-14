# Shared by every integration/t/*.sh — sourced by run-tests.sh, never run.
# Expects BIN (absolute path to the binary) and WORK (the suite's scratch
# dir) to be set; each test file starts in its own fresh dir under WORK.

ok() { PASS=$((PASS + 1)); echo "ok $PASS - $1"; }
fail() { echo "FAIL - $1"; exit 1; }

# A fresh working directory for one test file: nothing leaks between files.
new_work() { mktemp -d -p "$WORK"; }

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
    cat > "$1/manifest.toml" <<'TOML'
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
    printf 'scripts = ["marker"]\n\n[pm]\ngit = "manual"\n' > "$1/machines/m1.toml"
    printf '[pm]\ngit = "manual"\n' > "$1/machines/m2.toml"
    printf '#!/bin/sh\necho created > marker.txt\n' > "$1/scripts/marker.sh"
}

# A repo whose one program installs through a fake installer (no host
# package manager involved) and whose scripts cover every verdict: one
# passing, one whose check keeps failing, one setup-only.
scripts_repo() {
    mkdir -p "$1/state" "$1/machines"
    cat > "$1/manifest.toml" <<'TOML'
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
    printf 'scripts = ["healthy", "drifted", "bootstrap-only"]\n\n[pm]\nmytool = "fake"\n' > "$1/machines/m1.toml"
}

# A stand-in sudo on PATH for pane tests: `-n` succeeds only once a stamp
# file exists, `-S -v` reads the password from stdin and stamps on
# "secret", anything else runs the command only when stamped. Sets
# FAKE_SUDO_PATH to put in front of PATH.
fake_sudo() {
    mkdir -p fakebin
    cat > fakebin/sudo <<'SUDO'
#!/bin/sh
STAMP=$FAKE_SUDO_STAMP
case "$1" in
  -n) shift; [ "${1:-}" = "-v" ] && shift; [ -f "$STAMP" ] || { echo "sudo: a password is required" >&2; exit 1; }; [ $# -gt 0 ] && exec "$@"; exit 0 ;;
  -S) read -r pw; [ "$pw" = "secret" ] && { touch "$STAMP"; exit 0; } || { echo "Sorry, try again." >&2; exit 1; } ;;
  *) [ -f "$STAMP" ] || { echo "sudo: a terminal is required" >&2; exit 1; }; exec "$@" ;;
esac
SUDO
    chmod +x fakebin/sudo
    FAKE_SUDO_PATH=$PWD/fakebin
    FAKE_SUDO_STAMP=$PWD/sudo-stamp
    export FAKE_SUDO_STAMP
    rm -f "$FAKE_SUDO_STAMP"
}

# The PTY tests need Linux `script`; macOS's has a different syntax.
has_pty() { [ "$(uname)" = "Linux" ] && command -v script >/dev/null; }

# Drive the binary on a pseudo-terminal: keys come from stdin (a subshell
# of printf/sleep), the screen is captured to $1. Never fails the test by
# itself — assert on the capture.
pty_run() {
    log=$1; shift
    script -qec "\"$BIN\" $*" "$log" >/dev/null || true
}
