# Version floors, newer state files, and install.sh (the release bootstrap).

mkdir -p verrepo/state
cat > verrepo/manifest.toml <<'TOML'
[meta]
min-tool-version = "999.0.0"

[programs.git]
[programs.git.install.manual]
command = "false"
TOML
OUT=$("$BIN" --repo verrepo status 2>&1 || true)
echo "$OUT" | grep -q "requires loadout >= 999.0.0" || fail "min-tool-version not enforced"
echo "$OUT" | grep -q "run: loadout self-upgrade" || fail "refusal should point at loadout self-upgrade"
"$BIN" --help | grep -q "self-upgrade" || fail "self-upgrade command should be registered"
ok "manifest min-tool-version blocks an outdated binary with recovery hint"

cat > verrepo/manifest.toml <<'TOML'
[programs.git]
[programs.git.version]
command = "git --version"
regex = "git version ([0-9.]+)"
[programs.git.install.manual]
command = "false"
TOML
cat > verrepo/state/future.json <<'TOML'
{"schemaVersion": 99, "machine": "future", "os": "linux", "arch": "x86_64",
 "toolVersion": "9.9.9", "updatedAt": "2027-01-01T00:00:00Z"}
TOML
"$BIN" --repo verrepo --machine m1 status >/dev/null || fail "status works despite future state file"
OUT=$("$BIN" --repo verrepo diff 2>&1 || true)
echo "$OUT" | grep -q "newer loadout" || fail "future state file should warn"
echo "$OUT" | grep -q "future" && echo "$OUT" | grep -q '"future"' && fail "future machine must not appear as data" || true
ok "state files from a newer loadout are skipped with a warning"

# --- install.sh: first install vs upgrade --------------------------------
# Offline: a stub binary in a local "release" tarball. One tarball per
# release name, so install.sh resolves the host's own target and finds it
# — the test never repeats that mapping, which is the thing being trusted
# (and repeating it would misread a Rosetta shell, where uname says x86_64
# but install.sh correctly picks macos-arm64).
mkdir -p rel/v9.9.9 relbuild relbin
printf '#!/bin/sh\ncase "$1" in --version) echo "loadout version 9.9.9";; *) echo help;; esac\n' > relbuild/loadout
chmod +x relbuild/loadout
for target in linux-x64 macos-arm64 macos-x64; do
    tar -czf "rel/v9.9.9/loadout-v9.9.9-$target.tar.gz" -C relbuild loadout
done
OUT=$(LOADOUT_VERSION=v9.9.9 LOADOUT_INSTALL_DIR="$PWD/relbin" LOADOUT_DOWNLOAD_BASE="file://$PWD/rel" sh "$INSTALL_SH")
echo "$OUT" | grep -q "Next steps:" || fail "a first install prints the setup steps"
OUT=$(LOADOUT_VERSION=v9.9.9 LOADOUT_INSTALL_DIR="$PWD/relbin" LOADOUT_DOWNLOAD_BASE="file://$PWD/rel" sh "$INSTALL_SH")
echo "$OUT" | grep -q "Next steps:" && fail "an upgrade must not print first-install steps" || true
echo "$OUT" | grep -q "was v9.9.9" || fail "an upgrade names the version it replaced"
ok "install.sh tells a first install from an upgrade"
