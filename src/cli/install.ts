import type { Command } from "./args.ts";
import {
  askForSudoUpfront,
  confirmOrAbort,
  echoPlan,
  installFailures,
  installPrograms,
  planInstalls,
  planPrograms,
} from "./converge.ts";
import { exitWith, usageErr } from "./errors.ts";
import { boolFlag, commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo, spin } from "./spinner.ts";
import { Style } from "./style.ts";

/**
 * newInstallCmd is the targeted installer: named programs (or --all, this
 * machine's whole mapped membership), dependencies first. Scripts are
 * `run`'s job; programs *and* scripts together are `setup-new-machine`'s.
 */
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
    (_cmd, args, flags) => runInstall(args, flags.bool("all"), flags.bool("dry-run"), flags.bool("yes")),
  );
  boolFlag(cmd, "all", "", "Install every program mapped for this machine (same membership as setup-new-machine)");
  boolFlag(cmd, "dry-run", "", "Show what would run without doing it");
  boolFlag(cmd, "yes", "y", "Don't ask for confirmation");
  return cmd;
}

async function runInstall(names: string[], all: boolean, dryRun: boolean, yes: boolean): Promise<void> {
  const a = appCtx();
  const manifest = a.loadManifest();
  const system = a.detectSystem();
  if (all && names.length > 0) throw usageErr("Give program names or --all, not both");
  if (!all && names.length === 0) throw usageErr("Give at least one program, or --all");
  const unknown = names.filter((name) => !manifest.programs.has(name));
  if (unknown.length > 0) throw usageErr("Unknown programs: " + unknown.join(", "));

  const plan = await planPrograms(a, manifest, system, names);
  echoPlan(plan, system.machine, []);

  const installs = planInstalls(plan);
  if (installs.length === 0) {
    echo("\nNothing to do.");
    return;
  }
  if (dryRun) return;
  confirmOrAbort(yes);
  await askForSudoUpfront(
    a.runner,
    installs.some((item) => item.sudo),
  );

  const outcomes = await installPrograms(plan, manifest);

  echo("");
  await spin("updating state…", async () => {
    await a.refreshAndWriteState(manifest, system, new Map());
  });

  const { failed, skipped } = installFailures(outcomes);
  echo(" " + Style.ok("✔") + "  " + (outcomes.length - failed.length - skipped.length) + "/" + outcomes.length + " programs installed");
  if (failed.length > 0) echo(" " + Style.error("✘") + "  failed installs: " + failed.join(", "));
  if (skipped.length > 0) echo(" " + Style.error("✘") + "  skipped installs: " + skipped.join(", "));
  if (failed.length > 0 || skipped.length > 0) throw exitWith(1);
}
