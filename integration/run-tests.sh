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
# The DSL and Gradle plugin `loadout compile` uses: the share directory
# `./gradlew bundle` builds (it builds nothing here either).
LOADOUT_HOME=${LOADOUT_HOME:-$HERE/../build/bundle}
[ -f "$LOADOUT_HOME/VERSION" ] || {
    echo "no share directory at $LOADOUT_HOME: run ./gradlew bundle first (or set LOADOUT_HOME)" >&2
    exit 1
}
LOADOUT_HOME=$(cd "$LOADOUT_HOME" && pwd -P)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PASS=0
# Assertions grep plain text: keep the caller's colour forcing out of it.
unset FORCE_COLOR CLICOLOR_FORCE LOADOUT_REPO
# Fixture compiles share one lock cache and copy their Gradle skeleton from
# one scaffold (lib.sh: kt_repo, compile_repo).
KT_TEMPLATE=$WORK/kt-template
LOCK_CACHE=$WORK/lock-cache
mkdir -p "$LOCK_CACHE"
# The run's own cache: compiles build there (the Gradle plugin), never in
# the developer's. Seeded like fake_release_cache, so a status doesn't ask
# GitHub for loadout's latest release.
XDG_CACHE_HOME=$WORK/cache
mkdir -p "$XDG_CACHE_HOME/loadout"
echo 0.0.1 > "$XDG_CACHE_HOME/loadout/latest-release"
export BIN INSTALL_SH WORK LOADOUT_HOME KT_TEMPLATE LOCK_CACHE XDG_CACHE_HOME
"$BIN" init "$KT_TEMPLATE" >/dev/null || { echo "loadout init failed: can't build fixtures" >&2; exit 1; }

. "$HERE/lib.sh"

for t in "$HERE"/t/*.sh; do
    case "$(basename "$t")" in *"$PATTERN"*) ;; *) continue ;; esac
    cd "$(new_work)"
    # shellcheck disable=SC1090
    . "$t"
done

echo ""
echo "All $PASS integration tests passed."
