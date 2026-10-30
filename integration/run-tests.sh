#!/bin/sh
# Black-box integration tests: drive the real binary against temp config
# repos. Usage: integration/run-tests.sh [path-to-binary] [pattern]
#   path-to-binary  default build/loadout (`go build -o build/loadout ./cmd/loadout`)
#   pattern         run only t/*.sh whose name contains it (e.g. `home`, `run`)
# Each t/*.sh builds its own fixtures in its own directory — no file
# depends on another having run; the numbers only fix the order. The
# runner builds nothing.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
BIN=$HERE/../build/loadout
if [ $# -gt 0 ] && [ -f "$1" ]; then BIN=$1; shift; fi
[ -x "$BIN" ] || {
    echo "no loadout binary at $BIN: run go build -o build/loadout ./cmd/loadout first (or pass its path)" >&2
    exit 1
}
BIN=$(realpath "$BIN")
PATTERN=${1:-}
INSTALL_SH=$(realpath "$HERE/../install.sh")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PASS=0
# Assertions grep plain text: keep the caller's colour forcing out of it.
unset FORCE_COLOR CLICOLOR_FORCE LOADOUT_REPO
# The run's own cache, never the developer's. Seeded like
# fake_release_cache, so a status doesn't ask GitHub for loadout's latest
# release.
XDG_CACHE_HOME=$WORK/cache
mkdir -p "$XDG_CACHE_HOME/loadout"
echo 0.0.1 > "$XDG_CACHE_HOME/loadout/latest-release"
export BIN INSTALL_SH WORK XDG_CACHE_HOME

. "$HERE/lib.sh"

for t in "$HERE"/t/*.sh; do
    case "$(basename "$t")" in *"$PATTERN"*) ;; *) continue ;; esac
    cd "$(new_work)"
    # shellcheck disable=SC1090
    . "$t"
done

echo ""
echo "All $PASS integration tests passed."
