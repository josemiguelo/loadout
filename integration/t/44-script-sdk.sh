# The script SDK (`import … from "loadout/script"`): loadout provides it to
# the scripts it runs (compile writes only its types, in loadout.d.ts), and a
# TypeScript script speaks loadout's protocols with it.

ts_repo repo
mkdir -p repo/programs/.loadout
cat > repo/programs/.loadout/marker.ts <<'TS'
#!/usr/bin/env bun
// A managed script: done when its marker holds its argument.
import { env, main, read } from "loadout/script";

const marker = `${env.fragmentDir}/marker.txt`;
async function ready(word: string) {
  return (await read(marker)).trim() === word;
}
async function install(word: string) {
  await Bun.write(marker, `${word}\n`);
  console.log(`marked ${word} on ${env.machine} (${env.os})`);
}
await main(ready, install);
TS
cat > repo/programs/.loadout/broken.ts <<'TS'
#!/usr/bin/env bun
import { $, run } from "loadout/script";

async function step() {
  await $`sh -c ${"echo nope >&2; exit 3"}`.quiet();
}
await run(step);
TS
cat > repo/programs/.loadout/pins.ts <<'TS'
#!/usr/bin/env bun
// An outdated source: two pins behind, one moved by update <item>.
import { env, oracle } from "loadout/script";

const moved = `${env.fragmentDir}/moved.txt`;
async function rows() {
  return [
    { item: "alpha", current: "1.0", candidate: "1.1", note: "a minor", link: "https://example.com/alpha" },
    { item: "beta", current: "2.0", candidate: "3.0" },
  ];
}
async function update(item: string) {
  await Bun.write(moved, `${item}\n`);
}
await oracle({ rows, update });
TS
ts_file repo/programs/scripts.loadout.ts <<'TS'
export const marker = script("marker", { managedBy: ".loadout/marker.ts" });
export const broken = script("broken", { file: ".loadout/broken.ts" });
outdated("pins", { command: runScript(".loadout/pins.ts"), upgrade: runScript(".loadout/pins.ts update {item}") });
TS
ts_file repo/machines/m1.loadout.ts <<'TS'
import { broken, marker } from "../programs/scripts.loadout.ts";
machine("m1", { run: [args(marker, "hello"), broken] });
TS
compile_repo repo
grep -q '^declare module "loadout/script" {' repo/loadout.d.ts || fail "compile writes the script SDK's types into loadout.d.ts: $(head -20 repo/loadout.d.ts)"
[ -e repo/loadout.script.ts ] && fail "the script SDK itself stays in loadout"
ok "compile writes the script SDK's types (loadout.d.ts), and the scripts import it from loadout"

OUT=$("$BIN" --repo repo --machine m1 run marker 2>&1) || fail "a managed script runs: $OUT"
echo "$OUT" | grep -qE "marked hello on m1 \((linux|macos)\)" || fail "main() installs with the machine's argument and loadout's environment: $OUT"
grep -qx hello repo/programs/marker.txt || fail "it wrote its marker in its fragment's folder"
OUT=$("$BIN" --repo repo --machine m1 run marker 2>&1)
echo "$OUT" | grep -q "already done" || fail "main()'s check says it's done: $OUT"
ok "a managed script in TypeScript checks and installs through main(), with the machine's arguments and env"

OUT=$("$BIN" --repo repo --machine m1 run broken 2>&1) && fail "a failing step succeeds: $OUT"
echo "$OUT" | grep -q "nope" || fail "run() says why it failed, from the command's stderr: $OUT"
ok "run() fails with the failing command's message"

"$BIN" --repo repo --machine m1 status >/dev/null 2>&1 || true
OUT=$("$BIN" --repo repo --machine m1 outdated 2>&1) || fail "outdated: $OUT"
echo "$OUT" | grep "alpha" | grep "1.0" | grep "1.1" | grep -q "https://example.com/alpha" || fail "oracle() prints rows loadout reads, the link last: $OUT"
echo "$OUT" | grep "beta" | grep "2.0" | grep -q "3.0" || fail "a row without a note: $OUT"
"$BIN" --repo repo --machine m1 upgrade --item pins/beta --yes >/dev/null 2>&1 || fail "upgrade --item through oracle()'s update"
grep -qx beta repo/programs/moved.txt || fail "oracle()'s update got the item"
ok "an outdated source in TypeScript prints its rows and updates one item through oracle()"
