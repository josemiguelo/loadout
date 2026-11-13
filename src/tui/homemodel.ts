// Package tui is the home screen (bare `loadout` on a TTY): HomeModel holds
// ALL its state and logic, pure and unit-tested; the program (program.ts)
// feeds it keys and background answers as messages, and view.ts draws it.
//
// Go's methods on HomeModel are functions taking the model first, spread
// over the files Go spread them over (keys.ts, runs.ts, inspect.ts,
// view.ts); they import each other, and none runs at load time.

import * as app from "../app/index.ts";
import { scriptOrder } from "../assemble/index.ts";
import {
  type ConfigState,
  configApplied,
  configDrifted,
  configUnknown,
  type ConfigStatus,
  done,
  installed,
  type MachineState,
  missing,
  newMachineState,
  type ProgramState,
  type ProgramStatus,
  type ScriptState,
  type ScriptStatus,
  type SystemInfo,
  unknown,
} from "../core/coremodel/coremodel.ts";
import * as diff from "../core/diff/diff.ts";
import * as engine from "../core/engine/index.ts";
import * as exec from "../core/exec/index.ts";
import { type Manifest, resolveInstall, runsIn, scriptArgs, shownLine, sortStrings, compareStrings } from "../model/index.ts";
import * as style from "./style/index.ts";
import type { Cmd, Msg } from "./tea.ts";
import { newModel as newTermModel } from "./term/term.ts";
import { Jobs, newJobs } from "./jobs.ts";
import { ask, fail, hey, say, warn, type Dialog, DialogKind, newDialog } from "./keys.ts";
import { SubjectConfigs, SubjectPrograms, SubjectScripts } from "./lists.ts";
import type { Run, Terminal } from "./runs.ts";
import type { Inspector } from "./inspect.ts";

/**
 * PaneItem is one row of a confirm dialog: a name, and what it means. list
 * is a list row's lines ("N more not in your loadout"): enter on it opens
 * them in a list dialog.
 */
export interface PaneItem {
  name: string;
  text: string;
  list?: string[];
}

/**
 * ProgramRow is one program this machine maps, as the programs list shows
 * it: what would install it, and its last verdict.
 */
export interface ProgramRow {
  name: string;
  installKey: string;
  command: string;
  /** status is the last observed verdict; "" = never observed here. */
  status: ProgramStatus | "";
  /** version is the version last observed, "" when none. */
  version: string;
}

/** ScriptRow is one of this machine's maintenance scripts, as the scripts row lists it. */
export interface ScriptRow {
  name: string;
  /** command is the script itself, machine args applied. */
  command: string;
  /** description is what it's for, from the manifest — what the question shows next to its name. */
  description: string;
  /** status is the last observed verdict; "" = never observed here. */
  status: ScriptStatus | "";
}

/** ConfigItem is one config unit, as the configs row lists it. */
export interface ConfigItem {
  name: string;
  /** status is the last observed verdict; "" = never observed here. */
  status: ConfigStatus | "";
  /** files is the files apply would change (drifted). */
  files: string[];
}

/**
 * ToolUpdates is one tool as the remote table shows it: app.ToolUpdates,
 * with a total that may be unknown (undefined) — a tool no batch oracle
 * described still heads its programs.
 */
export interface ToolUpdates {
  tool: string;
  installers: string[];
  /** total is every outdated package the tool reported; undefined when no batch oracle can say. */
  total?: number;
  declared: string[];
  others: string[];
  command?: string;
}

/** newToolUpdates is a ToolUpdates with every field not given empty. */
export function newToolUpdates(t: Partial<ToolUpdates> & { tool: string }): ToolUpdates {
  return { installers: [], declared: [], others: [], ...t };
}

function toolUpdatesOf(t: app.ToolUpdates): ToolUpdates {
  return { tool: t.tool, installers: t.installers, total: t.total, declared: t.declared, others: t.others, command: t.command };
}

/** Asking is the remotes still being asked. */
export interface Asking {
  kind: "asking";
}

/** Unavailable is the remotes that couldn't be asked, and why. */
export interface Unavailable {
  kind: "unavailable";
  reason: string;
}

/** Answered is the remotes' answer. */
export interface Answered {
  kind: "answered";
  updates: app.UpdateRow[];
  failedSources: number;
  /** tools is the doctor's view: every tool asked, with everything it reported, declared or not. */
  tools: ToolUpdates[];
  /**
   * mechanismOf is row name to the mechanism that can upgrade it. Upgrades
   * are whole-mechanism, so picking a row means picking its installer.
   * PROGRAM rows only — a custom source's row is never in here, however its
   * item happens to be named (see sources).
   */
  mechanismOf: Map<string, string>;
  /**
   * toolOf is mechanism to the TOOL it drives (its probe binary): brew and
   * brew-cask are both "brew", dnf/dnf-repo/dnf-copr are all "dnf".
   * Selecting a row selects its tool — you upgrade brew, not formulae but
   * not casks.
   */
  toolOf: Map<string, string>;
  /** mechanismsOfTool is tool to every mechanism it covers, for handing the engine names. */
  mechanismsOfTool: Map<string, string[]>;
  /**
   * sources is EVERY custom source, mapped to whether it can update ONE of
   * its items (`upgrade` declared). Rows from an upgradable one tick
   * individually — a pin in a file has nothing in common with the next pin.
   * Keyed by SOURCE, not by row name: the same name can appear in two
   * sources (python is an asdf tool and an asdf plugin).
   *
   * Read-only sources are in here too, because what a row IS comes from
   * where it came from, never from its name. A source's item may share a
   * name with a mapped program — the live repo has a `tpack` tmux plugin and
   * a `tpack` brew cask — and a name lookup filed it under that program's
   * tool, so ticking it ran `brew upgrade`, which cannot move a git clone,
   * and the row came back outdated forever. One field, so "is a source" and
   * "can be upgraded" can never drift apart.
   */
  sources: Map<string, boolean>;
  /**
   * programUpgrades is the programs this machine maps that declare their own
   * `upgrade`: each is upgraded alone (`loadout upgrade <name>`), whatever
   * installer its variant names.
   */
  programUpgrades: Set<string>;
}

/** newAnswered is an Answered with every field not given empty (Go's zero value). */
export function newAnswered(a: Partial<Omit<Answered, "kind">> = {}): Answered {
  return {
    kind: "answered",
    updates: [],
    failedSources: 0,
    tools: [],
    mechanismOf: new Map(),
    toolOf: new Map(),
    mechanismsOfTool: new Map(),
    sources: new Map(),
    programUpgrades: new Set(),
    ...a,
  };
}

/**
 * RemoteStatus is what the remotes have said so far — they're asked on
 * open, not on demand: undefined (not asked), Asking, Answered or
 * Unavailable.
 */
export type RemoteStatus = Asking | Unavailable | Answered | undefined;

export const asking: Asking = { kind: "asking" };

/** unavailable is the remotes that couldn't be asked, and why. */
export function unavailable(reason: string): Unavailable {
  return { kind: "unavailable", reason };
}

/** answeredOf is s when the remotes answered. */
export function answered(s: RemoteStatus): Answered | undefined {
  return s?.kind === "answered" ? s : undefined;
}

function isSource(a: Answered, source: string): boolean {
  return a.sources.has(source);
}

/** toolOfRow is the tool behind row's mechanism, "" when it has none. */
function toolOfRow(a: Answered, name: string): string {
  const mechanism = a.mechanismOf.get(name);
  if (mechanism === undefined) return "";
  return a.toolOf.get(mechanism) ?? "";
}

/** Severity is how a subject line reads: settled, needs attention, severe. */
export enum Severity {
  Settled = 0,
  Attention = 1,
  Severe = 2,
}

/** HomeSection is one subject line: its verdict, and the single verb that resolves it. */
export interface HomeSection {
  subject: string;
  summary: string;
  /** short is the summary in a few cells, for the sidebar ("67/69", "2 drifted"). */
  short: string;
  verb: string;
  action: app.HomeAction;
  severity: Severity;
  /** neutral says nothing has been asked yet, so neither settled nor a problem. */
  neutral: boolean;
  /** busy says this subject is being (re)checked right now — the row spins. */
  busy: boolean;
}

