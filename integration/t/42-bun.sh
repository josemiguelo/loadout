# loadout is the bun: a `bun` wrapper (BUN_BE_BUN=1 exec <loadout>) in
# $XDG_DATA_HOME/loadout/bin, first on PATH for every manifest command and
# for compile's run of loadout.ts, ahead of a `provides … at` folder.
# `loadout bun` is that bun; $LOADOUT_BUN overrides it; a repo pins none.
# run-tests.sh leaves LOADOUT_BUN unset, so the suite runs this way throughout.

mkdir -p otherbin
printf '#!/bin/sh\necho "the other bun ran"\n' > otherbin/bun
chmod +x otherbin/bun

ts_root repo <<TS
// Compile runs loadout.ts with loadout itself, whatever bun PATH holds.
if (process.execPath !== "$BIN") throw new Error("loadout.ts ran with " + process.execPath);

// A program whose provides folder holds a bun of its own, as brew's bin can.
const brewish = program("brewish", {
  install: [custom({ command: "true", provides: { brewish: { at: "$PWD/otherbin" } } })],
  version: "echo 1.0",
});

const hello = script("hello", { file: "hello.ts" });

const inline = script("inline", { run: "bun inline.ts" });

const env = script("env", { run: "echo \"bun dir=[\$LOADOUT_BUN_DIR]\"" });

machine("m1", { install: [brewish], run: [hello, inline, env] });
TS
# What a script starts is itself, not bun: BUN_BE_BUN doesn't reach it.
STARTS='console.log("it started " + require("node:child_process").execFileSync(process.execPath, ["--version"]).toString().trim())'
printf '#!/usr/bin/env bun\nconsole.log("hello ran with " + process.execPath + " as bun " + Bun.version)\n%s\n' "$STARTS" > repo/hello.ts
printf 'console.log("inline ran with " + process.execPath)\n%s\n' "$STARTS" > repo/inline.ts
PATH="$PWD/otherbin:$PATH" compile_repo repo
grep -q '"bun"' repo/loadout.lock.json && fail "the lock records no bun"
ok "compile runs loadout.ts with loadout itself as bun, even with another bun first on PATH"

VERSION=$("$BIN" bun --version) || fail "loadout bun --version: $VERSION"
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "loadout bun --version prints bun's version: $VERSION"
[ "$("$BIN" bun -e 'console.log(Bun.version)')" = "$VERSION" ] || fail "loadout bun is the bun it says it is"
ok "loadout bun --version prints the bun loadout was built with"

"$BIN" bun -e 'process.exit(3)' && fail "loadout bun passes the exit code through"
[ $? -eq 3 ] || fail "loadout bun exits with bun's code"
[ "$(echo piped | "$BIN" bun -e 'process.stdin.pipe(process.stdout)')" = "piped" ] || fail "loadout bun passes stdin and stdout through"
OUT=$("$BIN" bun --help) || fail "loadout bun --help: $OUT"
echo "$OUT" | grep -q "Usage: bun <command>" || fail "loadout bun --help is bun's help: $OUT"
OUT=$("$BIN" bun) || fail "loadout bun: $OUT"
echo "$OUT" | grep -q "Usage: loadout bun \[<args>\]" || fail "bare loadout bun is its own help: $OUT"
"$BIN" --help | grep -q "Run the bun built into loadout ($VERSION)" || fail "help lists loadout bun"
ok "loadout bun passes arguments, stdio and the exit code through, and has help of its own"

OUT=$("$BIN" --repo repo --machine m1 run hello 2>&1) || fail "run hello: $OUT"
echo "$OUT" | grep -q "hello ran with $BIN as bun $VERSION" || fail "the script ran with loadout as bun, not the provides folder's: $OUT"
WRAPPER=$XDG_DATA_HOME/loadout/bin/bun
echo "$OUT" | grep -q "it started loadout version" || fail "the loadout a script started was loadout, not bun: $OUT"
[ -x "$WRAPPER" ] || fail "the wrapper is in XDG_DATA_HOME/loadout/bin"
grep -q "BUN_BE_BUN=1 exec '$BIN'" "$WRAPPER" || fail "the wrapper runs this loadout as bun: $(cat "$WRAPPER")"
ok "a #!/usr/bin/env bun script runs with loadout as bun, ahead of a provides folder"

