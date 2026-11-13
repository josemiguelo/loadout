// loadout, the TypeScript port: dispatches to the CLI (src/cli). Compiled by
// bun into one executable per target (package.json's build). Until the port
// reaches parity, the Go binary (cmd/loadout) is the reference.
import { VERSION } from "./version.ts";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(`loadout version ${VERSION}`);
  process.exit(0);
}
console.error("error: the TypeScript port doesn't run commands yet");
process.exit(1);
