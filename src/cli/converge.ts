// The program half of converging, shared by `install` and
// `setup-new-machine` — observe, plan, show, confirm, execute. The two
// commands differ in what they target and in what ELSE they do (scripts are
// setup's alone), never in this sequence; keeping it in one place is what
// stops one of them quietly growing a behavior the other lacks.

import type { AppContext } from "../app/index.ts";
import type { ProgramState, SystemInfo } from "../core/coremodel/coremodel.ts";
import * as engine from "../core/engine/index.ts";
import { line, type ProcessRunner } from "../core/exec/index.ts";
import { checkFor, type Manifest, type MachineConfig, newMachineConfig, shownLine, type VersionCheck } from "../model/index.ts";
import { exitWith } from "./errors.ts";
import { echo, echoErr, echoNoNewline, readLine, spinning } from "./spinner.ts";
import { Style } from "./style.ts";
import { padEnd, codePointCount } from "./table.ts";

/** ProgramPlan is what converging the programs would do, and the engine that does it. */
export interface ProgramPlan {
  engine: engine.InstallEngine;
  items: engine.PlanItem[];
}

/** planInstalls is p's install items. */
export function planInstalls(p: ProgramPlan): engine.InstallItem[] {
  return engine.installs(p.items);
}

/** machineOf is machine's config, an empty one (nothing mapped) when it isn't declared. */
export function machineOf(manifest: Manifest, machine: string): MachineConfig {
  return manifest.machines.get(machine) ?? newMachineConfig();
}

/**
 * planPrograms re-asks every check this machine's mapping covers (plus any
 * explicitly requested program), then resolves what would happen. Empty
 * requested = the machine's whole mapped membership.
 */
export async function planPrograms(
  a: AppContext,
  manifest: Manifest,
  system: SystemInfo,
  requested: readonly string[] | undefined,
): Promise<ProgramPlan> {
  const frame = await a.frame(system);
  const checker = engine.newVersionChecker(a.runner, frame);
  const installs = engine.newInstallEngine(a.runner, checker, frame);
  const mapped = machineOf(manifest, system.machine).pm;
  const checks = new Map<string, VersionCheck | undefined>();
  for (const name of manifest.programs.keys()) {
    const key = mapped.get(name);
    if (key === undefined && !(requested ?? []).includes(name)) continue;
    checks.set(name, checkFor(manifest, name, key));
  }
  const current: Map<string, ProgramState> = await spinning("checking current state…", () => checker.checkAll(checks));
  const items = await installs.plan(manifest, system.machine, requested, current, (b) => a.binaryAvailable(b));
  return { engine: installs, items };
}

/** ExtraRow is a step a command adds to the plan beyond programs (setup's scripts). */
export interface ExtraRow {
  name: string;
  label: string;
}

/**
 * echoPlan prints the plan. extraRows count toward the column width, so
 * the table stays one table.
 */
export function echoPlan(plan: ProgramPlan, machine: string, extraRows: readonly ExtraRow[]): void {
  echoSections(machine, [{ title: "", items: plan.items, extra: extraRows }]);
}

/**
 * PlanSection is a part of the plan under its own heading (setup's later
 * phase); the first section, untitled, is what runs first.
 */
export interface PlanSection {
  title: string;
  items: readonly engine.PlanItem[];
  extra: readonly ExtraRow[];
}

/**
 * echoSections prints the plan as one table across sections: one column
 * width, each titled section under its heading, an empty one left out.
 */
export function echoSections(machine: string, sections: readonly PlanSection[]): void {
  let nameWidth = 1;
  for (const s of sections) {
    for (const item of s.items) nameWidth = Math.max(nameWidth, codePointCount(item.program));
    for (const row of s.extra) nameWidth = Math.max(nameWidth, codePointCount(row.name));
  }
  echo("");
  echo(Style.header("Plan for ") + Style.machine(machine) + Style.header(":"));
  for (const s of sections) {
    if (s.items.length === 0 && s.extra.length === 0) continue;
    if (s.title !== "") echo(Style.header(s.title));
    for (const item of s.items) {
      if (item.kind === "install") {
        echo("  " + Style.warn("+") + " " + padEnd(item.program, nameWidth) + "  " + Style.dim("[" + item.installKey + "]") + " " + shownLine(item.command));
      } else {
        echo("  " + Style.ok("=") + " " + padEnd(item.program, nameWidth) + "  " + Style.dim(item.version ?? "installed"));
      }
    }
    for (const row of s.extra) {
      echo("  " + Style.accent("~") + " " + padEnd(row.name, nameWidth) + "  " + Style.dim(row.label));
    }
  }
}

/**
 * confirmOrAbort is the [y/N] gate. `--yes` skips it; anything but y/yes
 * aborts with exit 1.
 */
export function confirmOrAbort(yes: boolean): void {
  if (yes) return;
  echoNoNewline("\nProceed? [y/N] ");
  const answer = (readLine() ?? "").toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    echo("Aborted.");
    throw exitWith(1);
  }
}

/**
 * askForSudoUpfront asks for sudo's password once, now, before the first
 * step, when needed (a step of the run needs it), instead of in the middle
 * of the run whenever sudo's credentials have run out. Then it keeps them
 * fresh until loadout exits (engine.sudoKeepalive): a step an hour in finds
 * them as valid as the first. Nothing is asked when they're still valid.
 * Refusing stops the run before anything ran.
 */
export async function askForSudoUpfront(runner: ProcessRunner, needed: boolean): Promise<void> {
  if (!needed) return;
  if (!(await engine.sudoValid(runner))) {
    echo("\n" + Style.accent("A step needs your sudo password."));
    const code = await runner.inherit(line("sudo -v", ""));
    if (code !== 0) {
      echoErr("Aborted: the steps that need sudo can't run without it.");
      throw exitWith(1);
    }
  }
  await engine.startSudoKeepalive(runner);
}

/** installPrograms runs the plan, announcing each install as it starts. */
export function installPrograms(plan: ProgramPlan, manifest: Manifest): Promise<engine.InstallOutcome[]> {
  return installProgramsAfter(plan, manifest, []);
}

/**
 * installProgramsAfter is installPrograms continuing earlier outcomes of the
 * same command: what depends on a failed or skipped install is skipped.
 */
export function installProgramsAfter(
  plan: ProgramPlan,
  manifest: Manifest,
  earlier: readonly engine.InstallOutcome[],
): Promise<engine.InstallOutcome[]> {
  return plan.engine.executeAfter(
    manifest,
    plan.items,
    earlier,
    (item) => echo("\n" + Style.accent("==> installing " + item.program)),
    (item, dependency) =>
      echo("\n" + Style.accent("==> skipping " + item.program) + Style.dim(" (needs " + dependency + ", which didn't install)")),
  );
}

/**
 * installFailures is outcomes' failed installs and, apart, the skipped ones as
 * "name (needs dependency)".
 */
export function installFailures(outcomes: readonly engine.InstallOutcome[]): { failed: string[]; skipped: string[] } {
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const o of outcomes) {
    if (o.skippedFor !== "") skipped.push(o.program + " (needs " + o.skippedFor + ")");
    else if (!engine.outcomeSuccess(o)) failed.push(o.program);
  }
  return { failed, skipped };
}
