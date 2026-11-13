// Package app is what the CLI and the home screen share (the app context,
// the outdated query, the command a home-screen run starts, explain, the self-version check):
// the services every command and the screen use, and the Screen interface
// the home screen implements. Neither side owns these twice, and neither
// imports the other.

import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import * as bun from "../core/bun/bun.ts";
import type { MachineState, ScriptState, SystemInfo } from "../core/coremodel/coremodel.ts";
import { type Detection, newDetection } from "../core/detect/detect.ts";
import * as engine from "../core/engine/index.ts";
import { type CommandFrame, frameOf, newShellRunner, type ProcessRunner } from "../core/exec/index.ts";
import * as loader from "../core/loader/loader.ts";
import { envVar } from "../core/platform/platform.ts";
import { newStateStore, type StateStore } from "../core/state/index.ts";
import { dirFS, forMachine, goPathError, type Manifest, plus, type RepoLayout } from "../model/index.ts";
import { explain, type ExplainedName } from "./explain.ts";
import { type OutdatedReport, outdatedReport } from "./outdated.ts";
import { type ChildCommand, childCommand, runCommand, selfArgv } from "./run.ts";
import type { Closed } from "./screen.ts";

/**
 * Lazy is a value computed once, with the error computing it gave (Go's
 * sync.Once): get computes on the first call and every later call returns
 * that value, or throws that error again. A promise is a value like any
 * other: the first call's promise (resolved or rejected) is every call's.
 */
class Lazy<T> {
  private state: { value: T } | { err: unknown } | undefined;

  get(compute: () => T): T {
    if (this.state === undefined) {
      try {
        this.state = { value: compute() };
      } catch (e) {
        this.state = { err: e };
      }
    }
    if ("err" in this.state) throw this.state.err;
    return this.state.value;
  }
}

/**
 * FromLayout is what the lock's layout decides (folders, the parent,
 * chezmoi's sources), read once. reloadLayout reads it again: a pull or a
 * compile can move them (a repo that renames its configs folder), and
 * everything after must use the new names.
 */
class FromLayout {
  readonly layout = new Lazy<RepoLayout>();
  readonly stateStore = new Lazy<StateStore>();
  readonly parentRoot = new Lazy<string>();
  readonly parentStore = new Lazy<StateStore | undefined>();
  readonly configs = new Lazy<engine.ConfigEngine | undefined>();
  readonly bunDir = new Lazy<Promise<string>>();
}

/**
 * AppContext is the shared services and resolved global options, built once
 * by the root command. The home screen refreshes the machine and asks the
 * remotes at the same time: every lazy value is computed once however many
 * ask, and an async one is one promise all of them await.
 */
export class AppContext {
  private fromLayout = new FromLayout();
  // What the last refreshAndWriteState left unanswered.
  private configsDownLast: string | undefined;
  private scriptDetailLast = new Map<string, string>();
  private toolsDownLast: engine.ToolDown[] = [];

  constructor(
    /** repoRoot is the config repo, as given (`--repo`, $LOADOUT_REPO, "."). */
    readonly repoRoot: string,
    /** machineOverride is `--machine` / $LOADOUT_MACHINE; "" = the hostname. */
    readonly machineOverride: string,
    readonly verbose: boolean,
    readonly runner: ProcessRunner,
    readonly detection: Detection,
  ) {}

  private current(): FromLayout {
    return this.fromLayout;
  }

  /**
   * reloadLayout forgets the layout read so far; the next use reads the lock
   * again (sync, after its pulls and compile).
   */
  reloadLayout(): void {
    this.fromLayout = new FromLayout();
  }

  /** layout is the lock's layout, read without the checks a full load makes. */
  layout(): RepoLayout {
    return this.current().layout.get(() => loader.readLayout(this.repoRoot));
  }

  /** stateStore is this repo's state directory. */
  stateStore(): StateStore {
    return this.current().stateStore.get(() => newStateStore(this.repoRoot, this.layout().state, false));
  }

  /** parentRoot is a child repo's parent checkout (contract 18), or "". */
  parentRoot(): string {
    return this.current().parentRoot.get(() => loader.parentRoot(this.repoRoot, this.layout(), home()));
  }

  /**
   * parentStateStore is a child repo's parent's state, read for the fleet view
   * only; undefined for any other repo.
   */
  private parentStateStore(): StateStore | undefined {
    return this.current().parentStore.get(() => {
      const layout = this.layout();
      if (layout.parent === undefined) return undefined;
      const root = this.parentRoot();
      if (root === "") return undefined;
      return newStateStore(root, layout.parent.state, true);
    });
  }

