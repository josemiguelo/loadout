import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { boolFlag, commandHelp } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): run (internal/cli/run.go) runs once src/app exists.
/** newRunCmd is `loadout run`: its help, flags and arguments as the Go binary's. */
export function newRunCmd(): Command {
  const cmd = subcommand(
    "run",
    commandHelp(
      "Run the named scripts from the manifest.",
      "<scripts...>  script names (must be opted in by this machine)",
      "--all         every script this machine opts into, instead of names",
      "--force       run even when the check already passes",
    ),
    [{ name: "scripts", help: "Script names from the manifest", optional: true, multiple: true }],
    notPorted("run"),
  );
  boolFlag(cmd, "all", "", "Run every script this machine opts into (modes ignored, like any run)");
  boolFlag(cmd, "force", "", "Run even if the script's check passes");
  return cmd;
}
