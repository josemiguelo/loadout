import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { commandHelp } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): explain (internal/cli/explain.go) runs once src/app exists.
/** newExplainCmd is `loadout explain`: its help, flags and arguments as the Go binary's. */
export function newExplainCmd(): Command {
  const cmd = subcommand(
    "explain",
    commandHelp(
      "Explain programs, scripts or configs: the fully expanded definition exactly as the engine sees it.",
      "[names...]  programs, scripts or configs (default: every program and script)",
    ),
    [{ name: "names", help: "Program, script or config names (default: every program and script)", optional: true, multiple: true }],
    notPorted("explain"),
  );
  return cmd;
}
