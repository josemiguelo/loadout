import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { boolFlag, commandHelp, stringsFlag } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): upgrade (internal/cli/upgrade.go) runs once src/app exists.
/** newUpgradeCmd is `loadout upgrade`: its help, flags and arguments as the Go binary's. */
export function newUpgradeCmd(): Command {
  const cmd = subcommand(
    "upgrade",
    commandHelp(
      "Upgrade everything a package manager on this machine manages — the whole mechanism, never single packages (the binary itself is `self-upgrade`).",
      "<installers...>  which mechanisms to upgrade (dnf, brew, flatpak, ...)",
      "--all            every mechanism this machine's mapping uses",
      "--item <source>/<name>  one item of an outdated.<source> (a tmux plugin, a pinned tool); repeatable",
      "--dry-run        print the commands, run nothing",
      "--yes            skip the confirmation",
    ),
    [{ name: "installers", help: "Installers to upgrade", optional: true, multiple: true }],
    notPorted("upgrade"),
  );
  boolFlag(cmd, "all", "", "Every mechanism this machine uses");
  stringsFlag(cmd, "item", "", "One item of a custom outdated source, as <source>/<name>");
  boolFlag(cmd, "dry-run", "", "Show the commands without running them");
  boolFlag(cmd, "yes", "y", "Don't ask for confirmation");
  return cmd;
}
