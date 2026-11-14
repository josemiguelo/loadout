#!/bin/sh
# Black-box integration tests: drive the real binary against temp config
# repos. Usage: integration/run-tests.sh [path-to-binary] [pattern]
#   path-to-binary  default build/loadout (`bun run build`)
#   pattern         run only t/*.sh whose name contains it (e.g. `home`, `run`)
# Each t/*.sh builds its own fixtures in its own directory — no file
# depends on another having run; the numbers only fix the order. The
# runner builds nothing.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
BIN=$HERE/../build/loadout
if [ $# -gt 0 ] && [ -f "$1" ]; then BIN=$1; shift; fi
[ -x "$BIN" ] || {
    echo "no loadout binary at $BIN: run bun run build first (or pass its path)" >&2
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
# Its own data too: loadout's bun wrapper lands here, never in the developer's.
XDG_DATA_HOME=$WORK/data
export BIN INSTALL_SH WORK XDG_CACHE_HOME XDG_DATA_HOME
# Compile and every script run with the binary itself as bun, as on a
# user's machine: a developer's LOADOUT_BUN would hide that. A test that
# wants the override sets it per command (42-bun).
unset LOADOUT_BUN

. "$HERE/lib.sh"

for t in "$HERE"/t/*.sh; do
    case "$(basename "$t")" in *"$PATTERN"*) ;; *) continue ;; esac
    cd "$(new_work)"
    # shellcheck disable=SC1090
    . "$t"
done

echo ""
echo "All $PASS integration tests passed."
