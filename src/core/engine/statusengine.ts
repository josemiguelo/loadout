import {
  type ConfigState,
  done,
  type MachineState,
  newMachineState,
  pending,
  type ProgramState,
  schemaVersion,
  type ScriptState,
  type SystemInfo,
  unknown,
} from "../coremodel/coremodel.ts";
import { type CommandFrame, line, type ProcessRunner, success } from "../exec/index.ts";
import { nowIso } from "../platform/platform.ts";
import { checkFor, compareStrings, isBlank, type Manifest, scriptArgs, shellLine, sortedStrings, type VersionCheck } from "../../model/index.ts";
import { VERSION } from "../../version.ts";
import type { ConfigEngine } from "./configengine.ts";
import { withArgs } from "./scriptrunner.ts";
import { lines } from "./text.ts";
import { limiter, parallelism, type VersionChecker } from "./versionchecker.ts";

/** ToolDown is a tool the checks go through that couldn't answer this time. */
export interface ToolDown {
  tool: string;
  /** programs is the programs whose checks it left unanswered. */
  programs: string[];
  /** onPath: `command -v` finds it: it's there but its checks fail anyway. */
  onPath: boolean;
}

/** toolDownMessage is one line for a person: the fact, and what it cost. */
export function toolDownMessage(t: ToolDown): string {
  const fact = t.onPath ? t.tool + " is on PATH but its checks fail" : t.tool + " is not on PATH";
  return fact + " — " + t.programs.length + " program(s) not checked";
}

/** PartKind names a Part's subject. */
export type PartKind = "programs" | "scripts" | "configs";

export const partPrograms: PartKind = "programs";
export const partScripts: PartKind = "scripts";
export const partConfigs: PartKind = "configs";

/**
 * Part is one subject of a refresh, observed: programs (with the tools their
 * checks couldn't reach), scripts (with their checks' detail) or configs
 * (with chezmoi's reason when it couldn't answer). err says that part
 * failed; the refresh then fails with it. Fields of other subjects are empty.
 */
export interface Part {
  kind: PartKind;
  programs: Map<string, ProgramState>;
  toolsDown: ToolDown[];
  scripts: Map<string, ScriptState>;
  detail: Map<string, string>;
  configs: Map<string, ConfigState>;
  configsDown?: string;
  err?: unknown;
}

function newPart(p: Partial<Part> & { kind: PartKind }): Part {
  return { programs: new Map(), toolsDown: [], scripts: new Map(), detail: new Map(), configs: new Map(), ...p };
}

/**
 * StatusEngine builds this machine's MachineState by observing it: every
 * program's version check runs, every applicable script's `check` command
 * runs, and chezmoi reports the config units (ConfigEngine). All checks are
 * read-only, so they run concurrently (bounded), scripts and configs
 * overlapping with programs — one slow check no longer serializes `status`.
 */
export class StatusEngine {
  private configsDown: string | undefined;
  private scriptDetail = new Map<string, string>();
  private toolsDownLast: ToolDown[] = [];

  /** configs observes config units; undefined when the repo has no `layout configs`. */
  constructor(
    private readonly checker: VersionChecker,
    private readonly runner: ProcessRunner,
    private readonly frame: CommandFrame,
    private readonly configs: ConfigEngine | undefined,
  ) {}

  /** lastConfigsDown is why configs went unchecked during the last refresh (chezmoi's answer), or undefined. */
  lastConfigsDown(): string | undefined {
    return this.configsDown;
  }

  /**
   * lastScriptDetail is what each failing script check printed during the
   * last refresh — the "missing: ..." detail managing scripts' checks emit.
   * Same surfacing pattern as StateStore.lastWarnings: read it right after the call.
   */
  lastScriptDetail(): Map<string, string> {
    return this.scriptDetail;
  }

  /**
   * lastToolsDown is the tools whose checks could not run during the last
   * refresh, each with the programs left unchecked and whether the tool is on
   * PATH at all (asked once per tool with `command -v`). "brew is not on PATH
   * — 21 programs not checked" is one line to a person; the per-row reasons
   * only say which rows.
   */
  lastToolsDown(): ToolDown[] {
    return this.toolsDownLast;
  }

  /**
   * refresh observes the machine. scriptRuns are results of scripts the tool
   * just executed; their lastRun/exitCode history is kept, but a script's
   * `check` has the final word on its status:
   *   - check exits 0 -> done (whether or not the tool ever ran it)
   *   - check fails   -> pending (even right after a run — the check is the truth)
   *   - no check      -> only actual run history can be recorded
   *
   * Only scripts this machine opted into (its `scripts` list) are observed.
   */
  refresh(
    manifest: Manifest,
    system: SystemInfo,
    previous: MachineState | undefined,
    scriptRuns: ReadonlyMap<string, ScriptState>,
  ): Promise<MachineState> {
    return this.refreshParts(manifest, system, previous, scriptRuns, undefined);
  }

