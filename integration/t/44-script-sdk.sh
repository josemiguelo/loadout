# The script SDK (`import … from "loadout/script"`): loadout provides it to
# the scripts it runs (compile writes only its types, in node_modules/@types/loadout), and a
# TypeScript script speaks loadout's protocols with it.

ts_repo repo
mkdir -p repo/programs/.loadout
cat > repo/programs/.loadout/marker.ts <<'TS'
// Done when its marker holds its word.
import { env, read } from "loadout/script";

const marker = `${env.fragmentDir}/marker.txt`;
export type Options = { word: string };
export async function check({ word }: Options) {
  return (await read(marker)).trim() === word;
}
export async function install({ word }: Options) {
  await Bun.write(marker, `${word}\n`);
  console.log(`marked ${word} on ${env.machine} (${env.os})`);
}
TS
cat > repo/programs/.loadout/marker.rules.ts <<'TS'
export const validate = ({ word }: { word: string }) => word === "" && "word is empty";
TS
cat > repo/programs/.loadout/broken.ts <<'TS'
#!/usr/bin/env bun
import { $, runStep } from "loadout/script";

async function step() {
  await $`sh -c ${"echo nope >&2; exit 3"}`.quiet();
}
await runStep(step);
TS
cat > repo/programs/.loadout/pins.ts <<'TS'
// An updates module: two pins behind, one moved by update(item).
import { env, type OutdatedItem } from "loadout/script";

const moved = `${env.fragmentDir}/moved.txt`;
export function listOutdated(): OutdatedItem[] {
  return [
    { item: "alpha", current: "1.0", candidate: "1.1", note: "a minor", link: "https://example.com/alpha" },
    { item: "beta", current: "2.0", candidate: "3.0" },
  ];
}
export async function update(item: string) {
  await Bun.write(moved, `${item}\n`);
}
TS
ts_file repo/programs/scripts.loadout.ts <<'TS'
export const marker = script("marker", {
  module: () => import("./.loadout/marker.ts"),
  rules: () => import("./.loadout/marker.rules.ts"),
  updates: { pins: () => import("./.loadout/pins.ts") },
});
export const broken = script("broken", { runCommand: runFile(".loadout/broken.ts") });
TS
ts_file repo/machines/m1.loadout.ts <<'TS'
import { broken, marker } from "../programs/scripts.loadout.ts";
machine("m1", { run: [marker({ word: "hello" }), broken] });
TS
compile_repo repo
grep -q '^declare module "loadout/script" {' repo/node_modules/@types/loadout/index.d.ts || fail "compile writes the script SDK's types: $(ls -R repo)"
[ -e repo/loadout.script.ts ] && fail "the script SDK itself stays in loadout"
ok "compile writes the script SDK's types (node_modules/@types/loadout), and the scripts import it from loadout"

TYPES=repo/node_modules/@types/loadout/index.d.ts
echo "// an older loadout's" > "$TYPES"
"$BIN" --repo repo --machine m1 machine status >/dev/null 2>&1 || true
grep -q '^declare module "loadout/script" {' "$TYPES" || fail "status puts this loadout's types back: $(head -3 "$TYPES")"
rm -rf repo/node_modules
"$BIN" --repo repo --machine m1 machine status >/dev/null 2>&1 || true
[ -f "$TYPES" ] || fail "status writes the types a fresh clone lacks"
ok "any command that reads the repo refreshes the SDKs' types"

OUT=$("$BIN" --repo repo --machine m1 script run marker 2>&1) || fail "a module runs: $OUT"
echo "$OUT" | grep -qE "marked hello on m1 \((linux|macos)\)" || fail "install() gets the machine's options and loadout's environment: $OUT"
grep -qx hello repo/programs/marker.txt || fail "it wrote its marker in its fragment's folder"
OUT=$("$BIN" --repo repo --machine m1 script run marker 2>&1)
echo "$OUT" | grep -q "already done" || fail "check() says it's done: $OUT"
ok "a module checks and installs with the machine's options and env"

OUT=$("$BIN" --repo repo --machine m1 script run broken 2>&1) && fail "a failing step succeeds: $OUT"
echo "$OUT" | grep -q "nope" || fail "run() says why it failed, from the command's stderr: $OUT"
ok "run() fails with the failing command's message"

"$BIN" --repo repo --machine m1 machine status >/dev/null 2>&1 || true
OUT=$("$BIN" --repo repo --machine m1 machine outdated 2>&1) || fail "outdated: $OUT"
echo "$OUT" | grep "alpha" | grep "1.0" | grep "1.1" | grep -q "https://example.com/alpha" || fail "rows() gives rows loadout reads, the link last: $OUT"
echo "$OUT" | grep "beta" | grep "2.0" | grep -q "3.0" || fail "a row without a note: $OUT"
"$BIN" --repo repo --machine m1 installer upgrade --item pins/beta --yes >/dev/null 2>&1 || fail "upgrade --item through update()"
grep -qx beta repo/programs/moved.txt || fail "update() got the item"
ok "an updates module gives its rows and updates one item"

