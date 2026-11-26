import { scriptOrder } from "../assemble/index.ts";
import { failed as scriptFailed, type ScriptState } from "../core/coremodel/coremodel.ts";
import * as engine from "../core/engine/index.ts";
import { runsIn, scriptOptions } from "../model/index.ts";
import type { Command } from "./args.ts";
import {
  askForSudoUpfront,
  confirmOrAbort,
  echoSections,
  type ExtraRow,
  installFailures,
  installPrograms,
  installProgramsAfter,
  machineOf,
  planInstalls,
  planPrograms,
  type ProgramPlan,
} from "./converge.ts";
import { exitWith } from "./errors.ts";
import { refuseEdited, withSudo } from "./apply-config.ts";
import { boolFlag, commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo, spin } from "./spinner.ts";
import { Style } from "./style.ts";

/** newSetupCmd is `loadout setup-new-machine`. */
export function newSetupCmd(): Command {
  const cmd = subcommand(
    "setup-new-machine",
    commandHelp(
      "Set up this machine: install every missing program, then run its setup scripts; what's marked later comes last.",
      "--dry-run       print the plan, execute nothing",
      "--yes           skip the confirmation",
      "--skip-scripts  programs only",
      "--skip-later    stop before the programs and scripts marked later",
    ),
    [],
    (_cmd, _args, flags) => runSetup(flags.bool("dry-run"), flags.bool("yes"), flags.bool("skip-scripts"), flags.bool("skip-later")),
  );
  boolFlag(cmd, "dry-run", "", "Show what would run without doing it");
  boolFlag(cmd, "yes", "y", "Don't ask for confirmation");
  boolFlag(cmd, "skip-scripts", "", "Don't run setup scripts");
  boolFlag(cmd, "skip-later", "", "Don't install or run what's marked later");
  return cmd;
}

/**
 * runSetup converges in two phases: core (programs, then scripts), then
 * later (the programs and scripts marked `later`, programs then scripts),
 * so a slow, optional step never holds up the rest. Compile refuses a core
 * step that waits on a later one, so the order holds.
 */