/** newSection is a HomeSection with every field not given at its zero value. */
export function newSection(s: Partial<HomeSection> & { subject: string }): HomeSection {
  return { summary: "", short: "", verb: "", action: app.ActionNone, severity: Severity.Settled, neutral: false, busy: false, ...s };
}

/**
 * FocusArea is where the keyboard is: the sidebar's subjects (and runs),
 * the main pane's list, or the run panel's terminal.
 */
export enum FocusArea {
  Sidebar = 0,
  Main = 1,
  /**
   * Terminal exists only while the run panel shows: every key goes to the
   * command except ctrl+] (back to the main pane).
   */
  Terminal = 2,
}

/** HomeState is everything the screen shows and decides from. */
export interface HomeState {
  machine: string;
  system: string;
  sections: HomeSection[];
  /** subject is the subject the main pane shows: an index into sections. */
  subject: number;
  /** focus is the focused area. */
  focus: FocusArea;
  /**
   * sideRun is the Runs entry the sidebar's cursor is on (an index into the
   * runs, newest first), -1 when it is on the subjects.
   */
  sideRun: number;
  /**
   * runFromSidebar says the panel's run was opened from the sidebar's Runs:
   * leaving or closing it puts the focus back there, on that entry.
   */
  runFromSidebar: boolean;
  /**
   * cursors is each subject's cursor in its own list (a position in the list
   * as shown, filter applied); offsets its first visible row.
   */
  cursors: Map<string, number>;
  offsets: Map<string, number>;
  /** filters is each subject's filter text; filtering says the filter input has the keyboard. */
  filters: Map<string, string>;
  filtering: boolean;
  /** inspect is the inspector the main pane shows instead of its list. */
  inspect?: Inspector;
  /**
   * checking is the subjects (programs, scripts, configs) whose checks are
   * still running: each row spins until its OWN part lands.
   */
  checking: Set<string>;
  /** stale says the verdicts are the last `status`'s, not this moment's. */
  stale: boolean;
  remote: RemoteStatus;
  /** fleet is the fleet comparison, kept for the fleet table and the inspector. */
  fleet?: diff.DiffReport;
  /** selection is the remote rows ticked for upgrading, by selection key. */
  selection: Set<string>;
  /** collapsed is the remote tree's groups folded shut (`tool:<probe>` / `source:<name>`). */
  collapsed: Set<string>;
  /**
   * programs is every program this machine maps, with its last verdict:
   * missing ones first (the work), then the rest in manifest order.
   */
  programs: ProgramRow[];
  /** missing is the missing programs, in manifest order: what can be ticked to install. */
  missing: ProgramRow[];
  /** chosen is the missing programs ticked to install. All of them, after every re-check: missing IS the work. */
  chosen: Set<string>;
  /** scripts is this machine's maintenance scripts, in run order, with their last verdicts. */
  scripts: ScriptRow[];
  /** picked is the scripts ticked to run. Follows the verdicts: not done = ticked, after every re-check. */
  picked: Set<string>;
  /** configs is this machine's config units with their last verdicts; empty without `repo { configs }`. */
  configs: ConfigItem[];
  /** applying is the configs ticked to apply. Follows the verdicts: drifted = ticked, after every re-check. */
  applying: Set<string>;
  /** dialog is the dialog up, if any: it owns the keyboard. */
  dialog?: Dialog;
  /** maximized says the run panel takes the whole main pane. */
  maximized: boolean;
  dark: boolean;
  exit: boolean;
}

/** newHomeState is a HomeState with every field not given at its zero value (sideRun -1). */
export function newHomeState(s: Partial<HomeState> = {}): HomeState {
  return {
    machine: "",
    system: "",
    sections: [],
    subject: 0,
    focus: FocusArea.Sidebar,
    sideRun: -1,
    runFromSidebar: false,
    cursors: new Map(),
    offsets: new Map(),
    filters: new Map(),
    filtering: false,
    checking: new Set(),
    stale: false,
    remote: undefined,
    selection: new Set(),
    collapsed: new Set(),
    programs: [],
    missing: [],
    chosen: new Set(),
    scripts: [],
    picked: new Set(),
    configs: [],
    applying: new Set(),
    maximized: false,
    dark: false,
    exit: false,
    ...s,
  };
}

/** Explain is the inspector's seam: app.explain, or a test's answer (which may come at once). */
export type Explain = (names: string[]) => Promise<app.ExplainedName[]> | app.ExplainedName[];

/**
 * HomeModel is the home screen: one place that says what needs working on,
 * and runs each kind of work as the command that already does it.
 *
 * It owns NO domain logic — StatusEngine observes, diff compares, explain
 * explains, and every action is a real subcommand, run in the run panel's
 * terminal. Its state changes only in the program's update: background work
 * runs on the jobs runner and lands as a message, so no write can put back a
 * state copied before another landed.
 */
export class HomeModel {
  state: HomeState;
  readonly jobs: Jobs = newJobs();

  manifest?: Manifest;
  system?: SystemInfo;
  stored?: MachineState;
  /**
   * partial is the refresh under way: stored, with each subject's fresh part
   * replacing its own as it lands; partToolsDown the programs part's.
   */
  partial?: MachineState;
  partToolsDown: engine.ToolDown[] = [];
  /** gArmed says the last key was a lone g: another one makes gg. */
  gArmed = false;

  /** width and height are the terminal's size, from the program. */
  width = 120;
  height = 40;
  readonly toasts = new style.Toasts();
  /**
   * cmds is what reducers asked the program to run (toast expiries, the
   * terminal's messages); the program takes them after every update.
   */
  cmds: Cmd[] = [];

  /**
   * runs is this session's runs, oldest first; active is the one running,
   * shown the one in the run panel (undefined: no panel); waiting is a
   * confirmed action held until the background checks finish.
   */
  runs: Run[] = [];
  active?: Run;
  shown?: Run;
  waiting?: app.Closed;
  nextRun = 0;
  /** ended is what the screen ends with after a run replaced loadout's binary. */
  ended?: app.Ended;

  // Seams for tests: the command a confirmed action runs, the terminal it
  // runs in, explain.
  runCommand?: (closed: app.Closed) => app.ChildCommand | undefined;
  newTerm: (w: number, h: number) => Terminal = (w, h) => newTermModel(w, h);
  explain?: Explain;
  now: () => Date = () => new Date();

  constructor(
    readonly app: app.AppContext | undefined,
    dark: boolean,
  ) {
    this.state = newHomeState({ dark, sideRun: -1 });
    if (app !== undefined) {
      this.runCommand = (c) => app.runCommand(c);
      this.explain = (names) => app.explain(names);
    }
  }
}

/** newHomeModel is the screen over a (undefined: no repo, the reducers' tests), in the dark or light theme. */
export function newHomeModel(a: app.AppContext | undefined, dark: boolean): HomeModel {
  return new HomeModel(a, dark);
}

/** setStateForTest replaces m's state (sideRun 0 without runs is the subjects: -1). */
export function setStateForTest(m: HomeModel, s: HomeState): void {
  if (s.sideRun === 0 && m.runs.length === 0) s = { ...s, sideRun: -1 };
  m.state = s;
}

/** withConfigs says the repo has `repo { configs = … }`: the configs subject is there. */
export function withConfigs(m: HomeModel): boolean {
  return m.app !== undefined && m.app.hasConfigs();
}

/** theme is the screen's palette now. */
export function theme(m: HomeModel): style.Theme {
  return style.themeFor(m.state.dark);
}

/** setRows is every subject's rows from observed, ticks following the verdicts. */
function setRows(m: HomeModel, manifest: Manifest, sys: SystemInfo, observed: MachineState | undefined): void {
  const s = m.state;
  s.programs = programRowsOf(manifest, sys, observed);
  s.missing = missingRowsOf(manifest, sys, observed);
  s.chosen = new Set(s.missing.map((p) => p.name));
  s.scripts = scriptRowsOf(manifest, sys, observed);
  s.picked = preselect(s.scripts);
  s.configs = configItemsOf(observed);
  s.applying = preselectConfigs(s.configs);
}

/**
 * load puts the stored verdicts on screen immediately. Call before the
 * screen shows; it throws the screen's error.
 */
