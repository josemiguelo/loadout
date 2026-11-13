import { installed, type ProgramState } from "../core/coremodel/coremodel.ts";
import * as engine from "../core/engine/index.ts";
import { cut, shownLine, sortStrings } from "../model/index.ts";
import type { Command } from "./args.ts";
import { askForSudoUpfront, confirmOrAbort } from "./converge.ts";
import { exitWith, usageErr } from "./errors.ts";
import { boolFlag, commandHelp, stringsFlag } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo, echoErr, spinning } from "./spinner.ts";
import { Style } from "./style.ts";

/**
 * newUpgradeCmd is the one verb that moves installed programs to newer
 * versions, and it moves them a whole mechanism at a time: `dnf upgrade
 * -y`, not a package list. Converge installs what's MISSING and never
 * upgrades (contract 15).
 */
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
    (_cmd, args, flags) => runUpgrade(args, flags.bool("all"), flags.strings("item"), flags.bool("dry-run"), flags.bool("yes")),
  );
  boolFlag(cmd, "all", "", "Every mechanism this machine uses");
  stringsFlag(cmd, "item", "", "One item of a custom outdated source, as <source>/<name>");
  boolFlag(cmd, "dry-run", "", "Show the commands without running them");
  boolFlag(cmd, "yes", "y", "Don't ask for confirmation");
  return cmd;
}

async function runUpgrade(names: string[], all: boolean, items: string[], dryRun: boolean, yes: boolean): Promise<void> {
  const a = appCtx();
  if (all && names.length > 0) throw usageErr("Give installer names or --all, not both");
  if (!all && names.length === 0 && items.length === 0) throw usageErr("Give at least one installer, --all, or --item <source>/<name>");
  // Items run one at a time, grouped by source, in the order given.
  const bySource = new Map<string, string[]>();
  for (const given of items) {
    const [source, item, found] = cut(given, "/");
    if (!found || source === "" || item === "") throw usageErr("--item takes <source>/<name>, not '" + given + "'");
    bySource.set(source, [...(bySource.get(source) ?? []), item]);
  }

  const manifest = a.loadManifest();
  const system = a.detectSystem();
  const store = a.stateStore();
  const before: ReadonlyMap<string, ProgramState> = store.read(system.machine)?.programs ?? new Map();
  for (const w of store.lastWarnings()) echoErr("warning: " + w);

  for (const source of bySource.keys()) {
    if (!manifest.outdated.has(source)) {
      throw usageErr("Unknown outdated source '" + source + "' (sources are the manifest's outdated.* tables)");
    }
  }
  // A program with its own upgrade command is upgraded alone; every other
  // name is a mechanism, planned whole.
  const programs: string[] = [];
  let targets: string[] = [];
  if (all) {
    targets = [...engine.upgradableInstallers(manifest, system.machine).keys()];
  } else {
    for (const name of names) {
      const p = manifest.programs.get(name);
      if (p?.outdated?.upgrade !== undefined) programs.push(name);
      else targets.push(name);
    }
  }
  if (targets.length === 0 && programs.length === 0 && bySource.size === 0) {
    echo(Style.dim("No mechanism on " + system.machine + " declares an upgrade command."));
    return;
  }
  const plan = engine.planUpgrade(manifest, system.machine, targets);
  plan.push(...engine.planProgramUpgrades(manifest, system.machine, programs));
  for (const [source, sourceItems] of bySource) plan.push(...engine.planSourceItems(manifest, source, sourceItems));

  echo("");
  echo(Style.header("Upgrade on ") + Style.machine(system.machine) + Style.header(":"));
  let sweep = false;
  let needsSudo = false;
  for (const step of plan) {
    echo("  " + Style.warn("↑") + " " + Style.dim("[" + engine.stepLabel(step) + "]") + " " + shownLine(step.command));
    if (step.covers.length > 0) {
      echo("      " + Style.dim("covers " + step.covers.length + " mapped program(s): " + step.covers.join(", ")));
    }
    sweep = sweep || step.sweep;
    needsSudo = needsSudo || step.sudo;
  }
  echo("");
  // A whole-mechanism upgrade touches everything that mechanism has, not
  // only what this repo declares. Say so before it runs.
  if (sweep) echo(Style.dim("  This upgrades everything each mechanism manages — including packages loadout doesn't declare."));
  if (dryRun) return;
  confirmOrAbort(yes);
  await askForSudoUpfront(a.runner, needsSudo);

  // Inherited stdio: sudo may prompt, dnf shows progress. A failing
  // mechanism doesn't stop the rest — they're independent.
  const frame = await a.frame(system);
  const failed: string[] = [];
  for (const step of plan) {
    echo("\n" + Style.accent("==> upgrading " + engine.stepLabel(step)));
    const code = await a.runner.inherit(frame.command(step.command, step.origin));
    if (code !== 0) failed.push(engine.stepLabel(step));
  }

  echo("");
  // The transaction moved what it moved: re-observe everything, the same
  // way `status` does, and say what changed.
  const after = await spinning("re-checking every program…", () => a.refreshAndWriteState(manifest, system, new Map()));
  const changed: string[] = [];
  for (const [name, now] of after.programs) {
    const was = before.get(name)?.version;
    if (now.status === installed && now.version !== undefined && (was === undefined || now.version !== was)) changed.push(name);
  }
  sortStrings(changed);
  echo(" " + Style.ok("✔") + "  " + changed.length + " declared program(s) changed version");
  for (const name of changed) {
    const was = before.get(name)?.version ?? "?";
    echo("      " + name + Style.dim("  " + was + " -> ") + Style.warn(after.programs.get(name)!.version!));
  }
  if (failed.length > 0) {
    echo(" " + Style.error("✘") + "  failed: " + failed.join(", "));
    throw exitWith(1);
  }
}
