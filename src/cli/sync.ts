import type { Command } from "./args.ts";
import { notPorted } from "./context.ts";
import { boolFlag, commandHelp, stringFlag } from "./help.ts";
import { subcommand } from "./root.ts";

// TODO(port): sync (internal/cli/sync.go) runs once src/app exists; --message counts when flags.changed("message").
/** newSyncCmd is `loadout sync`: its help, flags and arguments as the Go binary's. */
export function newSyncCmd(): Command {
  const cmd = subcommand(
    "sync",
    commandHelp(
      "Pull the config repo, apply its configs, refresh this machine's state, commit only its state file, push. When the pulled repo needs a newer loadout, upgrade loadout first and carry on with it. A child repo pulls its parent first (never commits or pushes it), and recompiles itself when the parent's manifests changed, committing the lock with the state.",
      "--no-push       commit locally, don't push",
      "-m, --message   override the commit message",
    ),
    [],
    notPorted("sync"),
  );
  boolFlag(cmd, "no-push", "", "Commit locally but don't push");
  stringFlag(cmd, "message", "m", "", "Commit message");
  return cmd;
}
