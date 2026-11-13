import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { commandHelp, stringFlag } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): diff (internal/cli/diff.go) runs once src/app exists; it reads flags.changed("machines").
/** newDiffCmd is `loadout diff`: its help, flags and arguments as the Go binary's. */
export function newDiffCmd(): Command {
  const cmd = subcommand(
    "diff",
    commandHelp(
      "Compare all machines' state files: missing installs, version drift and drifted configs. Exits 1 when something is off.",
      "--machines a,b  narrow the comparison to those machines",
    ),
    [],
    notPorted("diff"),
  );
  stringFlag(cmd, "machines", "", "", "Comma-separated machine names to compare (default: all with a state file)");
  return cmd;
}