# A script's implementation: a module whose check() and install() get the
# machine's options, whatever they hold.
ts_repo irepo
mkdir -p irepo/programs/.loadout
cat > irepo/programs/.loadout/words.ts <<'TS'
import { env, read } from "loadout/script";

if (import.meta.main) throw new Error("the runner is the main module, not this one");
const file = `${env.fragmentDir}/words.txt`;
export type Options = { words: string[]; loud?: boolean };
export const check = async (o: Options) => (await read(file)) === JSON.stringify(o);
export async function install(o: Options) {
  if (o.words.length === 0) throw new Error("no words");
  await Bun.write(file, JSON.stringify(o));
}
TS
cat > irepo/programs/.loadout/words.rules.ts <<'TS'
export const validate = (o: { words: string[] }) =>
  (o.words.includes("bad") && "bad word") || (o.words.length > 9 && "nine words at most");
TS
ts_file irepo/programs/scripts.loadout.ts <<'TS'
export const words = script("words", { module: () => import("./.loadout/words.ts"), rules: () => import("./.loadout/words.rules.ts") });
TS
ts_file irepo/machines/m.loadout.ts <<'TS'
import { words } from "../programs/scripts.loadout.ts";
machine("m1", { run: [words({ words: ["a  b", "it's", "$(touch pwned)", "x\ny", '"q"', "é"], loud: true })] });
machine("m2", { run: [words({ words: [] })] });
TS
compile_repo irepo
"$BIN" --repo irepo --machine m1 script run words >/dev/null || fail "an implementation installs"
WANT='{"words":["a  b","it'"'"'s","$(touch pwned)","x\ny","\"q\"","é"],"loud":true}'
[ "$(cat irepo/programs/words.txt)" = "$WANT" ] || fail "options arrive as written: $(cat irepo/programs/words.txt)"
[ -e irepo/programs/pwned ] && fail "an option is never run by the shell"
"$BIN" --repo irepo --machine m1 script run words | grep -q "already done" || fail "check() gets the same options"
OUT=$("$BIN" --repo irepo --machine m2 script run words 2>&1) && fail "a throw fails the script"
echo "$OUT" | grep -q "no words" || fail "a throw's message is shown: $OUT"
ok "an implementation's check and install get the machine's options, exactly as written"

echo "// edited" >> irepo/programs/.loadout/words.ts
"$BIN" --repo irepo --machine m1 script explain words >/dev/null || fail "editing an implementation leaves the lock good"
ok "an implementation isn't a source of the lock"

refuses() {
    ts_file irepo/programs/bad.loadout.ts
    OUT=$("$BIN" --repo irepo repo compile 2>&1) && fail "compile refuses: $1"
    echo "$OUT" | grep -qF "$1" || fail "wanted '$1', got: $OUT"
}
refuses "file '.loadout/none.ts' not found" <<'TS'
script("bad", { module: () => import("./.loadout/none.ts") } as any);
TS
refuses "bad.loadout.ts:3,1: script 'bad': module imports one file of the repo" <<'TS'
script("bad", { module: async () => ({ check: () => true, install() {} }) });
TS
refuses "module imports one file of the repo" <<'TS'
script("bad", { module: () => import("node:fs") } as any);
TS
refuses "module and runCommand can't go together" <<'TS'
script("bad", { module: () => import("./.loadout/words.ts"), runCommand: "true" } as any);
TS
refuses "options.f can't be written to the lock" <<'TS'
import { words } from "./scripts.loadout.ts";
words({ f: () => 1 } as any);
TS
refuses "bad.loadout.ts:4,1: script 'words': nine words at most" <<'TS'
import { words } from "./scripts.loadout.ts";
words({ words: [..."0123456789"] });
TS
refuses "script 'bad' takes options, so it needs rules" <<'TS'
const bad: any = script("bad", { module: () => import("./.loadout/words.ts") } as any);
bad({ words: [] });
TS
echo "export {};" > irepo/programs/.loadout/empty.rules.ts
refuses "script 'bad': its rules export no validate()" <<'TS'
const bad: any = script("bad", { module: () => import("./.loadout/words.ts"), rules: () => import("./.loadout/empty.rules.ts") } as any);
bad({ words: [] });
TS
refuses "scripts.bad.rules: file '.loadout/none.rules.ts' not found" <<'TS'
script("bad", { module: () => import("./.loadout/words.ts"), rules: () => import("./.loadout/none.rules.ts") } as any);
TS
refuses "script 'bad' has no setting 'managedBy'" <<'TS'
script("bad", { managedBy: "x.ts", runCommand: "true" } as any);
TS
refuses "program 'bad' via 'brew' has no setting 'managedBy'" <<'TS'
program("bad", { canBeInstalled: [withBrew({ managedBy: "x.ts" } as any)] });
TS
refuses "machine 'bad' has no setting 'runs'" <<'TS'
machine("bad", { runs: [] } as any);
TS
refuses "script 'bad' takes no options" <<'TS'
const bad: any = script("bad", { runCommand: "true" });
bad({ a: 1 });
TS
refuses "scripts.bad: file 'none.sh' not found" <<'TS'
script("bad", { runCommand: runFile("none.sh") });
TS
refuses "program 'bad' has no way to install named 'mac' (it has: linux)" <<'TS'
const bad: any = program("bad", { canBeInstalled: [withBrew, withCustomSteps("linux", { installCommand: "true", versionCommand: "true" })] });
bad("mac");
TS
refuses "installer 'brew' is called with programs or with settings" <<'TS'
(withBrew as any)();
TS
refuses "installer 'tapped' needs 'tap'" <<'TS'
const withTapped: any = installer("tapped", { neededBinary: "sh", installerParams: ["tap"], installCommand: "true {tap}", checkCommand: "true" });
program("bad", { canBeInstalled: [withTapped({ packageName: "x" })] });
TS
refuses "installer 'bad': 'packageName' is already a setting" <<'TS'
installer("bad", { installerParams: ["packageName"] });
TS
refuses "the file's path can't have spaces or quotes" <<'TS'
script("bad", { runCommand: runFile("x.sh check") });
TS
ok "compile refuses unknown settings, a missing module, one that isn't an import, and options that are wrong or not plain data"

