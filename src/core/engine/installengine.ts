import { installOrder } from "../../assemble/index.ts";
import { installed, missing, type ProgramState } from "../coremodel/coremodel.ts";
import type { CommandFrame, ProcessRunner } from "../exec/index.ts";
import { checkFor, dependenciesOf, type Manifest, resolveInstall, shellLine } from "../../model/index.ts";
import { ResolutionException } from "./errors.ts";
import { commandNeedsSudo } from "./sudo.ts";
import { bullets } from "./text.ts";
import type { VersionChecker } from "./versionchecker.ts";

/** PlanItem is one program of an install plan: an InstallItem or an InstalledItem. */
export type PlanItem = InstallItem | InstalledItem;

/** InstallItem will run command (the installKey entry of the program's install table). */
export interface InstallItem {
  kind: "install";
  program: string;
  installKey: string;
  command: string;
  /** origin is where command runs: its declaring file's repo-relative directory. */
  origin: string;
  /** sudo says command needs sudo's password: it runs sudo, or its variant or installer says so. */
  sudo: boolean;
}

/** InstalledItem is a program already installed at version; nothing to do. */
export interface InstalledItem {
  kind: "installed";
  program: string;
  version?: string;
}

/** InstallOutcome is one install's exit code and the program's state after it. */
export interface InstallOutcome {
  program: string;
  exitCode: number;
  /** stateAfter is the re-check after the install; undefined when it never ran. */
  stateAfter?: ProgramState;
  /**
   * skippedFor is the dependency that failed (or was itself skipped), when
   * this install never ran because of it; "" when it ran.
   */
  skippedFor: string;
}

/**
 * outcomeSuccess is exit 0 AND a re-check that no longer says missing
 * (contract 7); a skipped install never succeeds.
 */
export function outcomeSuccess(o: InstallOutcome): boolean {
  return o.skippedFor === "" && o.exitCode === 0 && o.stateAfter?.status !== missing;
}

/** installs is plan's InstallItems, in order. */
export function installs(plan: readonly PlanItem[]): InstallItem[] {
  return plan.filter((item): item is InstallItem => item.kind === "install");
}