async function runSetup(dryRun: boolean, yes: boolean, skipScripts: boolean, skipLater: boolean): Promise<void> {
  const a = appCtx();
  const manifest = a.loadManifest();
  const system = a.detectSystem();

  const plan = await planPrograms(a, manifest, system, undefined);
  const frame = await a.frame(system);
  const scripts = engine.newScriptRunner(a.runner, frame);
  const enabled = scriptOptions(machineOf(manifest, system.machine));
  const coreScripts: string[] = [];
  let laterScripts: string[] = [];
  if (!skipScripts) {
    for (const name of scriptOrder(manifest, [...enabled.keys()])) {
      const step = manifest.scripts.get(name)!;
      if (!enabled.has(name) || !runsIn(step, "setup")) continue;
      if (step.later !== "") laterScripts.push(name);
      else coreScripts.push(name);
    }
  }
  const core: ProgramPlan = { engine: plan.engine, items: [] };
  const later: ProgramPlan = { engine: plan.engine, items: [] };
  for (const item of plan.items) {
    if (manifest.programs.get(item.program)!.later !== "") later.items.push(item);
    else core.items.push(item);
  }
  // What tool folders put outside $HOME lands after the core programs (so
  // no package overwrites it) and before the core scripts (which may read it).
  // Asked before anything is installed, chezmoi may not be there yet, or
  // reading them may need sudo: then they're one row, worked out after the
  // core programs.
  const configs = a.configs();
  const hasRoot = configs !== undefined && configs.sourceList().some((s) => s.root !== undefined);
  let rootDrift: Map<string, string[]> | undefined = new Map();
  if (hasRoot) {
    try {
      rootDrift = await configs!.rootDrift();
    } catch (e) {
      if (!(e instanceof engine.ConfigException)) throw e;
      rootDrift = undefined;
    }
  }
  const rootTargets = rootDrift === undefined ? [] : [...rootDrift.values()].flat();
  const configRows: ExtraRow[] =
    rootDrift === undefined ? [{ name: "configs outside $HOME", label: "config" }] : [...rootDrift.keys()].map((name) => ({ name, label: "config" }));
  const laterTitle = skipLater ? "Later, skipped (--skip-later):" : "Later, after everything above:";
  echoSections(system.machine, [
    { title: "", items: core.items, extra: [...configRows, ...scriptRows(coreScripts)] },
    { title: laterTitle, items: later.items, extra: scriptRows(laterScripts) },
  ]);
  if (skipLater) {
    later.items = [];
    laterScripts = [];
  }

  if (
    planInstalls(core).length === 0 && planInstalls(later).length === 0 && coreScripts.length === 0 && laterScripts.length === 0 &&
    rootTargets.length === 0 && rootDrift !== undefined
  ) {
    echo("\nNothing to do.");
    return;
  }
  if (dryRun) return;
  confirmOrAbort(yes);
  // One password for both phases, kept fresh until the later phase ends.
  if (configs !== undefined && rootTargets.length > 0) await withSudo(a.runner, () => refuseEdited(configs, rootTargets));
  let needsSudo =
    rootDrift === undefined || (configs !== undefined && rootTargets.length > 0 && (await withSudo(a.runner, () => configs.rootNeedsSudo(rootTargets))));
  for (const item of [...planInstalls(core), ...planInstalls(later)]) needsSudo = needsSudo || item.sudo;
  for (const name of [...coreScripts, ...laterScripts]) {
    if (needsSudo) break;
    const step = manifest.scripts.get(name)!;
    const args = enabled.get(name) ?? "";
    if (scripts.needsSudo(step, args)) needsSudo = await scripts.pending(step, false, args);
  }
  await askForSudoUpfront(a.runner, needsSudo);

  const results = new Map<string, ScriptState>();
  const runScripts = async (names: readonly string[]) => {
    for (const name of names) {
      const outcome = await scripts.run(manifest.scripts.get(name)!, false, enabled.get(name) ?? "");
      if (outcome.alreadyDone) {
        echo("\n" + Style.accent("==> script " + name + ":") + " already done " + Style.dim("(check passed)"));
        continue;
      }
      echo("\n" + Style.accent("==> ran script " + name) + " (exit " + exitText(outcome.state!.exitCode) + ")");
      results.set(name, outcome.state!);
    }
  };

  let outcomes = await installPrograms(core, manifest);
  if (configs !== undefined && hasRoot) {
    // Worked out now when it couldn't be before (chezmoi just installed).
    const drift = rootDrift ?? (await withSudo(a.runner, () => configs.rootDrift()));
    const targets = [...drift.values()].flat();
    if (targets.length > 0) {
      if (rootDrift === undefined) await refuseEdited(configs, targets);
      echo("\n" + Style.accent("==> configs " + [...drift.keys()].join(", ")));
      const code = await a.runner.inherit(await configs.applyCommand(targets, false));
      if (code !== 0) throw new engine.ConfigException("chezmoi apply failed (exit " + code + ")");
    }
  }
  await runScripts(coreScripts);
  if (planInstalls(later).length > 0 || laterScripts.length > 0) {
    echo(
      "\n" +
        Style.header("==> later: what can wait") +
        Style.dim(" (the rest of the machine is set up; run this again to finish if you stop it)"),
    );
    const laterOutcomes = await installProgramsAfter(later, manifest, outcomes);
    outcomes = [...outcomes, ...laterOutcomes];
    await runScripts(laterScripts);
  }

  echo("");
  await spin("updating state…", async () => {
    await a.refreshAndWriteState(manifest, system, results);
  });

  const failedScripts: string[] = [];
  const { failed: failedInstalls, skipped: skippedInstalls } = installFailures(outcomes);
  const succeeded = outcomes.length - failedInstalls.length - skippedInstalls.length;
  for (const [name, s] of results) {
    if (s.status === scriptFailed) failedScripts.push(name);
  }
  echo(" " + Style.ok("✔") + "  " + succeeded + "/" + outcomes.length + " programs installed, " + results.size + " scripts run");
  if (failedInstalls.length > 0) echo(" " + Style.error("✘") + "  failed installs: " + failedInstalls.join(", "));
  if (skippedInstalls.length > 0) echo(" " + Style.error("✘") + "  skipped installs: " + skippedInstalls.join(", "));
  if (failedScripts.length > 0) echo(" " + Style.error("✘") + "  failed scripts: " + failedScripts.join(", "));
  if (failedInstalls.length > 0 || skippedInstalls.length > 0 || failedScripts.length > 0) throw exitWith(1);
}

/** scriptRows is names as the plan's script rows. */
function scriptRows(names: readonly string[]): ExtraRow[] {
  return names.map((name) => ({ name, label: "script" }));
}

/** exitText is a recorded exit code as a run line prints it ("null" for none). */
export function exitText(code: number | undefined): string {
  return code === undefined ? "null" : String(code);
}
