#!/bin/sh
# Black-box integration tests: drive the real binary against temp config
# repos. Usage: integration/run-tests.sh [path-to-binary] [pattern]
#   pattern  run only t/*.sh whose name contains it (e.g. `home`, `run`)
# Each t/*.sh builds its own fixtures in its own directory — no file
# depends on another having run; the numbers only fix the order.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
BIN=app/build/bin/linuxX64/debugExecutable/loadout.kexe
if [ $# -gt 0 ] && [ -f "$1" ]; then BIN=$1; shift; fi
BIN=$(realpath "$BIN")
PATTERN=${1:-}
INSTALL_SH=$(realpath "$HERE/../install.sh")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PASS=0
export BIN INSTALL_SH WORK

. "$HERE/lib.sh"

for t in "$HERE"/t/*.sh; do
    case "$(basename "$t")" in *"$PATTERN"*) ;; *) continue ;; esac
    cd "$(new_work)"
    # shellcheck disable=SC1090
    . "$t"
done

echo ""
echo "All $PASS integration tests passed."