# A module is found wherever its import is written, in whatever form, and
# compile never runs it.
rm irepo/programs/bad.loadout.ts
mkdir -p irepo/lib
printf 'await Bun.write(import.meta.dir + "/loaded-" + (process.env.LOADOUT_COMPILE ? "by-compile" : "by-run"), "x");\nexport const check = ({ n }: { n: number }) => n === 2;\nexport const install = () => {};\n' > irepo/lib/shared.ts
printf 'export const validate = () => undefined;\n' > irepo/lib/shared.rules.ts
cat > irepo/lib/shared-script.ts <<'TS'
import { script } from "loadout";
export const shared = (name: string) => script(name, { module: async () => { const m = await import("./shared.ts"); return m; }, rules: () => import("./shared.rules.ts") });
TS
ts_file irepo/programs/far.loadout.ts <<'TS'
import { shared } from "../lib/shared-script.ts";
export const far = shared("far");
machine("m3", { run: [far({ n: 2 })] });
machine("m4", { run: [far({ n: 1 })] });
TS
compile_repo irepo
[ -e irepo/lib/loaded-by-compile ] && fail "compile never runs a module"
"$BIN" --repo irepo --machine m3 script run far | grep -q "already done" || fail "a module from a helper's folder runs"
[ -e irepo/lib/loaded-by-run ] || fail "running it loads the module"
ok "a module's path is where its import is written, and compile never runs it"

# The rules come before check and install, whatever path the options took.
cp irepo/loadout.lock.json lock.bak
sed -i.bak 's/"a  b"/"bad"/' irepo/loadout.lock.json && rm irepo/loadout.lock.json.bak
OUT=$("$BIN" --repo irepo --machine m1 script check words 2>&1) && fail "check refuses what the rules do, even from a lock edited by hand: $OUT"
echo "$OUT" | grep -q "bad word" || fail "check says what validate said: $OUT"
rm -f irepo/programs/words.txt
OUT=$("$BIN" --repo irepo --machine m1 script run words --force 2>&1) && fail "install refuses what the rules do, even from a lock edited by hand: $OUT"
echo "$OUT" | grep -q "bad word" || fail "install says what validate said: $OUT"
[ -e irepo/programs/words.txt ] && fail "install never started"
sed -i.bak '/"rules": ".loadout\/words.rules.ts"/d' irepo/loadout.lock.json && rm irepo/loadout.lock.json.bak
"$BIN" --repo irepo --machine m1 script run words --force >/dev/null 2>&1 && fail "options without rules never run"
[ -e irepo/programs/words.txt ] && fail "install never started without rules"
cp lock.bak irepo/loadout.lock.json
echo "// edited" >> irepo/programs/.loadout/words.rules.ts
"$BIN" --repo irepo --machine m1 script explain words >/dev/null 2>&1 && fail "a rules file is a source of the lock"
compile_repo irepo
ok "a script's rules guard check and install, and are a source of the lock"

# check asks, and never installs.
rm -f irepo/programs/words.txt
OUT=$("$BIN" --repo irepo --machine m1 script check words) && fail "check exits 1 when it isn't done"
echo "$OUT" | grep -q "words  not done" || fail "check says not done: $OUT"
[ -e irepo/programs/words.txt ] && fail "check never installs"
"$BIN" --repo irepo --machine m3 script check --all | grep -q "far  done" || fail "check --all asks every script"
OUT=$("$BIN" --repo irepo --machine m4 script check far) && fail "check asks with this machine's options: $OUT"
"$BIN" --repo irepo --machine m4 script check far --options '{"n":2}' 2>&1 | grep -q "options" || fail "check takes no options of its own"
"$BIN" --repo irepo --machine m4 script check words 2>&1 | grep -q "is not run on machine 'm4'" || fail "check wants an opted-in script"
"$BIN" --repo irepo --machine m4 script explain far | grep -q "options.n *1" || fail "explain shows the options"
ok "check asks scripts with the machine's options, and installs nothing"
