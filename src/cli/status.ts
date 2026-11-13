import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { boolFlag, commandHelp } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): status (internal/cli/status.go) runs once src/app exists.
/** newStatusCmd is `loadout status`: its help, flags and arguments as the Go binary's. */
export function newStatusCmd(): Command {
  const cmd = subcommand(
    "status",
    commandHelp(
      "Observe this machine: every program version and script check re-asked, drift explained, state file updated.",
      "--json      print the full state as JSON",
      "--no-write  observe without touching the state file",
    ),
    [],
    notPorted("status"),
  );
  boolFlag(cmd, "json", "", "Print the machine state as JSON");
  boolFlag(cmd, "no-write", "", "Don't update the state file");
  return cmd;
}
