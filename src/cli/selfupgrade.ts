import { latestRelease } from "../app/index.ts";
import { line } from "../core/exec/index.ts";
import { atLeast, installCommand, VERSION } from "../version.ts";
import type { Command } from "./args.ts";
import { exitWith } from "./errors.ts";
import { commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo } from "./spinner.ts";

/** newSelfUpgradeCmd is `loadout self-upgrade`: install.sh, unless already on the latest release. */
export function newSelfUpgradeCmd(): Command {
  return subcommand(
    "self-upgrade",
    commandHelp(
      "Replace the loadout binary with the latest release. Needs no config repo, so it works even under a min-tool-version refusal (`upgrade` is for programs).",
    ),
    [],
    async () => {
      const a = appCtx();
      const latest = await latestRelease(a.runner, false);
      if (latest !== "" && atLeast(VERSION, latest)) {
        echo("already on the latest release (v" + VERSION + ")");
        return;
      }
      const target = latest !== "" ? "v" + latest : "the latest release";
      echo("current: v" + VERSION + " — installing " + target + "…");
      const code = await a.runner.inherit(line(installCommand, ""));
      if (code !== 0) throw exitWith(code);
    },
  );
}