  /**
   * refreshParts is refresh, also handing each subject to onPart the moment
   * its own checks finish (programs, scripts and configs run side by side),
   * so a screen can settle each one on its own. onPart is called once per
   * subject this machine has; undefined = refresh. The returned state is
   * still the whole observation, made when all are in; a failed part fails
   * it, once every part is in (programs' error first, then configs', then
   * scripts').
   */
  async refreshParts(
    manifest: Manifest,
    system: SystemInfo,
    previous: MachineState | undefined,
    scriptRuns: ReadonlyMap<string, ScriptState>,
    onPart: ((p: Part) => void) | undefined,
  ): Promise<MachineState> {
    const emit = (p: Part) => onPart?.(p);
    // Membership: only programs this machine maps are part of its loadout,
    // each checked with the version check its mapped key resolves to.
    const config = manifest.machines.get(system.machine);
    const mapped = config?.pm ?? new Map<string, string>();
    const observedChecks = new Map<string, VersionCheck | undefined>();
    for (const name of manifest.programs.keys()) {
      const key = mapped.get(name);
      if (key !== undefined) observedChecks.set(name, checkFor(manifest, name, key));
    }

    const programsTask = (async () => {
      let programs = new Map<string, ProgramState>();
      let toolsDown: ToolDown[] = [];
      let err: unknown;
      try {
        programs = await this.checker.checkAll(observedChecks);
        toolsDown = await this.toolsDown(manifest, observedChecks, programs);
      } catch (e) {
        err = e ?? new Error("refresh failed");
      }
      emit(newPart({ kind: partPrograms, programs, toolsDown, err }));
      return { programs, toolsDown, err };
    })();

    const configs = this.configs;
    const configsTask =
      configs === undefined
        ? Promise.resolve({ configStates: new Map<string, ConfigState>(), err: undefined as unknown })
        : (async () => {
            let configStates = new Map<string, ConfigState>();
            let err: unknown;
            try {
              configStates = await configs.observe(previous?.configs ?? new Map());
            } catch (e) {
              err = e ?? new Error("refresh failed");
            }
            emit(newPart({ kind: partConfigs, configs: configStates, configsDown: configs.lastReason(), err }));
            return { configStates, err };
          })();

    interface ScriptObservation {
      name: string;
      state?: ScriptState;
      detail?: string;
      err?: unknown;
    }
    const observed: ScriptObservation[] = [];
    const checks: Promise<void>[] = [];
    const gate = limiter(parallelism);
    for (const [name, args] of config !== undefined ? scriptArgs(config) : new Map<string, string>()) {
      const step = manifest.scripts.get(name);
      if (step === undefined) continue;
      let history = scriptRuns.get(name);
      if (history === undefined && previous !== undefined) history = previous.scripts.get(name);
      const o: ScriptObservation = { name };
      if (step.check !== undefined) {
        const check = withArgs(step.check, args, step.path);
        observed.push(o);
        checks.push(
          gate(async () => {
            try {
              const result = await this.runner.capture(this.frame.command(check, step.origin));
              const state: ScriptState = { status: success(result) ? done : pending };
              if (history !== undefined) {
                if (history.lastRun !== undefined) state.lastRun = history.lastRun;
                if (history.exitCode !== undefined) state.exitCode = history.exitCode;
              }
              o.state = state;
              if (!success(result)) {
                const detail = lines(result.stdout + result.stderr)
                  .filter((l) => !isBlank(l))
                  .join("\n");
                if (!isBlank(detail)) o.detail = detail;
              }
            } catch (e) {
              o.err = e ?? new Error("refresh failed");
            }
          }),
        );
      } else if (history !== undefined) {
        o.state = history;
        observed.push(o);
      }
    }
    // Scripts are one part: they land together, when the last check is in.
    const scriptsTask = (async () => {
      await Promise.all(checks);
      const detail = new Map<string, string>();
      const scripts = new Map<string, ScriptState>();
      let err: unknown;
      for (const o of observed) {
        if (o.err !== undefined) {
          err = o.err;
          break;
        }
        scripts.set(o.name, o.state!);
        if (o.detail !== undefined) detail.set(o.name, o.detail);
      }
      emit(newPart({ kind: partScripts, scripts, detail, err }));
      return { scripts, detail, err };
    })();

    const [p, c, s] = await Promise.all([programsTask, configsTask, scriptsTask]);
    for (const err of [p.err, c.err, s.err]) if (err !== undefined) throw err;
    this.scriptDetail = s.detail;
    this.toolsDownLast = p.toolsDown;
    this.configsDown = this.configs?.lastReason();
    return newMachineState({
      schemaVersion,
      machine: system.machine,
      os: system.os,
      distro: system.distro,
      arch: system.arch,
      toolVersion: VERSION,
      updatedAt: nowIso(),
      programs: p.programs,
      scripts: s.scripts,
      configs: c.configStates,
    });
  }

  /**
   * toolsDown groups the checks that couldn't run by the tool they asked
   * through, then asks about each tool ONCE: absent, or present but failing
   * (a wrapper that exits 126, say).
   */
  private async toolsDown(
    manifest: Manifest,
    observedChecks: ReadonlyMap<string, VersionCheck | undefined>,
    programs: ReadonlyMap<string, ProgramState>,
  ): Promise<ToolDown[]> {
    const byTool = new Map<string, string[]>();
    for (const [name, state] of programs) {
      if (state.status !== unknown || state.reason === undefined) continue;
      const probe = observedChecks.get(name)?.probe;
      if (probe !== undefined && probe !== "") byTool.set(probe, [...(byTool.get(probe) ?? []), name]);
    }
    const down: ToolDown[] = [];
    for (const [tool, names] of byTool) {
      const found = await this.runner.capture(line(shellLine("command -v " + tool, manifest.toolPaths.get(tool)), ""));
      down.push({ tool, programs: sortedStrings(names), onPath: success(found) });
    }
    return down.sort((a, b) => compareStrings(a.tool, b.tool));
  }
}

/** newStatusEngine is an observer; configs is undefined without `layout configs`. */
export function newStatusEngine(
  checker: VersionChecker,
  runner: ProcessRunner,
  frame: CommandFrame,
  configs: ConfigEngine | undefined,
): StatusEngine {
  return new StatusEngine(checker, runner, frame, configs);
}