export function load(m: HomeModel): void {
  const a = m.app!;
  const manifest = a.loadManifest();
  const sys = a.detectSystem();
  m.manifest = manifest;
  m.system = sys;
  const store = a.stateStore();
  const stored = store.read(sys.machine);
  m.stored = stored;
  const report = fleet(m);
  const s = m.state;
  s.machine = sys.machine;
  const distro = sys.distro !== undefined ? "/" + sys.distro : "";
  s.system = sys.os + distro + " · " + sys.arch;
  s.sections = sectionsOf(manifest, sys, stored, report, undefined, { withConfigs: withConfigs(m) });
  s.subject = Math.min(s.subject, s.sections.length - 1);
  s.fleet = report;
  setRows(m, manifest, sys, stored);
  s.stale = stored !== undefined;
  const warnings = store.lastWarnings();
  if (warnings.length > 0) warn(m, warnings[0]!);
}

/** RefreshedMsg is the machine's own checks, landed. */
export class RefreshedMsg {
  constructor(
    readonly fresh: MachineState | undefined,
    readonly err: unknown,
    readonly known: MachineState | undefined,
    readonly remotes: boolean,
    readonly toolsDown: engine.ToolDown[],
    readonly configsDown: string | undefined,
  ) {}
}

/** PartMsg is one subject of the refresh, landed before the others. */
export class PartMsg {
  constructor(readonly part: engine.Part) {}
}

/** RemoteMsg is the remotes' answer, landed. */
export class RemoteMsg {
  constructor(
    readonly remote: RemoteStatus,
    readonly toolsDown: engine.ToolDown[],
  ) {}
}

/** SayMsg is a background job's one line for a toast. */
export class SayMsg {
  constructor(
    readonly kind: style.ToastKind,
    readonly message: string,
  ) {}
}

/**
 * ThenMsg is the rest of a reducer that had to wait for an answer (Go asked
 * synchronously; here explain, configs and the install plan are promises):
 * it lands like any message and finishes on the model.
 */
export class ThenMsg {
  constructor(readonly finish: (m: HomeModel) => void) {}
}

/**
 * later runs then on value: at once when it's already there, else once the
 * promise lands, as a ThenMsg the program applies (a rejection goes to
 * failed). Answers that come at once (tests' fakes) keep the reducers
 * synchronous.
 */
export function later<T>(m: HomeModel, value: T | Promise<T>, then: (m: HomeModel, v: T) => void, failed: (m: HomeModel, e: unknown) => void): void {
  if (!(value instanceof Promise)) {
    then(m, value);
    return;
  }
  m.cmds.push(() =>
    value.then(
      (v) => new ThenMsg((mm) => then(mm, v)),
      (e: unknown) => new ThenMsg((mm) => failed(mm, e)),
    ),
  );
}

/**
 * refresh asks two questions at once: the machine's own checks (~3s) and the
 * remotes (~4s). The remote query starts IMMEDIATELY against the stored
 * state rather than queueing behind the refresh — waiting seconds to start
 * asking is the thing this screen exists to avoid. Each lands as it
 * finishes. remotes = false re-checks the machine only, keeping the answers
 * already on screen.
 */
export function refresh(m: HomeModel, remotes: boolean): void {
  if (m.manifest === undefined || m.system === undefined || m.state.checking.size > 0) return;
  const manifest = m.manifest;
  const sys = m.system;
  // Recompute the rows too: "asking…" has to show the moment we start, not
  // when the first answer lands.
  let remote = m.state.remote;
  if (remotes) remote = asking;
  m.state.checking = new Set([SubjectPrograms, SubjectScripts]);
  if (withConfigs(m)) m.state.checking.add(SubjectConfigs);
  m.partial = undefined;
  m.partToolsDown = [];
  if (m.stored !== undefined) m.partial = { ...m.stored };
  m.state.sections = sectionsOf(manifest, sys, m.stored, fleet(m), remote, { checking: m.state.checking, withConfigs: withConfigs(m) });
  m.state.remote = remote;

  const known = m.stored;
  if (remotes && known !== undefined) askRemotes(m, known);
  const a = m.app!;
  const jobs = m.jobs;
  jobs.start(async () => {
    // Each subject lands as its own checks finish; the state file is
    // written once, after the last.
    let fresh: MachineState | undefined;
    let err: unknown;
    try {
      fresh = await a.refreshAndWriteStateParts(manifest, sys, new Map(), (p) => jobs.post(new PartMsg(p)));
    } catch (e) {
      err = e;
    }
    return new RefreshedMsg(fresh, err, known, remotes, a.lastToolsDown(), a.lastConfigsDown());
  });
}

function refreshed(m: HomeModel, msg: RefreshedMsg): void {
  if (m.manifest === undefined || m.system === undefined) return;
  const manifest = m.manifest;
  const sys = m.system;
  const observed = msg.fresh ?? msg.known;
  if (observed !== undefined) m.stored = observed;
  const report = fleet(m);
  const s = m.state;
  s.checking = new Set();
  m.partial = undefined;
  m.partToolsDown = [];
  s.stale = msg.err !== undefined;
  s.fleet = report;
  s.sections = sectionsOf(manifest, sys, observed, report, s.remote, { toolsDown: msg.toolsDown, withConfigs: withConfigs(m) });
  setRows(m, manifest, sys, observed);
  // A tool the checks go through wasn't there: one sentence, in a toast
  // where a person reads — not only a count in a row.
  if (msg.err !== undefined) fail(m, firstLine(errorText(msg.err)));
  else if (msg.toolsDown.length > 0) warn(m, engine.toolDownMessage(msg.toolsDown[0]!) + " · r re-checks once it is fixed");
  else if (msg.configsDown !== undefined) warn(m, "configs not checked: " + msg.configsDown);
  // A machine with no state file yet couldn't be asked about above.
  if (msg.remotes && msg.known === undefined && observed !== undefined) askRemotes(m, observed);
}

/**
 * partLanded is one subject of the refresh, in: its row stops spinning and
 * shows its fresh answer while the others still check. A part that failed
 * waits for the refresh's own message, which says why.
 */
function partLanded(m: HomeModel, msg: PartMsg): void {
  if (m.manifest === undefined || m.system === undefined || m.state.checking.size === 0 || msg.part.err !== undefined) return;
  const manifest = m.manifest;
  const sys = m.system;
  if (m.partial === undefined) m.partial = newMachineState({ machine: sys.machine });
  const p = msg.part;
  let subject = "";
  switch (p.kind) {
    case engine.partPrograms:
      m.partial = { ...m.partial, programs: p.programs };
      m.partToolsDown = p.toolsDown;
      subject = SubjectPrograms;
      break;
    case engine.partScripts:
      m.partial = { ...m.partial, scripts: p.scripts };
      subject = SubjectScripts;
      break;
    case engine.partConfigs:
      m.partial = { ...m.partial, configs: p.configs };
      subject = SubjectConfigs;
      break;
  }
  const checking = new Set([...m.state.checking].filter((k) => k !== subject));
  m.state.checking = checking;
  m.state.sections = sectionsOf(manifest, sys, m.partial, m.state.fleet, m.state.remote, {
    checking,
    toolsDown: m.partToolsDown,
    withConfigs: withConfigs(m),
  });
  setRows(m, manifest, sys, m.partial);
}

/** askRemotesAgain asks the remotes only: the machine's own rows are already current. */
export function askRemotesAgain(m: HomeModel): void {
  if (m.manifest === undefined || m.system === undefined || m.stored === undefined) return;
  m.state.remote = asking;
  m.state.sections = sectionsOf(m.manifest, m.system, m.stored, m.state.fleet, asking, { withConfigs: withConfigs(m) });
  askRemotes(m, m.stored);
}

/** reload is the rows again from the state file a command just wrote; the remotes' answer stays. */
export function reload(m: HomeModel): void {
  if (m.manifest === undefined || m.system === undefined || m.app === undefined) return;
  const manifest = m.manifest;
  const sys = m.system;
  let observed = m.stored;
  try {
    const read = m.app.stateStore().read(sys.machine);
    if (read !== undefined) observed = read;
  } catch {
    // the rows on screen stay
  }
  m.stored = observed;
  const report = fleet(m);
  const s = m.state;
  s.sections = sectionsOf(manifest, sys, observed, report, s.remote, { withConfigs: withConfigs(m) });
  s.fleet = report;
  setRows(m, manifest, sys, observed);
  s.stale = false;
}