/** InstallEngine plans and runs installs. */
export class InstallEngine {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly checker: VersionChecker,
    private readonly frame: CommandFrame,
  ) {}

  /**
   * plan resolves what would happen for requested programs (empty = every
   * program this machine's mapping opts into), expanded with their transitive
   * dependencies, in dependency order. A program the machine doesn't map is
   * simply not part of this machine's loadout — converge skips it.
   *
   * Strict resolution — a ResolutionException (before anything runs) when:
   *   - the manifest declares no such machine,
   *   - an explicitly requested program has no mapping for this machine,
   *   - a mapped program's dependency has no mapping for this machine,
   *   - a program that needs installing resolves to a probe binary (the
   *     variant's `probe`, or its installer's) that is not present on this
   *     machine (binaryAvailable, on PATH or where the variant providing it
   *     says it lands), unless a program installed before it in this plan
   *     `provides` that binary.
   */
  async plan(
    manifest: Manifest,
    machine: string,
    requested: readonly string[] | undefined,
    currentStates: ReadonlyMap<string, ProgramState>,
    binaryAvailable: (binary: string) => boolean | Promise<boolean>,
  ): Promise<PlanItem[]> {
    const config = manifest.machines.get(machine);
    if (config === undefined) {
      throw new ResolutionException("machine '" + machine + "' is not declared in the repo (add machine \"" + machine + "\" { … })");
    }
    const mapping = config.pm;
    const where = "install it in machine '" + machine + "' or a profile it extends";

    // Membership: converge covers only mapped programs. (Nothing requested
    // and nothing mapped leaves targets as requested was: undefined orders
    // every program.)
    let targets = requested;
    if (targets === undefined || targets.length === 0) {
      for (const name of manifest.programs.keys()) {
        if (mapping.has(name)) targets = [...(targets ?? []), name];
      }
    }
    const ordered = installOrder(manifest, targets, mapping);

    const errors: string[] = [];
    const items: PlanItem[] = [];
    for (const name of ordered) {
      const installKey = mapping.get(name);
      if (installKey === undefined) {
        if (requested?.includes(name)) {
          errors.push("program '" + name + "' isn't installed on machine '" + machine + "' (" + where + ")");
        } else {
          errors.push(
            "program '" + name + "' is required as a dependency but isn't installed on " + "machine '" + machine + "' (" + where + ")",
          );
        }
        continue;
      }
      const state = currentStates.get(name);
      if (state !== undefined && state.status === installed) {
        items.push(state.version === undefined ? { kind: "installed", program: name } : { kind: "installed", program: name, version: state.version });
        continue;
      }
      // Key existence and command resolvability are validated at manifest
      // load, as is the existence of any file: script.
      const resolved = resolveInstall(manifest, name, installKey);
      const command = shellLine(resolved.command ?? "", resolved.path);
      items.push({
        kind: "install",
        program: name,
        installKey,
        command,
        origin: resolved.commandOrigin,
        sudo: resolved.sudo || commandNeedsSudo(command),
      });
    }

    // Verify that every probe binary the plan actually needs exists here, or
    // is provided by a program the plan installs before it.
    const planned = installs(items);
    const binaries: string[] = [];
    const needing = new Map<string, string[]>();
    for (const item of planned) {
      const probe = resolveInstall(manifest, item.program, item.installKey).probe;
      if (probe === undefined) continue;
      if (!needing.has(probe)) binaries.push(probe);
      needing.set(probe, [...(needing.get(probe) ?? []), item.program]);
    }
    for (const binary of binaries) {
      const programs = needing.get(binary)!;
      let landed = false;
      for (const dir of manifest.toolPaths.get(binary) ?? []) {
        if (await binaryAvailable(dir + "/" + binary)) {
          landed = true;
          break;
        }
      }
      if (landed || (await binaryAvailable(binary))) continue;
      const first = planned.findIndex((item) => {
        const variant = manifest.programs.get(item.program)?.install.get(item.installKey);
        return variant?.provides.some((p) => p.binary === binary) ?? false;
      });
      // Only what installs after the first provider can count on it.
      let early = programs;
      if (first >= 0) {
        early = planned
          .slice(0, first + 1)
          .filter((item) => programs.includes(item.program))
          .map((item) => item.program);
      }
      if (early.length === 0) continue;
      if (first < 0) {
        errors.push(
          "required binary '" + binary + "' (needed to install " + early.join(", ") + ") " + "is not installed on machine '" + machine + "'",
        );
      } else {
        errors.push(
          "required binary '" + binary + "' (needed to install " + early.join(", ") + ") comes from " +
            "'" + planned[first]!.program + "', which would install after them " +
            "(make them depend on it, or have their installer require it)",
        );
      }
    }

    if (errors.length > 0) throw new ResolutionException("cannot build install plan:\n" + bullets(errors));
    return items;
  }

  /**
   * execute runs plan's InstallItems in order with inherited stdio,
   * re-checking each program's version afterwards. A failure doesn't abort the
   * run: independent installs go on. But an install whose dependency failed,
   * or was itself skipped, never runs (it could only fail, or half-work, for a
   * reason that isn't its own): its outcome names that dependency. Each outcome
   * is reported so the caller decides what to surface. onStart (undefined =
   * nothing) hears of each install as it starts, onSkip (undefined = nothing)
   * of each skipped one with the dependency it lacks.
   */
  execute(
    manifest: Manifest,
    plan: readonly PlanItem[],
    onStart?: (item: InstallItem) => void,
    onSkip?: (item: InstallItem, dependency: string) => void,
  ): Promise<InstallOutcome[]> {
    return this.executeAfter(manifest, plan, [], onStart, onSkip);
  }

  /**
   * executeAfter is execute continuing an earlier run in the same command
   * (setup-new-machine's later phase after its core one): an install whose
   * dependency failed or was skipped in earlier is skipped too. Only the new
   * outcomes are returned. An interrupted install rejects; the outcomes so
   * far are lost with it.
   */
  async executeAfter(
    manifest: Manifest,
    plan: readonly PlanItem[],
    earlier: readonly InstallOutcome[],
    onStart?: (item: InstallItem) => void,
    onSkip?: (item: InstallItem, dependency: string) => void,
  ): Promise<InstallOutcome[]> {
    const outcomes: InstallOutcome[] = [];
    const failed = new Map<string, boolean>();
    for (const o of earlier) failed.set(o.program, !outcomeSuccess(o));
    for (const item of installs(plan)) {
      const key = item.installKey;
      const missingDep = dependenciesOf(manifest, item.program, key).find((dep) => failed.get(dep) === true) ?? "";
      if (missingDep !== "") {
        onSkip?.(item, missingDep);
        failed.set(item.program, true);
        outcomes.push({ program: item.program, exitCode: -1, skippedFor: missingDep });
        continue;
      }
      onStart?.(item);
      // The declaring file's directory as cwd, so file: scripts and
      // relative paths behave the same wherever the tool was invoked.
      const exit = await this.runner.inherit(this.frame.command(item.command, item.origin));
      const after = await this.checker.check(checkFor(manifest, item.program, key));
      const outcome: InstallOutcome = { program: item.program, exitCode: exit, stateAfter: after, skippedFor: "" };
      failed.set(item.program, !outcomeSuccess(outcome));
      outcomes.push(outcome);
    }
    return outcomes;
  }
}

/** newInstallEngine is an engine running installs in frame and re-checking with checker. */
export function newInstallEngine(runner: ProcessRunner, checker: VersionChecker, frame: CommandFrame): InstallEngine {
  return new InstallEngine(runner, checker, frame);
}
