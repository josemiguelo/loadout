import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { boolFlag, commandHelp } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): apply (internal/cli/apply.go) runs once src/app exists.
/** newApplyCmd is `loadout apply`: its help, flags and arguments as the Go binary's. */
export function newApplyCmd(): Command {
  const cmd = subcommand(
    "apply",
    commandHelp(
      "Write the repo's configs to this machine (chezmoi apply), then refresh its state.",
      "<configs...>  config names as status lists them (default: all)",
      "--force       also replace files edited on this machine",
    ),
    [{ name: "configs", help: "Config names, as status lists them", optional: true, multiple: true }],
    notPorted("apply"),
  );
  boolFlag(cmd, "force", "", "Replace files edited on this machine");
  return cmd;
}