/** askRemotes starts the remotes' question against observed. */
function askRemotes(m: HomeModel, observed: MachineState): void {
  if (m.manifest === undefined || m.system === undefined) return;
  const manifest = m.manifest;
  const sys = m.system;
  const a = m.app!;
  m.jobs.start(async () => {
    // Cached self-check: this screen opens constantly and GitHub's
    // unauthenticated API is rate-limited. `outdated` asks fresh.
    try {
      const r = await a.outdatedReport(manifest, sys, observed, false);
      return new RemoteMsg(answeredOf(manifest, sys.machine, r), a.lastToolsDown());
    } catch (e) {
      return new RemoteMsg(unavailable(firstLineOr(errorText(e), "unreachable")), a.lastToolsDown());
    }
  });
}

/** answeredOf is the report r as the remote row keeps it. */
export function answeredOf(manifest: Manifest, machine: string, r: app.OutdatedReport): Answered {
  const mapping = manifest.machines.get(machine)?.pm ?? new Map<string, string>();
  const used = engine.upgradableInstallers(manifest, machine);
  const out = newAnswered({ updates: r.updates, failedSources: r.errors.length });
  for (const t of r.tools) out.tools.push(toolUpdatesOf(t));
  for (const row of r.updates) {
    // A custom source's row is its source's, whatever it is called — never
    // the program of that name.
    if (manifest.outdated.has(row.source) || row.source === "release") continue;
    const key = mapping.get(row.name);
    if (key === undefined) continue;
    const upgradeWith = resolveInstall(manifest, row.name, key).upgradeWith;
    if (upgradeWith !== undefined) out.mechanismOf.set(row.name, upgradeWith.installer);
  }
  // ONLY mechanisms this machine's mapping uses. Grouping every installer
  // that shares a probe would reach the built-in `brew` from a repo that
  // never maps it — and then upgrade the real Homebrew.
  for (const mechanism of used.keys()) {
    const tool = manifest.installers.get(mechanism)?.probe ?? mechanism;
    out.toolOf.set(mechanism, tool);
    out.mechanismsOfTool.set(tool, [...(out.mechanismsOfTool.get(tool) ?? []), mechanism]);
  }
  for (const [name, source] of manifest.outdated) out.sources.set(name, source.upgrade !== undefined);
  for (const name of mapping.keys()) {
    const program = manifest.programs.get(name);
    if (program?.outdated?.upgrade !== undefined) out.programUpgrades.add(name);
  }
  return out;
}

function remoteLanded(m: HomeModel, msg: RemoteMsg): void {
  m.state.remote = msg.remote;
  if (m.manifest === undefined || m.system === undefined) return;
  let observed = m.stored;
  if (m.state.checking.size > 0 && m.partial !== undefined) observed = m.partial;
  m.state.sections = sectionsOf(m.manifest, m.system, observed, fleet(m), msg.remote, {
    checking: m.state.checking,
    toolsDown: msg.toolsDown,
    withConfigs: withConfigs(m),
  });
}

/** apply is a background job's message landing on the state. */
export function apply(m: HomeModel, msg: Msg): void {
  if (msg instanceof PartMsg) partLanded(m, msg);
  else if (msg instanceof RefreshedMsg) refreshed(m, msg);
  else if (msg instanceof RemoteMsg) remoteLanded(m, msg);
  else if (msg instanceof SayMsg) say(m, msg.kind, msg.message);
  else if (msg instanceof ThenMsg) msg.finish(m);
}

function fleet(m: HomeModel): diff.DiffReport | undefined {
  if (m.manifest === undefined || m.app === undefined) return undefined;
  let states: Map<string, MachineState>;
  try {
    states = m.app.fleetStates();
  } catch {
    return undefined;
  }
  if (states.size === 0) return undefined;
  return diff.diff(m.manifest, [...states.values()]);
}

/**
 * startUpgrade asks about upgrading the ticked tools and source items, then
 * hands off to `loadout upgrade`. Planned with the same engine, so refusals
 * show before anything runs.
 */
export function startUpgrade(m: HomeModel, ans: Answered, selection: ReadonlySet<string>): void {
  if (m.manifest === undefined || m.system === undefined || m.state.dialog !== undefined) return;
  const manifest = m.manifest;
  const machine = m.system.machine;
  // Tools sweep; source items go one at a time, in the order shown.
  const installers: string[] = [];
  const programs: string[] = [];
  const items = new Map<string, string[]>();
  for (const key of selection) {
    if (key.startsWith("tool:")) installers.push(...(ans.mechanismsOfTool.get(key.slice("tool:".length)) ?? []));
    else if (key.startsWith("prog:")) programs.push(key.slice("prog:".length));
    else if (key.startsWith("item:")) {
      const rest = key.slice("item:".length);
      const at = rest.indexOf("/");
      const [source, item] = at < 0 ? [rest, ""] : [rest.slice(0, at), rest.slice(at + 1)];
      items.set(source, [...(items.get(source) ?? []), item]);
    }
  }
  sortStrings(installers);
  sortStrings(programs);
  const sources: string[] = [];
  for (const row of ans.updates) {
    if (items.has(row.source) && !sources.includes(row.source)) sources.push(row.source);
  }
  for (const source of items.keys()) if (!sources.includes(source)) sources.push(source);
  const plan: engine.UpgradeStep[] = [];
  const args = [...installers, ...programs];
  try {
    plan.push(...engine.planUpgrade(manifest, machine, installers));
    plan.push(...engine.planProgramUpgrades(manifest, machine, programs));
    for (const source of sources) {
      const rows = sortStrings([...(items.get(source) ?? [])]);
      plan.push(...engine.planSourceItems(manifest, source, rows));
      for (const row of rows) args.push("--item", source + "/" + row);
    }
  } catch (e) {
    fail(m, firstLine(errorText(e)));
    return;
  }
  if (plan.length === 0) return;
  const rows: PaneItem[] = [];
  for (const step of plan) {
    rows.push(upgradeItem(step, ans));
    // The sweep's cost, in full: a list row opens every package it moves
    // that loadout doesn't declare.
    if (step.sweep) {
      for (const tool of ans.tools) {
        if (tool.others.length > 0 && tool.installers.some((i) => step.installers.includes(i))) {
          rows.push({ name: "", text: `${style.GlyphMore} ${tool.others.length} more not in your loadout`, list: tool.others });
        }
      }
    }
  }
  ask(m, { kind: app.PaneUpgrade, args }, rows);
}

/**
 * startInstalls asks about installing the ticked missing programs, then
 * hands off to `loadout install <names>`. Planned with InstallEngine like the
 * command (dependencies first, refusals before anything runs).
 */
export function startInstalls(m: HomeModel, chosen: ReadonlySet<string>): void {
  if (m.state.dialog !== undefined) return;
  const names = m.state.missing.filter((p) => chosen.has(p.name)).map((p) => p.name);
  if (names.length === 0) {
    hey(m, "nothing ticked — space ticks a program, a ticks them all");
    return;
  }
  if (m.manifest === undefined || m.system === undefined || m.app === undefined) return;
  const a = m.app;
  const manifest = m.manifest;
  const sys = m.system;
  const current = m.stored?.programs ?? new Map<string, ProgramState>();
  const planned = (async () => {
    const frame = await a.frame(sys);
    const installs = engine.newInstallEngine(a.runner, engine.newVersionChecker(a.runner, frame), frame);
    return installs.plan(manifest, sys.machine, names, current, (b) => a.binaryAvailable(b));
  })();
  later(
    m,
    planned,
    (m, plan) => {
      // The user may have opened something meanwhile: it stays.
      if (m.state.dialog !== undefined) return;
      const steps = engine.installs(plan);
      if (steps.length === 0) {
        hey(m, "already installed — r re-checks");
        return;
      }
      // The installer, and which programs are unticked dependencies.
      const rows = steps.map((step) => {
        let text = "via " + step.installKey;
        if (!names.includes(step.program)) text += " · needed first";
        return { name: step.program, text };
      });
      ask(m, { kind: app.PaneInstall, args: names }, rows);
    },
    (m, e) => fail(m, firstLine(errorText(e))),
  );
}

