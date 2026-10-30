# Version floors, newer locks and state files, and install.sh (the release
# bootstrap).

hcl_root verrepo <<'HCL'
program "git" {
  version = "git --version"
  regex   = "git version ([0-9.]+)"
  custom "manual" {
    command = "false"
  }
}
HCL
repo_attr verrepo/loadout.hcl 'min_tool_version = "999.0.0"'
compile_repo verrepo
OUT=$("$BIN" --repo verrepo status 2>&1 || true)
echo "$OUT" | grep -q "requires loadout >= 999.0.0" || fail "min-tool-version not enforced"
echo "$OUT" | grep -q "run: loadout self-upgrade" || fail "refusal should point at loadout self-upgrade"
"$BIN" --help | grep -q "self-upgrade" || fail "self-upgrade command should be registered"
ok "a repo's min-tool-version blocks an outdated binary with recovery hint"

# A lock compiled by a newer minor's loadout is refused the same way: it
# may say what this binary would misread.
hcl_root verrepo <<'HCL'
program "git" {
  version = "git --version"
  regex   = "git version ([0-9.]+)"
  custom "manual" {
    command = "false"
  }
}

machine "m1" {
  install = [program.git]
}
HCL
compile_repo verrepo
cp verrepo/loadout.lock.json lock.good
sed 's/"toolVersion": "[^"]*"/"toolVersion": "999.0.0"/' lock.good > verrepo/loadout.lock.json
OUT=$("$BIN" --repo verrepo status 2>&1) && fail "a lock from a newer loadout must be refused"
echo "$OUT" | grep -q "was compiled by loadout 999.0.0" || fail "the newer lock is named: $OUT"
echo "$OUT" | grep -q "run: loadout self-upgrade" || fail "and points at self-upgrade: $OUT"
# A field the newer minor added is never reached: the version is read first.
sed 's/"toolVersion": "[^"]*"/"toolVersion": "999.0.0"/; s/"manifest": {/"manifest": { "fromTheFuture": true,/' lock.good > verrepo/loadout.lock.json
OUT=$("$BIN" --repo verrepo status 2>&1) && fail "a newer lock with a field this binary lacks must be refused"
echo "$OUT" | grep -q "was compiled by loadout 999.0.0" || fail "it is refused by version, not by the field: $OUT"
cp lock.good verrepo/loadout.lock.json
ok "a lock compiled by a newer loadout is refused with recovery hint, before its body is read"

cat > verrepo/machines/state/future.json <<'JSON'
{"schemaVersion": 99, "machine": "future", "os": "linux", "arch": "x86_64",
 "toolVersion": "9.9.9", "updatedAt": "2027-01-01T00:00:00Z"}
JSON
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
# but install.sh correctly picks macos-arm64). A release is the binary
# alone: it needs no share directory.
mkdir -p rel/v9.9.9 relbuild prefix/bin
printf '#!/bin/sh\ncase "$1" in --version) echo "loadout version 9.9.9";; *) echo help;; esac\n' > relbuild/loadout
chmod +x relbuild/loadout
for target in linux-x64 linux-arm64 macos-arm64 macos-x64; do
    tar -czf "rel/v9.9.9/loadout-v9.9.9-$target.tar.gz" -C relbuild loadout
done
OUT=$(LOADOUT_VERSION=v9.9.9 LOADOUT_INSTALL_DIR="$PWD/prefix/bin" LOADOUT_DOWNLOAD_BASE="file://$PWD/rel" sh "$INSTALL_SH" 2>&1) ||
    fail "a release of the binary alone installs: $OUT"
echo "$OUT" | grep -q "Next steps:" || fail "a first install prints the setup steps"
[ -x prefix/bin/loadout ] || fail "the binary lands in the install dir"
[ -e prefix/share ] && fail "nothing but the binary is installed: $(find prefix/share)" || true
OUT=$(LOADOUT_VERSION=v9.9.9 LOADOUT_INSTALL_DIR="$PWD/prefix/bin" LOADOUT_DOWNLOAD_BASE="file://$PWD/rel" sh "$INSTALL_SH")
echo "$OUT" | grep -q "Next steps:" && fail "an upgrade must not print first-install steps" || true
echo "$OUT" | grep -q "was v9.9.9" || fail "an upgrade names the version it replaced"
ok "install.sh installs the binary alone, and tells a first install from an upgrade"

# An older loadout's share directory (its Kotlin DSL and Gradle plugin) is
# left as it was: install.sh never deletes what it no longer installs.
mkdir -p prefix/share/loadout/maven
echo 3.0.0 > prefix/share/loadout/VERSION
OUT=$(LOADOUT_VERSION=v9.9.9 LOADOUT_INSTALL_DIR="$PWD/prefix/bin" LOADOUT_DOWNLOAD_BASE="file://$PWD/rel" sh "$INSTALL_SH" 2>&1) ||
    fail "an upgrade over an old share dir installs: $OUT"
grep -qx 3.0.0 prefix/share/loadout/VERSION && [ -d prefix/share/loadout/maven ] || fail "the old share dir is left alone"
ok "install.sh leaves an older loadout's share directory alone"
