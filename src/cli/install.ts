import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { boolFlag, commandHelp } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): install (internal/cli/install.go) runs once src/app exists.
/** newInstallCmd is `loadout install`: its help, flags and arguments as the Go binary's. */
export function newInstallCmd(): Command {
  const cmd = subcommand(
    "install",
    commandHelp(
      "Install the named programs on this machine, dependencies first.",
      "<programs...>  programs from the manifest (+ depends-on)",
      "--all          every program this machine maps, instead of names",
      "--dry-run      print the plan, execute nothing",
      "--yes          skip the confirmation",
    ),
    [{ name: "programs", help: "Programs to install", optional: true, multiple: true }],
    notPorted("install"),
  );
  boolFlag(cmd, "all", "", "Install every program mapped for this machine (same membership as setup-new-machine)");
  boolFlag(cmd, "dry-run", "", "Show what would run without doing it");
  boolFlag(cmd, "yes", "y", "Don't ask for confirmation");
  return cmd;
}
