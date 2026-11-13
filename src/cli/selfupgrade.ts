import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { commandHelp } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): self-upgrade (internal/cli/selfupgrade.go) runs once src/app exists (app.LatestRelease).
/** newSelfUpgradeCmd is `loadout self-upgrade`: its help, flags and arguments as the Go binary's. */
export function newSelfUpgradeCmd(): Command {
  const cmd = subcommand(
    "self-upgrade",
    commandHelp(
      "Replace the loadout binary with the latest release. Needs no config repo, so it works even under a min-tool-version refusal (`upgrade` is for programs).",
    ),
    [],
    notPorted("self-upgrade"),
  );
  return cmd;
}