/**
 * startScripts asks about running the ticked scripts, then hands off to
 * `loadout run <names> --force` (a ticked script runs even when done). `run`
 * records each one and re-asks its check.
 */
export function startScripts(m: HomeModel, picked: ReadonlySet<string>): void {
  if (m.state.dialog !== undefined) return;
  const names: string[] = [];
  const rows: PaneItem[] = [];
  for (const step of m.state.scripts) {
    if (picked.has(step.name)) {
      names.push(step.name);
      rows.push({ name: step.name, text: step.description });
    }
  }
  if (names.length === 0) {
    hey(m, "nothing ticked — space ticks a script, a ticks them all");
    return;
  }
  ask(m, { kind: app.PaneScripts, args: names }, rows);
}

/**
 * startConfigs asks about writing the ticked configs, then hands off to
 * `loadout apply <names>`. A file edited on this machine would stop `apply`,
 * so it stops here, before anything runs, naming the file: which version
 * wins is the user's call, made in a terminal (`chezmoi re-add`, or
 * `loadout apply --force`).
 */
export function startConfigs(m: HomeModel, picked: ReadonlySet<string>): void {
  if (m.state.dialog !== undefined) return;
  const chosen = m.state.configs.filter((c) => picked.has(c.name));
  if (chosen.length === 0) {
    hey(m, "nothing ticked — space ticks a config, a ticks them all");
    return;
  }
  let edited: string[] | Promise<string[]>;
  try {
    if (m.app === undefined) throw new Error("no repo");
    const configs = m.app.configs();
    if (configs === undefined) edited = [];
    else {
      edited = (async () => {
        const units = await configs.units();
        const targets: string[] = [];
        for (const unit of units) if (chosen.some((c) => c.name === unit.name)) targets.push(...unit.targets);
        return configs.edited(targets);
      })();
    }
  } catch (e) {
    fail(m, firstLine(errorText(e)));
    return;
  }
  later(
    m,
    edited,
    (m, edited) => {
      // A refusal with a list: the toast says what happened, the dialog
      // lists the files.
      if (edited.length > 0) {
        fail(m, "edited on this machine: " + edited.join(", ") + " — keep with chezmoi re-add, or run loadout apply --force");
        m.state.dialog = newDialog({
          kind: DialogKind.List,
          title: "Edited here",
          lines: edited,
          summary: "Keep them with chezmoi re-add, or overwrite them with loadout apply --force, in a terminal.",
        });
        return;
      }
      if (m.state.dialog !== undefined) return;
      const names = chosen.map((c) => c.name);
      const rows = chosen.map((config) => {
        let text = "not checked";
        if (config.status === configDrifted) text = config.files.join(", ");
        else if (config.status === configApplied) text = "already applied · written again";
        return { name: config.name, text };
      });
      ask(m, { kind: app.PaneConfigs, args: names }, rows);
    },
    (m, e) => fail(m, firstLine(errorText(e))),
  );
}

/**
 * openInBrowser hands url to the desktop (xdg-open, else open) in the
 * background and says how it went: the opener's own last line when it fails
 * — a Qt "could not connect to display" was once a silent core dump behind
 * "opened …" — with the URL kept on screen to copy by hand.
 */
export function openInBrowser(m: HomeModel, url: string): void {
  if (m.app === undefined) return;
  const runner = m.app.runner;
  m.jobs.start(async () => {
    let result: exec.ExecResult;
    try {
      result = await runner.capture(
        exec.line(`sh -c 'command -v xdg-open >/dev/null 2>&1 && exec xdg-open "$1" || exec open "$1"' sh ` + app.shQuote(url) + " </dev/null", ""),
      );
    } catch (e) {
      return new SayMsg(style.ToastKind.Error, `could not open a browser (${firstLine(errorText(e))}) — ${url}`);
    }
    if (exec.success(result)) return new SayMsg(style.ToastKind.OK, "opened " + url);
    let said = "";
    for (const line of (result.stderr + result.stdout).split("\n")) {
      const t = line.trim();
      if (t !== "") said = t;
    }
    if (said === "") said = `exit ${result.exitCode}`;
    return new SayMsg(style.ToastKind.Error, `could not open a browser (${said}) — ${url}`);
  });
}

/**
 * upgradeItem is the question's row for one upgrade step. A sweep says how
 * much moves and how much of it is yours ("all 168 packages · 2 in your
 * loadout"); a source item gives its version change.
 */
export function upgradeItem(step: engine.UpgradeStep, ans: Answered): PaneItem {
  if (step.program) {
    const name = step.covers[0]!;
    for (const row of ans.updates) {
      if (row.name === name && !isSource(ans, row.source)) return { name, text: name + " " + row.current + " → " + row.candidate };
    }
    return { name, text: name };
  }
  if (!step.sweep) {
    const source = step.installers[0]!;
    const item = step.covers[0]!;
    for (const row of ans.updates) {
      if (row.source === source && row.name === item) return { name: source, text: item + " " + row.current + " → " + row.candidate };
    }
    return { name: source, text: item };
  }
  // A custom source's row never counts toward a mechanism, even when named like a program.
  let mine = 0;
  for (const row of ans.updates) {
    const mechanism = ans.mechanismOf.get(row.name);
    if (mechanism !== undefined && !isSource(ans, row.source) && step.installers.includes(mechanism)) mine++;
  }
  const yours = mine === 0 ? "none in your loadout" : `${mine} in your loadout`;
  // A total only when this step covers the whole tool: a tool split over two
  // commands (formulae and casks) can't divide its total between them.
  const tools = ans.tools.filter((tool) => tool.installers.some((i) => step.installers.includes(i)));
  let whole = tools.length > 0;
  let total = 0;
  for (const tool of tools) {
    if (tool.total === undefined || !allIn(tool.installers, step.installers)) whole = false;
    if (tool.total !== undefined) total += tool.total;
  }
  if (whole) return { name: engine.stepLabel(step), text: `all ${total} package${plural(total)} · ${yours}` };
  return { name: engine.stepLabel(step), text: "every package it manages · " + yours };
}

/**
 * scriptRowsOf is the scripts row's picker — this machine's opted-in
 * maintain-mode scripts in run order, each with the verdict the last
 * observation wrote down (never observed = "", which is unproven, not done).
 */
export function scriptRowsOf(manifest: Manifest, system: SystemInfo, observed: MachineState | undefined): ScriptRow[] {
  const machine = manifest.machines.get(system.machine);
  if (machine === undefined) return [];
  const enabled = scriptArgs(machine);
  const rows: ScriptRow[] = [];
  for (const name of scriptOrder(manifest, [...enabled.keys()])) {
    const args = enabled.get(name);
    const step = manifest.scripts.get(name);
    if (args === undefined || step === undefined || !runsIn(step, "maintain")) continue;
    const row: ScriptRow = { name, command: shownLine(engine.commandFor(step, args)), description: step.description, status: "" };
    const verdict = observed?.scripts.get(name);
    if (verdict !== undefined) row.status = verdict.status;
    rows.push(row);
  }
  return rows;
}

/**
 * missingRowsOf is the programs row's picker — every mapped program the last
 * observation found missing, in manifest order, with the command its mapped
 * variant would run (dependencies are the engine's business when the ticks
 * are planned).
 */
export function missingRowsOf(manifest: Manifest, system: SystemInfo, observed: MachineState | undefined): ProgramRow[] {
  const mapping = manifest.machines.get(system.machine)?.pm ?? new Map<string, string>();
  const rows: ProgramRow[] = [];
  for (const name of manifest.programs.keys()) {
    const key = mapping.get(name);
    if (key === undefined || observed === undefined) continue;
    if (observed.programs.get(name)?.status !== missing) continue;
    const command = resolveInstall(manifest, name, key).command ?? "";
    rows.push({ name, installKey: key, command, status: missing, version: "" });
  }
  return rows;
}

/**
 * programRowsOf is the programs list — every program this machine maps, with
 * its last verdict: missing ones first (in manifest order, as missingRowsOf),
 * then the rest.
 */