  /**
   * fleetStates is every machine's state the fleet view shows: this repo's,
   * and for a child its parent's machines too (a name in both is this repo's).
   */
  fleetStates(): Map<string, MachineState> {
    const parent = this.parentStateStore();
    const store = this.stateStore();
    const states = parent !== undefined ? parent.readAll() : new Map<string, MachineState>();
    return plus(states, store.readAll());
  }

  /** fleetWarnings is the warnings from the last fleetStates (or stateStore) read. */
  fleetWarnings(): string[] {
    const warnings: string[] = [];
    let parent: StateStore | undefined;
    try {
      parent = this.parentStateStore();
    } catch {
      parent = undefined;
    }
    if (parent !== undefined) warnings.push(...parent.lastWarnings());
    let store: StateStore | undefined;
    try {
      store = this.stateStore();
    } catch {
      store = undefined;
    }
    if (store !== undefined) warnings.push(...store.lastWarnings());
    return warnings;
  }

  /**
   * loadManifest is the repo's manifest as this machine sees it (its script
   * variants picked): the lock, checked (contract 10).
   */
  loadManifest(): Manifest {
    const manifest = loader.loadRepo(this.repoRoot, home());
    return forMachine(manifest, this.detectSystem().machine);
  }

  /** detectSystem is the machine loadout runs as. */
  detectSystem(): SystemInfo {
    return this.detection.detectSystem(this.machineOverride);
  }

  /** binaryAvailable says whether binary is on this machine's PATH (a probe). */
  async binaryAvailable(binary: string): Promise<boolean> {
    try {
      return await this.detection.isBinaryAvailable(binary);
    } catch {
      return false;
    }
  }

  /** canonicalRoot is the repo root, absolute, symlinks resolved. */
  canonicalRoot(): string {
    return evalSymlinks(resolve(this.repoRoot));
  }

  /**
   * frame is how manifest commands run on system: in the declaring file's
   * directory (a parent's in the parent), with the LOADOUT_* variables (contract 5).
   */
  async frame(system: SystemInfo): Promise<CommandFrame> {
    const root = this.canonicalRoot();
    const layout = this.layout();
    const parentRoot = this.parentRoot();
    const parentConfigs = layout.parent?.configs;
    const bunDir = await this.bunDir();
    return frameOf(root, system, layout.configs, parentRoot, parentConfigs, bunDir);
  }

  /**
   * bunDir is the folder of the bun the repo pins (`repo { bun = … }`),
   * downloaded the first time any command needs a frame, or "" when it pins
   * none.
   */
  bunDir(): Promise<string> {
    return this.current().bunDir.get(async () => {
      const meta = loader.readMeta(this.repoRoot);
      if (meta.bun === undefined) return "";
      return bun.ensure(this.runner, meta.bun);
    });
  }

  /**
   * configs is chezmoi over the `layout configs` directory, and for a child
   * repo its parent's too (the parent's first); undefined when neither has one.
   * chezmoi sees the repo and machine loadout runs as, so the templates'
   * partial agrees with `--repo` and `--machine`.
   */
  configs(): engine.ConfigEngine | undefined {
    return this.current().configs.get(() => {
      const layout = this.layout();
      const root = this.canonicalRoot();
      const sources: engine.ConfigSource[] = [];
      const parent = layout.parent;
      if (parent !== undefined && parent.configs !== undefined) {
        const parentRoot = this.parentRoot();
        if (parentRoot !== "") {
          sources.push({ dir: parentRoot + "/" + parent.configs, label: "parent " + parent.name });
        }
      }
      if (layout.configs !== undefined) sources.push({ dir: root + "/" + layout.configs, label: "" });
      if (sources.length === 0) return undefined;
      const env = { LOADOUT_REPO: root, LOADOUT_MACHINE: this.detectSystem().machine };
      return engine.newConfigEngine(this.runner, sources, env);
    });
  }

  /** hasConfigs says whether the repo has configs; false when the lock can't say. */
  hasConfigs(): boolean {
    try {
      return this.configs() !== undefined;
    } catch {
      return false;
    }
  }

  /** statusEngine is the observer every refresh uses: programs, scripts and configs. */
  async statusEngine(system: SystemInfo): Promise<engine.StatusEngine> {
    const frame = await this.frame(system);
    const configs = this.configs();
    return engine.newStatusEngine(engine.newVersionChecker(this.runner, frame), this.runner, frame, configs);
  }

