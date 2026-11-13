import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { commandHelp } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): installers (internal/cli/installers.go) runs once src/app exists.
/** newInstallersCmd is `loadout installers`: its help, flags and arguments as the Go binary's. */
export function newInstallersCmd(): Command {
  const cmd = subcommand(
    "installers",
    commandHelp(
      "Show the install mechanisms available to this repo: loadout's built-ins plus your own.",
      "[name]     print one installer's full definition",
    ),
    [{ name: "name", help: "Installer to describe", optional: true }],
    notPorted("installers"),
  );
  return cmd;
}