export function programRowsOf(manifest: Manifest, system: SystemInfo, observed: MachineState | undefined): ProgramRow[] {
  const mapping = manifest.machines.get(system.machine)?.pm ?? new Map<string, string>();
  const rows = missingRowsOf(manifest, system, observed);
  for (const name of manifest.programs.keys()) {
    const key = mapping.get(name);
    if (key === undefined) continue;
    const row: ProgramRow = { name, installKey: key, command: resolveInstall(manifest, name, key).command ?? "", status: "", version: "" };
    const state = observed?.programs.get(name);
    if (state !== undefined) {
      if (state.status === missing) continue;
      row.status = state.status;
      if (state.version !== undefined) row.version = state.version;
    }
    rows.push(row);
  }
  return rows;
}

/** preselect ticks anything not known-done: that IS the work. */
export function preselect(rows: readonly ScriptRow[]): Set<string> {
  return new Set(rows.filter((r) => r.status !== done).map((r) => r.name));
}

/** configItemsOf is the configs row's picker — every unit the last observation saw, by name. */
export function configItemsOf(observed: MachineState | undefined): ConfigItem[] {
  if (observed === undefined) return [];
  return sortStrings([...observed.configs.keys()]).map((name) => {
    const config = observed.configs.get(name)!;
    return { name, status: config.status, files: config.files };
  });
}

/** preselectConfigs ticks drifted configs; an unchecked one can't promise anything to write. */
export function preselectConfigs(rows: readonly ConfigItem[]): Set<string> {
  return new Set(rows.filter((r) => r.status === configDrifted).map((r) => r.name));
}

/** RemoteKind is what one line of the remote table is. */
export enum RemoteKind {
  /** Tool is a tool line (dnf, brew…) with everything it reported. */
  Tool = 0,
  /** Program is a declared program under its tool. */
  Program = 1,
  /** Others is what the sweep touches that loadout doesn't declare — enter lists them all. */
  Others = 2,
  /**
   * Source is a custom source's heading. Its items tick one at a time, and
   * the heading ticks all of them at once (itemKeys; empty = read-only
   * source).
   */
  Source = 3,
  /** Gap is breathing room between groups. */
  Gap = 4,
  /** Item is one of a custom source's items. */
  Item = 5,
}

/**
 * RemoteLine is one line of the remote table. The table is grouped by what
 * will ACT: a tool line with everything it reported, its declared programs
 * under it, a note for what it would touch beyond them; then each custom
 * source with its items. key is what ticking selects ("" = can't).
 */
export interface RemoteLine {
  kind: RemoteKind;
  key: string;
  /** group is the group this line belongs to — what h folds and l unfolds; "" = none. */
  group: string;
  /**
   * foldable says folding this heading would hide anything. A clean tool
   * heads no rows, so a chevron on it promises content that doesn't exist —
   * and folding is filtered by group, which can't tell "folded, nothing
   * hidden" from "folded, rows hidden" once the rows are gone.
   */
  foldable: boolean;
  /** info is a Tool line's tool. */
  info: ToolUpdates;
  /** row is a Program or Item line's row. */
  row: app.UpdateRow;
  /** tool and names are an Others line's tool and package names. */
  tool: string;
  names: string[];
  /** name and itemKeys are a Source heading's source and its items' keys. */
  name: string;
  itemKeys: string[];
}

const noTool: ToolUpdates = { tool: "", installers: [], declared: [], others: [] };
const noRow: app.UpdateRow = { name: "", current: "", candidate: "", source: "", note: "" };

function remoteLine(l: Partial<RemoteLine> & { kind: RemoteKind }): RemoteLine {
  return { key: "", group: "", foldable: false, info: noTool, row: noRow, tool: "", names: [], name: "", itemKeys: [], ...l };
}

/** focusable says the line is a cursor stop. */
export function focusable(l: RemoteLine): boolean {
  return l.kind !== RemoteKind.Gap;
}

/** heading says the line stays when its group is folded. */
export function heading(l: RemoteLine): boolean {
  return l.kind === RemoteKind.Tool || l.kind === RemoteKind.Source;
}

/** refusal is why ticking does nothing, when it does nothing ("" = it ticks). */
export function refusal(l: RemoteLine): string {
  switch (l.kind) {
    case RemoteKind.Tool:
      if (l.key === "") return l.info.tool + " declares no upgrade command";
      break;
    case RemoteKind.Program:
      if (l.key === "") return l.row.name + " has no mechanism loadout can upgrade";
      break;
    case RemoteKind.Others:
      return "nothing to tick — enter lists them";
    case RemoteKind.Source:
      if (l.itemKeys.length === 0) return l.name + " can't update its items from loadout";
      break;
    case RemoteKind.Item:
      if (l.key === "") return l.row.source + " can't update its items from loadout";
      break;
  }
  return "";
}

/** link is a page about this row's change, when its source printed one. */
export function link(l: RemoteLine): string {
  if (l.kind === RemoteKind.Item && l.row.link !== undefined) return l.row.link;
  return "";
}

/**
 * remoteLines is the remote table as lines — tools first (every one asked,
 * clean ones too), then sources. A group in collapsed keeps only its heading.
 */
export function remoteLines(ans: Answered, collapsed: ReadonlySet<string> | undefined): RemoteLine[] {
  const folded = (g: string) => collapsed?.has(g) ?? false;
  const lines: RemoteLine[] = [];
  const placed = new Set<number>();
  // A tool no batch oracle described (per-package oracles only) still heads
  // its programs — it just can't say how many others it would move.
  const described = new Set(ans.tools.map((t) => t.tool));
  const undescribed: ToolUpdates[] = [];
  for (const row of ans.updates) {
    const tool = toolOfRow(ans, row.name);
    if (tool === "" || described.has(tool)) continue;
    let t = undescribed.find((u) => u.tool === tool);
    if (t === undefined) {
      t = { tool, installers: ans.mechanismsOfTool.get(tool) ?? [], declared: [], others: [], command: "" };
      undescribed.push(t);
    }
    t.declared = [...t.declared, row.name];
  }
  // A blank line between groups, except between two QUIET ones — up to
  // date, or folded: one-liners read better stacked.
  let previousQuiet = true;
  const gap = (quiet: boolean) => {
    if (lines.length > 0 && !(previousQuiet && quiet)) lines.push(remoteLine({ kind: RemoteKind.Gap }));
    previousQuiet = quiet;
  };
  for (const tool of [...ans.tools, ...undescribed]) {
    const group = "tool:" + tool.tool;
    gap(tool.total === 0 || folded(group));
    const key = tool.command !== undefined && ans.mechanismsOfTool.has(tool.tool) ? group : "";
    // Its rows, before its heading: the heading has to say whether it heads
    // anything. Sources keep their own rows — read-only included.
    const rows: number[] = [];
    ans.updates.forEach((row, i) => {
      if (
        !placed.has(i) &&
        !isSource(ans, row.source) &&
        row.source !== "release" &&
        (toolOfRow(ans, row.name) === tool.tool || tool.declared.includes(row.name))
      ) {
        rows.push(i);
      }
    });
    lines.push(remoteLine({ kind: RemoteKind.Tool, info: tool, key, group, foldable: rows.length > 0 || tool.others.length > 0 }));
    for (const i of rows) {
      lines.push(remoteLine({ kind: RemoteKind.Program, row: ans.updates[i]!, key, group }));
      placed.add(i);
    }
    if (tool.others.length > 0) lines.push(remoteLine({ kind: RemoteKind.Others, tool: tool.tool, names: tool.others, group }));
  }
  // Everything else, grouped by source: the binary's own row, custom
  // sources, and programs whose mechanism no tool line claimed.
  const sources: string[] = [];
  const bySource = new Map<string, app.UpdateRow[]>();
  ans.updates.forEach((row, i) => {
    if (placed.has(i)) return;
    if (!bySource.has(row.source)) sources.push(row.source);
    bySource.set(row.source, [...(bySource.get(row.source) ?? []), row]);
  });
  for (const source of sources) {
    const rows = bySource.get(source)!;
    const group = "source:" + source;
    gap(folded(group));
    const keys = rows.map((row) => selectionKey(ans, row)).filter((k) => k !== "");
    // A source exists only because it has rows.
    lines.push(remoteLine({ kind: RemoteKind.Source, name: source, itemKeys: keys, group, foldable: true }));
    for (const row of rows) lines.push(remoteLine({ kind: RemoteKind.Item, row, key: selectionKey(ans, row), group }));
  }
  return lines.filter((l) => !(!heading(l) && l.group !== "" && folded(l.group)));
}

