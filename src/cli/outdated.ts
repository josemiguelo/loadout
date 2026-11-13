import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { commandHelp } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): outdated (internal/cli/outdated.go) runs once src/app exists.
/** newOutdatedCmd is `loadout outdated`: its help, flags and arguments as the Go binary's. */
export function newOutdatedCmd(): Command {
  const cmd = subcommand(
    "outdated",
    commandHelp(
      "Ask each program's remote source (dnf/brew/flathub/...) for newer versions — the loadout binary included.",
    ),
    [],
    notPorted("outdated"),
  );
  return cmd;
}