  /** lastConfigsDown is why configs went unchecked during the last refresh, or undefined. */
  lastConfigsDown(): string | undefined {
    return this.configsDownLast;
  }

  /** lastScriptDetail is what each failing script check printed during the last refresh. */
  lastScriptDetail(): Map<string, string> {
    return this.scriptDetailLast;
  }

  /**
   * lastToolsDown is the tools whose checks couldn't run during the last
   * refresh (see engine.StatusEngine.lastToolsDown).
   */
  lastToolsDown(): engine.ToolDown[] {
    return this.toolsDownLast;
  }

  /**
   * refreshAndWriteState re-runs all version checks, merges in any script
   * results from this run (scriptResults, empty for none), writes the state
   * file, and returns the new state. updatedAt (and git history) stays put
   * when nothing real changed.
   */
  refreshAndWriteState(
    manifest: Manifest,
    system: SystemInfo,
    scriptResults: ReadonlyMap<string, ScriptState>,
  ): Promise<MachineState> {
    return this.refreshAndWriteStateParts(manifest, system, scriptResults, undefined);
  }

  /**
   * refreshAndWriteStateParts is refreshAndWriteState, handing each subject
   * (programs, scripts, configs) to onPart as soon as its own checks finish
   * (engine.StatusEngine.refreshParts). The state file is still written once,
   * with the whole observation: never half of one.
   */
  async refreshAndWriteStateParts(
    manifest: Manifest,
    system: SystemInfo,
    scriptResults: ReadonlyMap<string, ScriptState>,
    onPart: ((part: engine.Part) => void) | undefined,
  ): Promise<MachineState> {
    const store = this.stateStore();
    const previous = store.read(system.machine);
    const observer = await this.statusEngine(system);
    const observed = await observer.refreshParts(manifest, system, previous, scriptResults, onPart);
    this.scriptDetailLast = observer.lastScriptDetail();
    this.toolsDownLast = observer.lastToolsDown();
    this.configsDownLast = observer.lastConfigsDown();
    return store.writeChanged(previous, observed);
  }

  /** explain is explain.ts's explain over this context. */
  explain(names: readonly string[]): Promise<ExplainedName[]> {
    return explain(this, names);
  }

  /** outdatedReport is outdated.ts's outdatedReport over this context. */
  outdatedReport(manifest: Manifest, system: SystemInfo, observed: MachineState, freshSelfCheck: boolean): Promise<OutdatedReport> {
    return outdatedReport(this, manifest, system, observed, freshSelfCheck);
  }

  /** runCommand is run.ts's runCommand over this context. */
  runCommand(closed: Closed): ChildCommand | undefined {
    return runCommand(this, closed);
  }

  /** childCommand is run.ts's childCommand over this context. */
  childCommand(self: string, name: string, args: readonly string[]): ChildCommand {
    return childCommand(this, self, name, args);
  }

  /** selfArgv is run.ts's selfArgv over this context. */
  selfArgv(self: string, ...args: string[]): string[] {
    return selfArgv(this, self, ...args);
  }
}

/** newApp is the context of the repo at repoRoot, running real processes (Go's app.New). */
export function newApp(repoRoot: string, machineOverride: string, verbose: boolean): AppContext {
  const runner = newShellRunner();
  return newAppWith(repoRoot, machineOverride, verbose, runner, newDetection(runner, dirFS("/")));
}

/** newAppWith is newApp over the runner and detection given (tests). */
export function newAppWith(
  repoRoot: string,
  machineOverride: string,
  verbose: boolean,
  runner: ProcessRunner,
  detection: Detection,
): AppContext {
  return new AppContext(repoRoot, machineOverride, verbose, runner, detection);
}

/** home is $HOME, "" when unset: where a parent at `~/…` lives. */
export function home(): string {
  return envVar("HOME") ?? "";
}

/**
 * evalSymlinks is Go's filepath.EvalSymlinks of an absolute, clean path: the
 * path with every symlink resolved, or Go's error naming the first part of
 * it that isn't there ("lstat /x/y: no such file or directory").
 */
function evalSymlinks(path: string): string {
  try {
    return realpathSync(path);
  } catch (e) {
    let prefix = "";
    for (const part of path.split("/").filter((p) => p !== "")) {
      prefix += "/" + part;
      try {
        lstatSync(prefix);
      } catch (inner) {
        throw goPathError(inner, "lstat", prefix);
      }
    }
    throw goPathError(e, "lstat", path);
  }
}