/**
 * selectionKey is what ticking row selects. A package row selects the TOOL
 * behind it (dnf, brew — the sweep upgrades all of it); a custom source's row
 * selects just that row, because its items are independent. "" = loadout
 * can't upgrade it at all.
 */
export function selectionKey(ans: Answered, row: app.UpdateRow): string {
  if (row.source === "release") return "";
  // A program with its own upgrade moves alone, never through its installer's sweep.
  if (ans.programUpgrades.has(row.name) && !isSource(ans, row.source)) return "prog:" + row.name;
  // A source's row ticks itself or nothing at all. It never falls through to
  // a tool: sharing a name with a mapped program would otherwise tick that
  // program's sweep, which cannot move what the source tracks.
  const upgradable = ans.sources.get(row.source);
  if (upgradable !== undefined) return upgradable ? "item:" + row.source + "/" + row.name : "";
  const tool = toolOfRow(ans, row.name);
  if (tool === "") return "";
  return "tool:" + tool;
}

/**
 * FleetLine is one row of the fleet table: a drifting program (program
 * set), or a config drifted somewhere (config set).
 */
export interface FleetLine {
  program?: diff.ProgramRow;
  config?: diff.ConfigRow;
}

/** fleetLineName is the program's or the config unit's. */
export function fleetLineName(l: FleetLine): string {
  if (l.program !== undefined) return l.program.program;
  return l.config!.unit;
}

/**
 * driftedRows is the drifting half of the fleet comparison — the only part
 * the table shows. Programs, then configs.
 */
export function driftedRows(s: Pick<HomeState, "fleet">): FleetLine[] {
  if (s.fleet === undefined) return [];
  const rows: FleetLine[] = [];
  for (const row of s.fleet.rows) if (diff.drift(row) || diff.incomplete(row)) rows.push({ program: row });
  for (const row of s.fleet.configs) if (diff.drifted(row)) rows.push({ config: row });
  return rows;
}

/** summaryWidth is all a subject line gets for its answer, so the summary can fit itself. */
export const summaryWidth = 41;

const sep = " · ";

/**
 * remoteSummary is the remote row's one line, ordered by what the reader can
 * do about it: a tool is ONE command for every package it has, so it leads;
 * everything else takes an update each, counted and then named
 * biggest-group-first while the width lasts.
 *
 * A tool with nothing outdated is left OUT — naming it spent the line saying
 * there was no work ("brew 0 · 42 pins"), while the 42 that did have work
 * stayed anonymous. Counts of different kinds of work never merge into one
 * total either: "brew 3" is one keystroke, "42 more" is forty-two.
 */
