# The repo's bun (`repo({ bun: "…" })`): downloaded on first use, checked,
# first on PATH for every manifest command, ahead of a `provides … at` folder.
# Compiles run with the suite's LOADOUT_BUN (run-tests.sh); what tests the
# download runs through bl, without it.

# sha256 <file>: its hex digest (GNU sha256sum, or macOS's shasum).
sha256() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# bun_release <dir> <version>: a release folder as bun publishes one, every
# platform's zip holding a stub bun that says which version ran what.
bun_release() {
    mkdir -p "$1/stage/bun-stub"
    printf '#!/bin/sh\necho "bun %s ran: $*"\n' "$2" > "$1/stage/bun-stub/bun"
    chmod +x "$1/stage/bun-stub/bun"
    (cd "$1/stage" && zip -qr ../stub.zip bun-stub)
    : > "$1/SHASUMS256.txt"
    for asset in bun-linux-x64 bun-linux-x64-baseline bun-linux-aarch64 bun-darwin-aarch64 bun-darwin-x64 bun-darwin-x64-baseline; do
        cp "$1/stub.zip" "$1/$asset.zip"
        echo "$(sha256 "$1/$asset.zip")  $asset.zip" >> "$1/SHASUMS256.txt"
    done
}

# bl <release dir> <args…>: loadout with its buns in ./data, downloaded
# from the release dir: LOADOUT_BUN emptied, so it names no bun of its own.
# Per command, never exported: the test files share one shell.
bl() {
    rel=$1
    shift
    LOADOUT_BUN= XDG_DATA_HOME="$PWD/data" LOADOUT_BUN_DOWNLOAD_BASE="file://$PWD/$rel" "$BIN" "$@"
}

bun_release rel130 1.3.0
bun_release rel131 1.3.1
mkdir -p otherbin
printf '#!/bin/sh\necho "the other bun ran"\n' > otherbin/bun
chmod +x otherbin/bun

ts_root repo <<TS
// A program whose provides folder holds a bun of its own, as brew's bin can.
const brewish = program("brewish", {
  install: [custom({ command: "true", provides: { brewish: { at: "$PWD/otherbin" } } })],
  version: "echo 1.0",
});

const hello = script("hello", { file: "hello.ts" });

const inline = script("inline", { run: "bun inline.ts" });

machine("m1", { install: [brewish], run: [hello, inline] });
TS
printf '#!/usr/bin/env bun\nconsole.log("hi")\n' > repo/hello.ts
repo_opt repo/loadout.ts 'bun: "latest"'
OUT=$("$BIN" --repo repo compile 2>&1) && fail "a bun that isn't a version compiles: $OUT"
echo "$OUT" | grep -q "meta bun 'latest' is not a dotted version number" || fail "the refusal names it: $OUT"
ok "compile refuses a bun pin that isn't a dotted version"

sed -i.bak 's/bun: "latest"/bun: "1.3.0"/' repo/loadout.ts && rm repo/loadout.ts.bak
compile_repo repo
grep -q '"bun": "1.3.0"' repo/loadout.lock.json || fail "the lock records the pin"
OUT=$(bl rel130 --repo repo --machine m1 run hello 2>&1) || fail "run with the repo's bun: $OUT"
echo "$OUT" | grep -q "bun 1.3.0 ran: hello.ts" || fail "the script ran with the repo's bun, not the provides folder's: $OUT"
[ -x data/loadout/bun/1.3.0/bun ] || fail "bun is kept in XDG_DATA_HOME/loadout/bun/<version>"
ok "a #!/usr/bin/env bun script runs with the repo's bun, downloaded on first use, ahead of a provides folder"

OUT=$(bl rel130 --repo repo --machine m1 run inline 2>&1) || fail "an inline line runs: $OUT"
echo "$OUT" | grep -q "bun 1.3.0 ran: inline.ts" || fail "an inline line finds the repo's bun first on PATH: $OUT"
ok "an inline command finds the repo's bun first on PATH"

