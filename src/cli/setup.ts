import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { boolFlag, commandHelp } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): setup-new-machine (internal/cli/setup.go) runs once src/app exists.
/** newSetupCmd is `loadout setup-new-machine`: its help, flags and arguments as the Go binary's. */
export function newSetupCmd(): Command {
  const cmd = subcommand(
    "setup-new-machine",
    commandHelp(
      "Set up this machine: install every missing program, then run its setup scripts; what's marked later comes last.",
      "--dry-run       print the plan, execute nothing",
      "--yes           skip the confirmation",
      "--skip-scripts  programs only",
      "--skip-later    stop before the programs and scripts marked later",
    ),
    [],
    notPorted("setup-new-machine"),
  );
  boolFlag(cmd, "dry-run", "", "Show what would run without doing it");
  boolFlag(cmd, "yes", "y", "Don't ask for confirmation");
  boolFlag(cmd, "skip-scripts", "", "Don't run setup scripts");
  boolFlag(cmd, "skip-later", "", "Don't install or run what's marked later");
  return cmd;
}