export function remoteSummary(remote: Answered): string {
  // An undefined total is "no batch oracle can say", which is not the same
  // as idle — keep asking with a "?" rather than claiming it's clean.
  const head: string[] = [];
  for (const tool of remote.tools) {
    if (tool.total === undefined) head.push(tool.tool + " ?");
    else if (tool.total > 0) head.push(`${tool.tool} ${tool.total}`);
  }
  const tools = head.length;
  const singles = remote.updates.filter((row) => isSource(remote, row.source) || row.source === "release" || !remote.mechanismOf.has(row.name));
  if (singles.length === 0) {
    // "more" only reads right after a count it adds to.
  } else if (tools > 0) head.push(`${singles.length} more`);
  else if (singles.length === 1) head.push("1 update");
  else head.push(`${singles.length} updates`);
  // A crashed source outranks the group names: it's the one thing on this
  // line that means the rest of the line may be understating the work.
  if (remote.failedSources === 1) head.push("1 source failed");
  else if (remote.failedSources > 1) head.push(`${remote.failedSources} sources failed`);
  if (head.length === 0) return "everything up to date";

  const counts = new Map<string, number>();
  const labels: string[] = [];
  for (const row of singles) {
    const label = groupLabel(row);
    if (!counts.has(label)) labels.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  labels.sort((a, b) => {
    const ca = counts.get(a)!;
    const cb = counts.get(b)!;
    if (ca !== cb) return cb - ca;
    return compareStrings(a, b);
  });
  let line = head.join(sep);
  let shown = 0;
  for (const label of labels) {
    const candidate = line + sep + `${label} ${counts.get(label)}`;
    if (runes(candidate) > summaryWidth) break;
    line = candidate;
    shown++;
  }
  // The marker counts the groups left, which the total can't say — but it
  // never costs a named group, since the total already implies "and more".
  if (shown >= 1 && shown < labels.length) {
    const marker = `${sep}+${labels.length - shown} more`;
    if (runes(line) + runes(marker) <= summaryWidth) line += marker;
  }
  return line;
}

/**
 * remoteShort is the remote row in a few cells: how many updates in all (a
 * tool's every package, plus each single row), or that none is waiting.
 */
export function remoteShort(remote: Answered): string {
  let total = 0;
  let unknownTotal = false;
  for (const tool of remote.tools) {
    if (tool.total === undefined) unknownTotal = true;
    else total += tool.total;
  }
  for (const row of remote.updates) {
    if (isSource(remote, row.source) || row.source === "release" || !remote.mechanismOf.has(row.name)) total++;
  }
  let short: string;
  if (total > 0) short = String(total);
  else if (unknownTotal) short = "?";
  else short = "up to date";
  if (remote.failedSources > 0) short += ` · ${remote.failedSources} failed`;
  return short;
}

/** groupLabel is where a row came from, as the reader knows it — not as the code keys it. */
function groupLabel(row: app.UpdateRow): string {
  return row.source === "release" ? "loadout" : row.source;
}

/** SectionOpts is sectionsOf's optional inputs. */
export interface SectionOpts {
  /** checking is the subjects whose checks are running: those rows spin. */
  checking?: ReadonlySet<string>;
  toolsDown?: engine.ToolDown[];
  /** withConfigs says the repo has `layout configs`. */
  withConfigs?: boolean;
}

/**
 * sectionsOf is the subject lines for a machine's observed state — programs,
 * scripts, configs (withConfigs: the repo has `layout configs`), remote,
 * fleet.
 */
export function sectionsOf(
  manifest: Manifest,
  system: SystemInfo,
  observed: MachineState | undefined,
  fleetReport: diff.DiffReport | undefined,
  remote: RemoteStatus,
  opts: SectionOpts,
): HomeSection[] {
  const programs = observed?.programs ?? new Map<string, ProgramState>();
  const scripts = observed?.scripts ?? new Map<string, ScriptState>();
  const configs = observed?.configs ?? new Map<string, ConfigState>();
  const toolsDown = opts.toolsDown ?? [];
  let missingN = 0;
  let installedN = 0;
  // Checks that couldn't run (their tool wasn't there): neither installed
  // nor missing, and nothing to install — the machine has to be fixed first.
  const unchecked: ProgramState[] = [];
  for (const state of programs.values()) {
    if (state.status === missing) missingN++;
    else if (state.status === installed) installedN++;
    else if (state.status === unknown && state.reason !== undefined) unchecked.push(state);
  }
  let unfinished = 0;
  let doneN = 0;
  for (const state of scripts.values()) {
    if (state.status === done) doneN++;
    else unfinished++;
  }
  // The picker lists maintain-mode scripts; a machine with none has nothing
  // to open, whatever setup-only scripts are pending (C for those).
  const pickable = scriptRowsOf(manifest, system, observed).length > 0;
  const mapped = manifest.machines.get(system.machine)?.pm.size ?? 0;
  let drifted = 0;
  let configsDrifted = 0;
  if (fleetReport !== undefined) {
    for (const row of fleetReport.rows) if (diff.drift(row) || diff.incomplete(row)) drifted++;
    for (const row of fleetReport.configs) if (diff.drifted(row)) configsDrifted++;
  }
  let configsOff = 0;
  let configsUnchecked = 0;
  let firstUnchecked: ConfigState | undefined;
  for (const state of configs.values()) {
    if (state.status === configDrifted) configsOff++;
    else if (state.status === configUnknown) {
      configsUnchecked++;
      firstUnchecked ??= state;
    }
  }
  const sections: HomeSection[] = [];

  // While the checks run the row is only the spinner, like the remote row: a
  // stale count next to it reads as the answer.
  let checking = opts.checking?.has(SubjectPrograms) ?? false;
  const programsRow = newSection({ subject: "programs", action: app.ActionNone, neutral: checking, busy: checking });
  if (checking) {
    // the spinner
  } else if (observed === undefined) {
    programsRow.summary = `${mapped} mapped — not observed yet`;
    programsRow.short = `${mapped} mapped`;
  } else if (unchecked.length === 0) {
    programsRow.summary = `${installedN} installed · ${missingN} missing`;
  } else {
    programsRow.summary = `${installedN} installed · ${missingN} missing · ${unchecked.length} not checked`;
  }
  if (observed !== undefined && !checking) programsRow.short = `${installedN}/${mapped}`;
  if (checking) {
    // the spinner
  } else if (missingN > 0) {
    programsRow.verb = "install what's missing";
  } else if (unchecked.length > 0) {
    // Say what's wrong, not "nothing missing": the checks that failed never
    // answered. In loadout's words when the refresh asked the tool itself;
    // the shell's line otherwise (a stored state has no tools-down list).
    if (toolsDown.length > 0) {
      const down = toolsDown[0]!;
      programsRow.verb = down.onPath ? down.tool + " checks fail" : down.tool + " is not on PATH";
    } else {
      programsRow.verb = unchecked[0]!.reason!;
    }
  } else {
    programsRow.verb = "nothing missing";
  }
  if (missingN > 0) {
    programsRow.action = app.ActionInstallMissing;
    programsRow.severity = Severity.Severe;
  } else if (unchecked.length > 0) {
    programsRow.severity = Severity.Attention;
  }
  sections.push(programsRow);

  checking = opts.checking?.has(SubjectScripts) ?? false;
  const scriptsRow = newSection({ subject: "scripts", action: app.ActionNone, neutral: checking, busy: checking });
  if (checking) {
    // the spinner
  } else if (observed === undefined) {
    scriptsRow.summary = "not observed yet";
  } else {
    scriptsRow.summary = `${doneN} done · ${unfinished} pending`;
    scriptsRow.short = `${doneN}/${doneN + unfinished}`;
  }
  if (checking) {
    // the spinner
  } else if (unfinished === 0) scriptsRow.verb = "nothing pending";
  else scriptsRow.verb = "run what's pending";
  if (pickable) scriptsRow.action = app.ActionRunScripts;
  if (unfinished > 0) scriptsRow.severity = Severity.Attention;
  sections.push(scriptsRow);

  checking = opts.checking?.has(SubjectConfigs) ?? false;
  if (opts.withConfigs) {
    const configsRow = newSection({ subject: "configs", action: app.ActionApplyConfigs, neutral: checking, busy: checking });
    if (checking) {
      // the spinner
    } else if (configs.size === 0) {
      configsRow.summary = "not observed yet";
    } else if (configsUnchecked > 0) {
      configsRow.summary = `${configs.size - configsOff - configsUnchecked} applied · ${configsOff} drifted · ${configsUnchecked} not checked`;
    } else {
      configsRow.summary = `${configs.size - configsOff} applied · ${configsOff} drifted`;
    }
    if (checking || configs.size === 0) {
      // no count
    } else if (configsOff > 0) configsRow.short = `${configsOff} drifted`;
    else if (configsUnchecked > 0) configsRow.short = `${configsUnchecked} not checked`;
    else configsRow.short = `${configs.size} applied`;
    if (checking) {
      // the spinner
    } else if (configsOff > 0) {
      configsRow.verb = "apply what's drifted";
    } else if (configsUnchecked > 0) {
      configsRow.verb = firstUnchecked!.reason ?? "not checked";
    } else {
      configsRow.verb = "nothing drifted";
    }
    if (configs.size === 0) configsRow.action = app.ActionNone;
    if (configsOff > 0 || configsUnchecked > 0) configsRow.severity = Severity.Attention;
    sections.push(configsRow);
  }

  const remoteRow = newSection({ subject: "remote", verb: "review them", action: app.ActionReviewOutdated });
  switch (remote?.kind) {
    case undefined:
      remoteRow.summary = "not asked yet";
      remoteRow.short = "not asked";
      remoteRow.neutral = true;
      break;
    // Empty on purpose: the row shows the spinner instead.
    case "asking":
      remoteRow.verb = "";
      remoteRow.neutral = true;
      remoteRow.busy = true;
      break;
    case "unavailable":
      remoteRow.summary = "unavailable — " + remote.reason;
      remoteRow.short = "unavailable";
      remoteRow.neutral = true;
      break;
    case "answered": {
      remoteRow.summary = remoteSummary(remote);
      remoteRow.short = remoteShort(remote);
      const outdated = remote.updates.length > 0 || remote.tools.some((t) => t.total !== undefined && t.total > 0);
      if (remote.failedSources > 0) remoteRow.severity = Severity.Severe;
      else if (outdated) remoteRow.severity = Severity.Attention;
      break;
    }
  }
  sections.push(remoteRow);

  const fleetRow = newSection({ subject: "fleet", verb: "compare the fleet", action: app.ActionShowDiff });
  if (fleetReport === undefined) fleetRow.summary = "no state files yet";
  else if (drifted === 0 && configsDrifted === 0) fleetRow.summary = `${fleetReport.machines.length} machine(s) in sync`;
  else if (configsDrifted === 0) fleetRow.summary = `${drifted} program(s) drifted across ${fleetReport.machines.length} machines`;
  else if (drifted === 0) fleetRow.summary = `${configsDrifted} config(s) drifted across ${fleetReport.machines.length} machines`;
  else fleetRow.summary = `${drifted} program(s) · ${configsDrifted} config(s) drifted`;
  if (fleetReport === undefined) fleetRow.short = "no states";
  else if (drifted + configsDrifted > 0) fleetRow.short = `${drifted + configsDrifted} drifted`;
  else fleetRow.short = `${fleetReport.machines.length} in sync`;
  if (fleetReport === undefined) {
    fleetRow.verb = "nothing to compare";
    fleetRow.action = app.ActionNone;
  }
  if (drifted > 0 || configsDrifted > 0) fleetRow.severity = Severity.Attention;
  sections.push(fleetRow);
  return sections;
}

// ---------------------------------------------------------------- helpers

/** runes is s's length in code points. */
export function runes(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function plural(n: number): string {
  return n === 1 ? "" : "s";
}

export function firstLine(s: string): string {
  const at = s.indexOf("\n");
  return at < 0 ? s : s.slice(0, at);
}

function firstLineOr(s: string, fallback: string): string {
  const line = firstLine(s);
  return line !== "" ? line : fallback;
}

/** errorText is an error's message, as Go's err.Error(). */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function allIn(xs: readonly string[], within: readonly string[]): boolean {
  return xs.every((x) => within.includes(x));
}

/** namesSet is rows' names, as a set (Go's namesOf). */
export function namesSet(rows: readonly { name: string }[]): Set<string> {
  return new Set(rows.map((r) => r.name));
}

/** withKeys is s plus keys, as a new set: a state's sets are never changed in place. */
export function withKeys(s: ReadonlySet<string> | undefined, ...keys: string[]): Set<string> {
  return new Set([...(s ?? []), ...keys]);
}

/** without is s minus keys, as a new set. */
export function without(s: ReadonlySet<string> | undefined, ...keys: string[]): Set<string> {
  return new Set([...(s ?? [])].filter((k) => !keys.includes(k)));
}

export function toggled(s: ReadonlySet<string>, key: string): Set<string> {
  return s.has(key) ? without(s, key) : withKeys(s, key);
}

export function containsAll(s: ReadonlySet<string>, keys: readonly string[]): boolean {
  return keys.every((k) => s.has(k));
}

/** withValue is s with key set to v, as a new map: a state's maps are never changed in place. */
export function withValue<V>(s: ReadonlyMap<string, V>, key: string, v: V): Map<string, V> {
  return new Map([...s, [key, v]]);
}
