// devcompile is a dev tool for the port, removed at cutover: it runs
// compile on the repo given as argument and prints what `loadout compile`
// would (the warnings, or one `error: ` line), for differential runs
// against the Go binary until src/cli has the real command.
//
//   LOADOUT_BUN=$(command -v bun) bun src/compile/devcompile.ts <repo>

import { newShellRunner } from "../core/exec/runner.ts";
import { isRefusal } from "../model/index.ts";
import { compile } from "./compile.ts";

const root = process.argv[2];
if (root === undefined) {
  console.error("usage: bun src/compile/devcompile.ts <repo>");
  process.exit(2);
}
try {
  const warnings = await compile(root, newShellRunner());
  console.log(" ✔  wrote loadout.lock.json");
  for (const w of warnings) console.log(" !  " + w);
} catch (e) {
  console.error("error: " + (isRefusal(e) ? e.message : (e as Error).message));
  process.exit(1);
}