OUT=$("$BIN" --repo repo --machine m1 run inline env 2>&1) || fail "run inline env: $OUT"
echo "$OUT" | grep -q "inline ran with $BIN" || fail "an inline line finds loadout's bun first on PATH: $OUT"
echo "$OUT" | grep -q "it started loadout version" || fail "the loadout an inline bun started was loadout, not bun: $OUT"
echo "$OUT" | grep -q "bun dir=\[$XDG_DATA_HOME/loadout/bin\]" || fail "LOADOUT_BUN_DIR is the wrapper's folder: $OUT"
OUT=$("$BIN" bun repo/inline.ts) || fail "loadout bun inline.ts: $OUT"
echo "$OUT" | grep -q "it started loadout version" || fail "the loadout a file run by loadout bun started was loadout: $OUT"
ok "an inline command finds loadout's bun first on PATH"

printf '#!/bin/sh\necho stale\n' > "$WRAPPER"
"$BIN" --repo repo --machine m1 run hello >/dev/null 2>&1 || fail "run with a stale wrapper"
grep -q "BUN_BE_BUN=1 exec '$BIN'" "$WRAPPER" || fail "a wrapper that differs is rewritten: $(cat "$WRAPPER")"
ok "a wrapper for another loadout is rewritten"

OUT=$(LOADOUT_BUN="$PWD/otherbin/bun" "$BIN" --repo repo --machine m1 run hello 2>&1) || fail "run with LOADOUT_BUN: $OUT"
echo "$OUT" | grep -q "the other bun ran" || fail "LOADOUT_BUN runs the scripts: $OUT"
mkdir -p logbin
printf '#!/bin/sh\necho ran >> "%s/logbin/log"\nBUN_BE_BUN=1 exec "%s" "$@"\n' "$PWD" "$BIN" > logbin/bun
chmod +x logbin/bun
sed -i.bak '/process.execPath !==/d' repo/root.loadout.ts && rm repo/root.loadout.ts.bak
OUT=$(LOADOUT_BUN="$PWD/logbin/bun" "$BIN" --repo repo compile 2>&1) || fail "compile with LOADOUT_BUN: $OUT"
grep -q ran logbin/log || fail "compile ran loadout.ts with LOADOUT_BUN"
OUT=$(LOADOUT_BUN="$PWD/nope" "$BIN" --repo repo --machine m1 run hello 2>&1) && fail "a LOADOUT_BUN that isn't there runs: $OUT"
echo "$OUT" | grep -q "error: LOADOUT_BUN=$PWD/nope isn't an executable bun" || fail "the refusal names it: $OUT"
ok "LOADOUT_BUN overrides loadout's bun, for compile and scripts"

repo_opt repo/loadout.ts 'bun: "1.4.3"'
OUT=$("$BIN" --repo repo compile 2>&1) && fail "a repo that pins a bun compiles: $OUT"
echo "$OUT" | grep -q "error: loadout.ts:[0-9]*,[0-9]*: repo's bun is gone: scripts run with the bun loadout is built with ($VERSION), so drop it" ||
    fail "the refusal says it's gone and why: $OUT"
ok "compile refuses a repo that still pins a bun"

awk '{ print } /"meta": \{/ { print "      \"bun\": \"1.4.3\"," }' repo/loadout.lock.json > lock.tmp && mv lock.tmp repo/loadout.lock.json
grep -q '"bun": "1.4.3"' repo/loadout.lock.json || fail "fixture: a lock that pins a bun"
OUT=$("$BIN" --repo repo --machine m1 status 2>&1) && fail "a lock that pins a bun is read: $OUT"
echo "$OUT" | grep -q "loadout.lock.json can't be read (Encountered an unknown key 'bun' at path: .* — run: loadout compile" ||
    fail "a lock that pins a bun asks for a compile: $OUT"
ok "a lock that still pins a bun is refused until the repo compiles"
