# Version floors, newer locks and state files, and install.sh (the release
# bootstrap).

kt_repo verrepo
kt_file verrepo/loadout.kt <<'KT'
val repo = repo(name = "test", state = "state", minToolVersion = "999.0.0")

val git = root.program("git") {
    version("git --version", "git version ([0-9.]+)")
    custom("manual") { command = "false" }
}
KT
compile_repo verrepo
OUT=$("$BIN" --repo verrepo status 2>&1 || true)
echo "$OUT" | grep -q "requires loadout >= 999.0.0" || fail "min-tool-version not enforced"
echo "$OUT" | grep -q "run: loadout self-upgrade" || fail "refusal should point at loadout self-upgrade"
"$BIN" --help | grep -q "self-upgrade" || fail "self-upgrade command should be registered"
ok "a repo's min-tool-version blocks an outdated binary with recovery hint"

# A lock compiled by a newer minor's DSL is refused the same way: it may
# say what this binary would misread.
kt_file verrepo/loadout.kt <<'KT'
val repo = repo(name = "test", state = "state")

val git = root.program("git") {
    version("git --version", "git version ([0-9.]+)")
    custom("manual") { command = "false" }
}

val m1 = machine("m1") { install(git) }
KT
compile_repo verrepo
cp verrepo/loadout.lock.json lock.good
sed 's/"toolVersion": "[^"]*"/"toolVersion": "999.0.0"/' lock.good > verrepo/loadout.lock.json
OUT=$("$BIN" --repo verrepo status 2>&1) && fail "a lock from a newer loadout must be refused"
echo "$OUT" | grep -q "was compiled by loadout 999.0.0" || fail "the newer lock is named: $OUT"
echo "$OUT" | grep -q "run: loadout self-upgrade" || fail "and points at self-upgrade: $OUT"
cp lock.good verrepo/loadout.lock.json
ok "a lock compiled by a newer loadout is refused with recovery hint"

cat > verrepo/state/future.json <<'JSON'
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
# but install.sh correctly picks macos-arm64).
mkdir -p rel/v9.9.9 relbuild/share/loadout/maven prefix/bin
printf '#!/bin/sh\ncase "$1" in --version) echo "loadout version 9.9.9";; *) echo help;; esac\n' > relbuild/loadout
chmod +x relbuild/loadout
echo 9.9.9 > relbuild/share/loadout/VERSION
for target in linux-x64 macos-arm64 macos-x64; do
    tar -czf "rel/v9.9.9/loadout-v9.9.9-$target.tar.gz" -C relbuild loadout share
done
OUT=$(LOADOUT_VERSION=v9.9.9 LOADOUT_INSTALL_DIR="$PWD/prefix/bin" LOADOUT_DOWNLOAD_BASE="file://$PWD/rel" sh "$INSTALL_SH")
echo "$OUT" | grep -q "Next steps:" || fail "a first install prints the setup steps"
[ -x prefix/bin/loadout ] || fail "the binary lands in the install dir"
grep -qx 9.9.9 prefix/share/loadout/VERSION || fail "the share dir lands beside the bin dir"
echo stale > prefix/share/loadout/stale.txt
OUT=$(LOADOUT_VERSION=v9.9.9 LOADOUT_INSTALL_DIR="$PWD/prefix/bin" LOADOUT_DOWNLOAD_BASE="file://$PWD/rel" sh "$INSTALL_SH")
echo "$OUT" | grep -q "Next steps:" && fail "an upgrade must not print first-install steps" || true
echo "$OUT" | grep -q "was v9.9.9" || fail "an upgrade names the version it replaced"
[ -e prefix/share/loadout/stale.txt ] && fail "an upgrade replaces the share dir whole" || true
ok "install.sh installs the binary and its share dir, and tells a first install from an upgrade"

# A release without its share dir is refused before anything is replaced.
mkdir -p rel/v9.9.8 relbare
cp relbuild/loadout relbare/loadout
for target in linux-x64 macos-arm64 macos-x64; do
    tar -czf "rel/v9.9.8/loadout-v9.9.8-$target.tar.gz" -C relbare loadout
done
OUT=$(LOADOUT_VERSION=v9.9.8 LOADOUT_INSTALL_DIR="$PWD/prefix/bin" LOADOUT_DOWNLOAD_BASE="file://$PWD/rel" sh "$INSTALL_SH" 2>&1) &&
    fail "a release without share/loadout must be refused"
echo "$OUT" | grep -q "no share/loadout directory" || fail "says what's missing: $OUT"
grep -qx 9.9.9 prefix/share/loadout/VERSION || fail "the installed share dir is left as it was"
ok "install.sh refuses a release without its share dir"
