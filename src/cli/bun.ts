import { binVar, version, wrapperDir } from "../core/bun/bun.ts";
import { joinPath } from "../model/index.ts";
import { newShellRunner } from "../core/exec/index.ts";
import type { Command } from "./args.ts";
import { exitWith } from "./errors.ts";
import { commandHelp, printHelp } from "./help.ts";
import { subcommand } from "./root.ts";
import { Style } from "./style.ts";

/**
 * newBunCmd is `loadout bun [args…]`: loadout as the bun CLI it was built
 * with, the one its manifest commands and scripts run with. Every argument
 * goes to bun as it is (`loadout bun --help` is bun's help); stdio and the
 * exit code pass through. Needs no config repo.
 */
export function newBunCmd(): Command {
  const cmd = subcommand(
    "bun",
    commandHelp(
      "Run the bun built into loadout (" + version + "), which scripts run with. Every argument goes to bun: `loadout bun --help` is bun's help.",
    ),
    [{ name: "args", help: "bun's arguments", optional: true, multiple: true }],
    async (self, args) => {
      if (args.length === 0) {
        Style.init();
        printHelp(self);
        return;
      }
      const code = await newShellRunner().inherit({
        // Through the wrapper, as scripts run: a file gets its preload. Always
        // loadout's own bun, whatever $LOADOUT_BUN says.
        line: "exec " + [joinPath(wrapperDir(), "bun"), ...args].map(quote).join(" "),
        cwd: "",
        env: { [binVar]: "" },
      });
      if (code !== 0) throw exitWith(code < 0 ? 1 : code);
    },
  );
  cmd.passArgs = true;
  // Nothing of the root's: no config repo, no terminal queries before bun.
  cmd.persistentPreRun = async () => {};
  return cmd;
}

/** quote is s as one sh word. */
function quote(s: string): string {
  return "'" + s.replaceAll("'", `'\\''`) + "'";
}