OUT=$(bl gone --repo repo --machine m1 run hello 2>&1) || fail "run once bun is there needs no download: $OUT"
echo "$OUT" | grep -q "bun 1.3.0 ran" || fail "the kept bun runs: $OUT"
ok "a bun already downloaded is used without asking the release again"

OUT=$(bl rel130 --repo repo --machine m1 status 2>&1) || fail "status: $OUT"
echo "$OUT" | grep -q "scripts run with bun 1.3.0" || fail "status names the scripts' bun: $OUT"
ok "status says which bun scripts run with"

sed -i.bak 's/bun: "1.3.0"/bun: "1.3.1"/' repo/loadout.ts && rm repo/loadout.ts.bak
compile_repo repo
OUT=$(bl rel131 --repo repo --machine m1 run hello 2>&1) || fail "run after moving the pin: $OUT"
echo "$OUT" | grep -q "bun 1.3.1 ran" || fail "the new pin runs: $OUT"
[ -d data/loadout/bun/1.3.0 ] && fail "the previous bun stays after the pin moved"
ok "moving the pin downloads the new bun and removes the old one"

bun_release rel132 1.3.2
echo "0000000000000000000000000000000000000000000000000000000000000000  bun-linux-x64.zip" > rel132/SHASUMS256.txt
for asset in bun-linux-x64-baseline bun-linux-aarch64 bun-darwin-aarch64 bun-darwin-x64 bun-darwin-x64-baseline; do
    echo "0000000000000000000000000000000000000000000000000000000000000000  $asset.zip" >> rel132/SHASUMS256.txt
done
sed -i.bak 's/bun: "1.3.1"/bun: "1.3.2"/' repo/loadout.ts && rm repo/loadout.ts.bak
compile_repo repo
OUT=$(bl rel132 --repo repo --machine m1 run hello 2>&1) && fail "a download that doesn't match its checksum runs: $OUT"
echo "$OUT" | grep -q "error: couldn't install bun 1.3.2: bun-.*\.zip doesn't match its checksum in SHASUMS256.txt" || fail "the error says why: $OUT"
[ -e data/loadout/bun/1.3.2 ] && fail "a bad download is kept"
[ -x data/loadout/bun/1.3.1/bun ] || fail "the working bun stays when the new one is refused"
ok "a bun that doesn't match its checksum is refused, keeping nothing"

sed -i.bak 's/bun: "1.3.2"/bun: "1.3.1"/' repo/loadout.ts && rm repo/loadout.ts.bak
compile_repo repo
mkdir -p fakecurl
cat > fakecurl/curl <<'EOF'
#!/bin/sh
case "$*" in
    *oven-sh/bun/releases/latest*) echo '"tag_name": "bun-v1.4.0"' ;;
    *api.github.com*) echo '"tag_name": "v0.0.1"' ;;
    *) exit 22 ;;
esac
EOF
chmod +x fakecurl/curl
OUT=$(PATH="$PWD/fakecurl:$PATH" bl rel131 --repo repo --machine m1 outdated 2>&1) || fail "outdated: $OUT"
echo "$OUT" | grep "bun" | grep "1.3.1" | grep "1.4.0" | grep -q "repo.bun" || fail "outdated shows the pin behind bun's latest: $OUT"
ok "outdated says when the repo's bun is behind bun's latest release"

ts_root plain <<'TS'
const env = script("env", { run: "echo \"bun dir=[$LOADOUT_BUN_DIR]\"" });

machine("m1", { run: [env] });
TS
compile_repo plain
OUT=$(bl rel131 --repo plain --machine m1 run env 2>&1) || fail "a repo without a pin runs: $OUT"
echo "$OUT" | grep -q "bun dir=\[\]" || fail "a repo without a pin sets no bun folder: $OUT"
[ -e data/loadout/bun/1.3.1 ] || fail "a repo without a pin leaves another repo's bun alone"
ok "a repo that pins no bun runs its commands with the machine's own PATH"
