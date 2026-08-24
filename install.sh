#!/bin/sh
# Install the latest loadout release binary into ~/.local/bin. No sudo.
#
#   curl -fsSL https://raw.githubusercontent.com/josemiguelo/loadout/master/install.sh | sh
#
# Environment overrides:
#   LOADOUT_VERSION=v0.2.0   pin a release (default: latest)
#   LOADOUT_INSTALL_DIR=...  install somewhere else (default: ~/.local/bin)
set -eu

REPO="josemiguelo/loadout"
INSTALL_DIR="${LOADOUT_INSTALL_DIR:-$HOME/.local/bin}"
DOWNLOAD_BASE="${LOADOUT_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target="linux-x64" ;;
  Darwin-arm64) target="macos-arm64" ;;
  Darwin-x86_64)
    # uname lies under Rosetta; the real hardware is arm64.
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
      target="macos-arm64"
    else
      target="macos-x64"
    fi
    ;;
  *)
    echo "error: no release for $(uname -s)/$(uname -m) (available: linux-x64, macos-arm64, macos-x64)" >&2
    exit 1
    ;;
esac

version="${LOADOUT_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$version" ] || { echo "error: could not determine the latest release of $REPO" >&2; exit 1; }
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

url="$DOWNLOAD_BASE/$version/loadout-$version-$target.tar.gz"
echo "Downloading loadout $version ($target)..."
curl -fsSL "$url" -o "$tmp/loadout.tar.gz"
tar -xzf "$tmp/loadout.tar.gz" -C "$tmp"

# Refuse to install a binary that can't even print its help.
"$tmp/loadout" --help >/dev/null 2>&1 || {
  echo "error: downloaded binary failed to run" >&2
  exit 1
}

mkdir -p "$INSTALL_DIR"
mv "$tmp/loadout" "$INSTALL_DIR/loadout"
chmod +x "$INSTALL_DIR/loadout"
echo "Installed $INSTALL_DIR/loadout ($version)"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "note: $INSTALL_DIR is not on your PATH — add it to your shell profile" ;;
esac

echo ""
echo "Next steps:"
echo "  1. git clone <your config repo> ~/.config/loadouts"
echo "  2. Write machines/\$(hostname).toml — or just: extends = \"<your-os-base>\""
echo "  3. loadout --repo ~/.config/loadouts setup-new-machine"
echo "  4. loadout --repo ~/.config/loadouts sync"
