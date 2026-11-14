import { expect, test } from "bun:test";
import * as app from "../app/index.ts";
import { newMachineState, type MachineState, type ScriptState, type ScriptStatus, type SystemInfo } from "../core/coremodel/coremodel.ts";
import { manifestOf, pm, via } from "../core/coretest/coretest.ts";
import type * as diff from "../core/diff/diff.ts";
import type * as engine from "../core/engine/index.ts";
import type { Manifest } from "../model/index.ts";
import { strip, stringWidth } from "./style/ansi.ts";
import * as style from "./style/index.ts";
import { KeyEnd, KeyHome, KeyPressMsg, ModCtrl, ModShift, type Cmd, type Msg } from "./messages.ts";
import { ExitMsg, type Cursor, type TermCommand } from "./term/term.ts";
import {
  answered,
  apply,
  asking,
  configItemsOf,
  driftedRows,
  fleetLineName,
  FocusArea,
  type HomeModel,
  type HomeSection,
  type HomeState,
  link,
  missingRowsOf,
  newAnswered,
  newHomeModel,
  newHomeState,
  newSection,
  newToolUpdates,
  PartMsg,
  preselect,
  preselectConfigs,
  programRowsOf,
  RemoteKind,
  type RemoteLine,
  type RemoteStatus,
  refusal,
  remoteLines,
  remoteSummary,
  codePoints,
  scriptRowsOf,
  sectionsOf,
  selectionKey,
  setStateForTest,
  SayMsg,
  Severity,
  startScripts,
  summaryWidth,
  unavailable,
  upgradeItem,
  withValue,
  withKeys,
} from "./homemodel.ts";
import { newJobs } from "./jobs.ts";
import { ask, DialogKind, dialogAsking, focus, handleKey, handleText, HomeKey, message, newDialog, paletteShown, typing } from "./keys.ts";
import { listOf, type Item, snap, SubjectConfigs, SubjectFleet, subjectOf, SubjectPrograms, SubjectRemote, SubjectScripts } from "./lists.ts";
import { MouseButton } from "./input.ts";
import { click, homeKeyOf, key, terminalCursor, terminalTakesKeys, wheel } from "./program.ts";
import { confirm, followUp, afterJobs, runExited, runsNewestFirst, type Terminal } from "./runs.ts";

import { fullHelp, inspectorLines, layout, resize, screenLines, shortHelp, sideHead, sidebarWidth, stacked, termSize, verdictCounts, wideMinWidth } from "./view.ts";
import { listHeight } from "./keys.ts";

const system: SystemInfo = { machine: "m1", os: "linux", distro: "fedora", arch: "x86_64" };

/**
 * manifestFor is git and kitty through dnf, a script with a check and a
 * setup-only one, on machine m1.
 */
function manifestFor(): Manifest {
  return manifestOf((b) => {
    b.program("git", { install: via("dnf") });
    b.program("kitty", { install: via("dnf") });
    b.script("dotfiles", { run: "true", check: "true" });
    b.script("bootstrap", { run: "true", modes: ["setup"] });
    b.machine("m1", { pm: pm("git", "dnf", "kitty", "dnf"), scripts: ["dotfiles", "bootstrap"] });
  });
}

function update(name: string, current: string, candidate: string, source = "dnf"): app.UpdateRow {
  return { name, current, candidate, source, note: "" };
}

function machineState(...scripts: [string, ScriptState][]): MachineState {
  return newMachineState({
    machine: "m1",
    os: "linux",
    distro: "fedora",
    arch: "x86_64",
    toolVersion: "0.0.0",
    updatedAt: "now",
    programs: new Map([
      ["git", { status: "installed", version: "2.55.0" }],
      ["kitty", { status: "missing" }],
    ]),
    scripts: new Map(scripts),
  });
}

function script(name: string, status: ScriptStatus): [string, ScriptState] {
  return [name, { status }];
}

function sectionNamed(sections: HomeSection[], subject: string): HomeSection {
  const s = sections.find((x) => x.subject === subject);
  if (s === undefined) throw new Error(`no ${subject} row in ${JSON.stringify(sections)}`);
  return s;
}

function subjects(sections: HomeSection[]): string[] {
  return sections.map((s) => s.subject);
}

function setOf(...keys: string[]): Set<string> {
  return withKeys(undefined, ...keys);
}

/** names is items' names. */
function names(items: readonly { name: string }[]): string[] {
  return items.map((i) => i.name);
}

// --------------------------------------------------------------- sections

test("each subject offers the verb that resolves it", () => {
  const sections = sectionsOf(manifestFor(), system, machineState(script("dotfiles", "pending")), undefined, undefined, {});
  expect(subjects(sections)).toEqual(["programs", "scripts", "remote", "fleet"]);

  const programs = sectionNamed(sections, "programs");
  expect(programs.action).toBe(app.ActionInstallMissing);
  expect(programs.severity).toBe(Severity.Severe);

  const scripts = sectionNamed(sections, "scripts");
  expect(scripts.action).toBe(app.ActionRunScripts);
  expect(scripts.severity).toBe(Severity.Attention);
});

test("settled subjects offer nothing", () => {
  const sections = sectionsOf(manifestFor(), system, machineState(script("dotfiles", "done")), undefined, undefined, {});
  const scripts = sectionNamed(sections, "scripts");
  // Settled, but still openable: ticking a done script is how you force it.
  expect(scripts.action).toBe(app.ActionRunScripts);
  expect(scripts.severity).toBe(Severity.Settled);
  // No state files to compare: the fleet row can't act either.
  expect(sectionNamed(sections, "fleet").action).toBe(app.ActionNone);
});

test("the configs row is there only for a repo with configs", () => {
  const manifest = manifestFor();
  const observed = machineState();
  observed.configs = new Map([
    ["tmux", { status: "applied", files: [] }],
    ["zsh", { status: "drifted", files: [".config/zsh/.zshrc"] }],
  ]);
  expect(subjects(sectionsOf(manifest, system, observed, undefined, undefined, {})).join(" ")).not.toContain("configs");

  const sections = sectionsOf(manifest, system, observed, undefined, undefined, { withConfigs: true });
  expect(subjects(sections)).toEqual(["programs", "scripts", "configs", "remote", "fleet"]);
  const configs = sectionNamed(sections, "configs");
  expect(configs.summary).toBe("1 applied · 1 drifted");
  expect(configs.verb).toBe("apply what's drifted");
  expect(configs.action).toBe(app.ActionApplyConfigs);
  expect(configs.severity).toBe(Severity.Attention);

  // chezmoi couldn't answer: its reason is the verb, never "nothing drifted".
  const down = machineState();
  down.configs = new Map([["zsh", { status: "unknown", files: [], reason: "chezmoi is not on PATH" }]]);
  const unchecked = sectionNamed(sectionsOf(manifest, system, down, undefined, undefined, { withConfigs: true }), "configs");
  expect(unchecked.verb).toBe("chezmoi is not on PATH");
  expect(unchecked.severity).toBe(Severity.Attention);
});

test("drifted configs start ticked and the fleet counts them", () => {
  const observed = machineState();
  observed.configs = new Map([
    ["zsh", { status: "drifted", files: [".zshrc"] }],
    ["kitty", { status: "applied", files: [] }],
    ["nvim", { status: "unknown", files: [], reason: "x" }],
  ]);
  const items = configItemsOf(observed);
  expect(names(items)).toEqual(["kitty", "nvim", "zsh"]);
  expect(preselectConfigs(items)).toEqual(setOf("zsh"));

  const fleet: diff.DiffReport = {
    machines: ["a", "b"],
    rows: [],
    configs: [
      {
        unit: "zsh",
        perMachine: new Map([
          ["a", { kind: "drifted", files: 1 }],
          ["b", { kind: "applied", files: 0 }],
        ]),
      },
    ],
  };
  const row = sectionNamed(sectionsOf(manifestFor(), system, machineState(), fleet, undefined, {}), "fleet");
  expect(row.summary).toBe("1 config(s) drifted across 2 machines");
  expect(row.severity).toBe(Severity.Attention);
  const drifted = driftedRows({ fleet });
  expect(drifted.length).toBe(1);
  expect(fleetLineName(drifted[0]!)).toBe("zsh");
});

test("the remote row follows the answer as it arrives", () => {
  const manifest = manifestFor();
  const remote = (status: RemoteStatus) => sectionNamed(sectionsOf(manifest, system, machineState(), undefined, status, {}), "remote");
  // Unknown until answered — never a green tick for "haven't asked".
  expect(remote(undefined).neutral).toBe(true);
  expect(remote(asking).neutral).toBe(true);
  expect(remote(unavailable("offline")).neutral).toBe(true);

  const ans = remote(newAnswered({ updates: [update("kitty", "0.48.2", "0.49.0"), update("loadout", "0.9.1", "0.9.2")] }));
  expect(ans.summary).toBe("2 updates · dnf 2");
  expect(ans.severity).toBe(Severity.Attention);

  const clean = remote(newAnswered());
  expect(clean.summary).toBe("everything up to date");
  expect(clean.severity).toBe(Severity.Settled);

  // A broken oracle is worse than an outdated package: it hides them.
  const broken = remote(newAnswered({ updates: [update("kitty", "1", "2")], failedSources: 1 }));
  expect(broken.severity).toBe(Severity.Severe);
});

// ---------------------------------------------------------- remote summary

// The remote row's line answers "where is the work", so a tool with none is
// not news — the live mac shipped "brew 0 · 42 pins", naming the only thing
// with nothing to do and leaving the 42 that did anonymous.

interface SummaryCase {
  brew?: number;
  failedSources?: number;
  counts?: [string, number][];
}

/** liveShape is the live repo's shape: brew, plus five custom sources. */
const liveShape: [string, number][] = [
  ["nvim-plugins", 15],
  ["asdf-tools", 10],
  ["antidote-plugins", 9],
  ["asdf-plugins", 7],
  ["antidote", 1],
];

function summaryAnswered(c: SummaryCase) {
  const ans = newAnswered({
    failedSources: c.failedSources ?? 0,
    tools: [newToolUpdates({ tool: "brew", installers: ["brew"], total: c.brew, command: "brew upgrade" })],
  });
  for (const [source, n] of c.counts ?? []) {
    for (let i = 1; i <= n; i++) ans.updates.push({ name: "item" + String.fromCharCode(0x30 + i), current: "1", candidate: "2", source, note: "" });
    ans.sources.set(source, true);
  }
  return ans;
}

test("an idle tool is left out and the work is named", () => {
  const line = remoteSummary(summaryAnswered({ brew: 0, counts: liveShape }));
  expect(line).toBe("42 updates · nvim-plugins 15 · +4 more");
  expect(line).not.toContain("brew"); // a tool with nothing outdated is not news
  expect(codePoints(line)).toBeLessThanOrEqual(summaryWidth);
});

test("a tool with work leads and its count stays its own", () => {
  // One keystroke fixes brew's 3; the other 42 are 42 decisions. A single
  // "45 behind" would say they're the same kind of work, and ranking brew
  // purely by size would bury the cheapest win.
  const line = remoteSummary(summaryAnswered({ brew: 3, counts: liveShape }));
  expect(line).toBe("brew 3 · 42 more · nvim-plugins 15");
  expect(codePoints(line)).toBeLessThanOrEqual(summaryWidth);
});

test("nothing outdated reads as settled even while tools exist", () => {
  expect(remoteSummary(summaryAnswered({ brew: 0 }))).toBe("everything up to date");
});

test("a crashed source outranks the group names", () => {
  // It's the one item here that means the rest of the line understates the
  // work, so it must survive the width, plural and all.
  expect(remoteSummary(summaryAnswered({ brew: 0, failedSources: 1, counts: liveShape }))).toBe("42 updates · 1 source failed");
  expect(remoteSummary(summaryAnswered({ brew: 0, failedSources: 2, counts: liveShape }))).toContain("2 sources failed");
});

test("an unaskable tool keeps asking rather than reading as clean", () => {
  // No batch oracle can say — which is not the same as "nothing to do".
  expect(remoteSummary(summaryAnswered({ counts: liveShape })).startsWith("brew ?")).toBe(true);
});

test("the binary's own row is called loadout, not its channel", () => {
  const line = remoteSummary(newAnswered({ updates: [update("loadout", "0.12.0", "0.13.0", "release")] }));
  expect(line).toBe("1 update · loadout 1");
});

test("long source names lose the marker, not the column", () => {
  const line = remoteSummary(
    summaryAnswered({
      brew: 0,
      counts: [
        ["some-very-long-source-name", 3],
        ["another-long-one", 2],
      ],
    }),
  );
  expect(codePoints(line)).toBeLessThanOrEqual(summaryWidth); // spilling the column clips mid-word
  expect(line).toBe("5 updates · some-very-long-source-name 3");
});

// ------------------------------------------------------------------- keys

/**
 * modelOf is a HomeModel over sections with no repo behind it: the reducers
 * are pure over state. The main pane has the focus.
 */
function modelOf(sections: HomeSection[]): HomeModel {
  const m = newHomeModel(undefined, true);
  setStateForTest(m, newHomeState({ sections, focus: FocusArea.Main, dark: true, sideRun: 0 }));
  return m;
}

/** withState replaces m's state, keeping the main pane focused. */
function withState(m: HomeModel, s: Partial<HomeState>): HomeModel {
  const state = newHomeState({ sideRun: 0, ...s });
  if (state.focus === FocusArea.Sidebar) state.focus = FocusArea.Main;
  state.dark = true;
  setStateForTest(m, state);
  return m;
}

/** focusOf is m's focus, unnarrowed (tests set it, then press keys). */
function focusOf(m: HomeModel): FocusArea {
  return m.state.focus;
}

function press(m: HomeModel, ...keys: HomeKey[]): void {
  for (const k of keys) handleKey(m, k);
}

/** current is the main list's row under the cursor, as an Item. */
function current(m: HomeModel): Item {
  const subject = subjectOf(m.state);
  const items = listOf(m.state, subject);
  const at = snap(items, m.state.cursors.get(subject) ?? 0);
  if (at < 0) return { index: -1, name: "", focusable: false, heading: false, matches: [] };
  return items[at]!;
}

/** remoteRowOf is the remote line under the cursor. */
function remoteRowOf(m: HomeModel): RemoteLine {
  return remoteLines(answered(m.state.remote)!, m.state.collapsed)[current(m).index]!;
}

function remoteKinds(lines: RemoteLine[]): string[] {
  return lines.map((l) => RemoteKind[l.kind]);
}

function toastKind(m: HomeModel): style.ToastKind {
  return m.toasts.message()[0];
}

const subjectsAll: HomeSection[] = [SubjectPrograms, SubjectScripts, SubjectConfigs, SubjectRemote, SubjectFleet].map((subject) => newSection({ subject }));

test("the sidebar picks the subject the main pane shows", () => {
  const m = modelOf(subjectsAll);
  m.state.focus = FocusArea.Sidebar;
  press(m, HomeKey.Down, HomeKey.Down);
  expect(subjectOf(m.state)).toBe(SubjectConfigs); // moving in the sidebar switches the main pane at once
  press(m, HomeKey.Up);
  expect(subjectOf(m.state)).toBe(SubjectScripts);
  press(m, HomeKey.Subject5);
  expect(subjectOf(m.state)).toBe(SubjectFleet); // 1–5 jump
  press(m, HomeKey.Subject1, HomeKey.Up);
  expect(subjectOf(m.state)).toBe(SubjectPrograms); // the first subject is the end of the road
  press(m, HomeKey.Open);
  expect(focusOf(m)).toBe(FocusArea.Main); // l goes into the list
  press(m, HomeKey.Esc);
  expect(focusOf(m)).toBe(FocusArea.Sidebar); // esc backs out to the sidebar
});

test("tab cycles the areas, and the terminal only while a run shows", () => {
  const m = modelOf(subjectsAll);
  m.state.focus = FocusArea.Sidebar;
  press(m, HomeKey.Tab);
  expect(focusOf(m)).toBe(FocusArea.Main);
  press(m, HomeKey.Tab);
  expect(focusOf(m)).toBe(FocusArea.Sidebar); // no run panel: two areas
  press(m, HomeKey.ShiftTab);
  expect(focusOf(m)).toBe(FocusArea.Main);

  const f = runSomething(m);
  expect(focusOf(m)).toBe(FocusArea.Terminal); // a run starts focused
  expect(f.focused).toBe(true);
  press(m, HomeKey.Leave);
  expect(focusOf(m)).toBe(FocusArea.Main); // ctrl+] leaves the terminal to the main pane
  expect(f.focused).toBe(false); // and the terminal stops taking keys
  press(m, HomeKey.Tab);
  expect(focusOf(m)).toBe(FocusArea.Terminal); // tab goes back in
  expect(f.focused).toBe(true);
});

test("esc never quits, only q does", () => {
  const m = modelOf(subjectsAll);
  press(m, HomeKey.Esc, HomeKey.Esc, HomeKey.Esc);
  expect(m.state.exit).toBe(false); // esc closes, never quits
  expect(message(m)).toContain("q quits");
  press(m, HomeKey.Interrupt);
  expect(m.state.exit).toBe(false); // ctrl+c by reflex doesn't kill the screen
  expect(message(m)).toBe("q quits");
  press(m, HomeKey.Quit);
  expect(m.state.exit).toBe(true);
});

const scriptRow = (name: string, more: Partial<{ command: string; description: string; status: ScriptStatus | "" }> = {}) => ({
  name,
  command: "",
  description: "",
  status: "" as ScriptStatus | "",
  ...more,
});

test("the filter narrows the list and underlines the match", () => {
  const m = withState(modelOf([]), { sections: subjectsAll, subject: 1, scripts: [scriptRow("pull"), scriptRow("keychron-access"), scriptRow("dotfiles")] });
  press(m, HomeKey.Filter);
  expect(m.state.filtering && typing(m)).toBe(true);
  handleText(m, "kc");
  const items = listOf(m.state, SubjectScripts);
  expect(items.length).toBe(1);
  expect(items[0]!.name).toBe("keychron-access");
  expect(items[0]!.matches).toEqual([0, 3]); // a fuzzy match, matched characters underlined
  press(m, HomeKey.Backspace);
  expect(names(listOf(m.state, SubjectScripts))).toEqual(["keychron-access"]); // backspace widens it again
  press(m, HomeKey.Enter);
  expect(m.state.filtering).toBe(false); // enter keeps the filter and gives the keys back
  expect(m.state.filters.get(SubjectScripts)).toBe("k");
  press(m, HomeKey.Esc);
  expect(m.state.filters.get(SubjectScripts)).toBe(""); // esc clears it
  expect(focusOf(m)).toBe(FocusArea.Main); // and only that
  expect(names(listOf(newHomeState({ scripts: m.state.scripts, filters: new Map([[SubjectScripts, "pl"]]) }), SubjectScripts))).toEqual(["pull"]);
});

test("the remote filter keeps a matching row's heading", () => {
  const ans = newAnswered({
    updates: [update("kitty", "1", "2"), update("bat", "1", "2"), update("ruby", "a", "b", "asdf-tools")],
    tools: [newToolUpdates({ tool: "dnf", installers: ["dnf"], total: 2, declared: ["kitty", "bat"], command: "dnf upgrade" })],
    mechanismOf: new Map([
      ["kitty", "dnf"],
      ["bat", "dnf"],
    ]),
    toolOf: new Map([["dnf", "dnf"]]),
    mechanismsOfTool: new Map([["dnf", ["dnf"]]]),
    sources: new Map([["asdf-tools", true]]),
  });
  const s = newHomeState({ remote: ans, filters: new Map([[SubjectRemote, "kit"]]) });
  expect(names(listOf(s, SubjectRemote))).toEqual(["dnf", "kitty"]);
  s.filters.set(SubjectRemote, "asdf");
  expect(names(listOf(s, SubjectRemote))).toEqual(["asdf-tools", "ruby"]); // a matching heading keeps its rows
});

test("the configs picker ticks one config or all and never runs nothing", () => {
  const m = newHomeModel(app.newApp("/repo", "", false), true);
  withState(m, {
    sections: [newSection({ subject: SubjectConfigs })],
    configs: [
      { name: "kitty", status: "applied", files: [] },
      { name: "zsh", status: "drifted", files: [".zshrc"] },
    ],
    applying: setOf("zsh"),
  });
  press(m, HomeKey.Select);
  expect(m.state.applying).toEqual(setOf("zsh", "kitty"));
  press(m, HomeKey.SelectNone);
  expect(m.state.applying.size).toBe(0);
  press(m, HomeKey.Enter);
  expect(message(m).startsWith("nothing ticked")).toBe(true);
  expect(m.state.dialog).toBeUndefined();

  // A repo whose configs can't be read says so and stays: no dialog, no run.
  press(m, HomeKey.SelectAll, HomeKey.Enter);
  expect(m.state.dialog).toBeUndefined();
  expect(m.active).toBeUndefined();
  expect(toastKind(m)).toBe(style.ToastKind.Error);
});

test("nothing fires while an answer is still coming", () => {
  // Enter used to dispatch `outdated` over the ask already running.
  const m = modelOf([newSection({ subject: SubjectRemote, busy: true })]);
  m.state.remote = asking;
  press(m, HomeKey.Enter);
  expect(m.state.dialog).toBeUndefined();
  expect(message(m)).toContain("still asking");
});

test("no row ever leaves the screen", () => {
  const m = withState(modelOf([]), {
    sections: [newSection({ subject: SubjectRemote }), newSection({ subject: SubjectFleet })],
    remote: unavailable("offline"),
  });
  press(m, HomeKey.Enter);
  expect(m.state.exit).toBe(false);
  expect(message(m)).toContain("r tries again");
  press(m, HomeKey.Subject2, HomeKey.Enter);
  expect(message(m)).toContain("nothing to run");
  expect(m.state.exit).toBe(false);
});

async function settle(m: HomeModel): Promise<void> {
  while (m.jobs.busy()) await Bun.sleep(1);
}

// Keys in update, answers from many jobs at once: every job's message
// lands, in order, on the state as it is — none is lost and none puts back a
// copy read before another write.
test("answers from many jobs are never lost", async () => {
  const m = modelOf([]);
  let started = 0;
  const got: string[] = [];
  for (let i = 0; i < 1000; i++) {
    m.jobs.start(async () => {
      started++;
      return new SayMsg(style.ToastKind.Hey, String(i));
    });
  }
  for (let i = 0; i < 1000; i++) {
    press(m, HomeKey.Theme);
    for (const msg of m.jobs.take()) {
      apply(m, msg);
      got.push(message(m));
    }
    if (i % 100 === 0) await Bun.sleep(0);
  }
  await settle(m);
  for (const msg of m.jobs.take()) {
    apply(m, msg);
    got.push(message(m));
  }
  expect(started).toBe(1000);
  expect(got.length).toBe(1000); // every job's answer lands
  expect(m.state.dark).toBe(true); // an even number of flips ends where it started
});

test("held jobs wait for the run and start after it", async () => {
  const j = newJobs();
  j.hold();
  let ran = false;
  j.start(async () => {
    ran = true;
    return null;
  });
  expect(j.busy()).toBe(false); // nothing starts beside a run
  await Bun.sleep(20);
  expect(ran).toBe(false); // a held job never ran
  j.release();
  await Bun.sleep(1);
  expect(ran).toBe(true); // the deferred job ran
});

// ---------------------------------------------------------------- dialogs

test("the confirm asks and esc changes nothing", () => {
  const m = withState(modelOf([]), {
    sections: [newSection({ subject: SubjectScripts })],
    scripts: [scriptRow("brew", { command: "sh setup-brew.sh" }), scriptRow("pull", { command: "sh pull" })],
  });
  startScripts(m, setOf("brew", "pull"));
  const d = m.state.dialog;
  expect(d !== undefined && dialogAsking(d)).toBe(true);
  expect(d!.items).toEqual([
    { name: "brew", text: "" },
    { name: "pull", text: "" },
  ]);
  expect(d!.closed.handoff).toEqual({ kind: app.PaneScripts, args: ["brew", "pull"] });
  // q on the question backs out like esc: it never leaves the screen.
  press(m, HomeKey.Quit);
  expect(m.state.dialog).toBeUndefined();
  expect(m.state.exit).toBe(false);
  expect(m.active).toBeUndefined(); // nothing ran
});

test("the confirm's buttons work like gum's", () => {
  const m = withState(modelOf([]), { sections: [newSection({ subject: SubjectScripts })], scripts: [scriptRow("pull")] });
  const ran: app.Closed[] = [];
  m.runCommand = (c) => {
    ran.push(c);
    return { argv: ["true"] };
  };
  m.newTerm = (w, h) => new FakeTerm(1, w, h);
  startScripts(m, setOf("pull"));
  expect(m.state.dialog!.cancelFocused).toBe(false); // Run is focused first: enter keeps meaning yes
  press(m, HomeKey.Close);
  expect(m.state.dialog!.cancelFocused).toBe(true);
  press(m, HomeKey.Tab);
  expect(m.state.dialog!.cancelFocused).toBe(false);
  press(m, HomeKey.Open, HomeKey.Enter);
  expect(m.state.dialog).toBeUndefined(); // enter on Cancel closes the question
  expect(ran.length).toBe(0); // and runs nothing
  startScripts(m, setOf("pull"));
  press(m, HomeKey.No);
  expect(m.state.dialog).toBeUndefined();
  startScripts(m, setOf("pull"));
  press(m, HomeKey.Close, HomeKey.Yes);
  expect(ran.length).toBe(1); // y runs whatever is focused
  expect(ran[0]!.handoff).toEqual({ kind: app.PaneScripts, args: ["pull"] });
});

test("a list row in the confirm opens its list", () => {
  const m = modelOf([]);
  ask(m, { kind: app.PaneUpgrade, args: ["dnf"] }, [
    { name: "dnf", text: "all 3 packages · 1 in your loadout" },
    { name: "", text: "⋯ 2 more not in your loadout", list: ["kernel", "glibc"] },
  ]);
  press(m, HomeKey.Down);
  expect(m.state.dialog!.row).toBe(1); // only the list row is a stop
  press(m, HomeKey.Enter);
  expect(m.state.dialog!.kind).toBe(DialogKind.List);
  expect(m.state.dialog!.lines).toEqual(["kernel", "glibc"]);
  press(m, HomeKey.Esc);
  expect(m.state.dialog!.kind).toBe(DialogKind.Confirm); // closing the list comes back to the question
  press(m, HomeKey.Up);
  expect(m.state.dialog!.row).toBe(-1); // back on the buttons
});

test("the palette filters and runs a command", () => {
  const m = modelOf(subjectsAll);
  press(m, HomeKey.Palette);
  expect(m.state.dialog!.kind).toBe(DialogKind.Palette);
  expect(typing(m)).toBe(true); // the palette's query takes typed text
  handleText(m, "fleet");
  const [shown] = paletteShown(m.state, m.state.dialog!.query);
  expect(shown[0]!.title).toBe("Go to fleet");
  press(m, HomeKey.Enter);
  expect(m.state.dialog).toBeUndefined();
  expect(subjectOf(m.state)).toBe(SubjectFleet);

  press(m, HomeKey.Palette);
  handleText(m, "theme");
  press(m, HomeKey.Enter);
  expect(m.state.dark).toBe(false); // toggle theme ran
  press(m, HomeKey.Palette, HomeKey.Esc);
  expect(m.state.dialog).toBeUndefined();
});

test("help is a dialog", () => {
  const m = modelOf(subjectsAll);
  press(m, HomeKey.Help);
  expect(m.state.dialog!.kind).toBe(DialogKind.Help);
  press(m, HomeKey.Help);
  expect(m.state.dialog).toBeUndefined(); // ctrl+g closes it again
});

test("machine-wide verbs ask first", () => {
  const cases: [HomeKey, app.HomeAction][] = [
    [HomeKey.Sync, app.ActionSync],
    [HomeKey.Upgrade, app.ActionUpgrade],
    [HomeKey.Converge, app.ActionSetup],
  ];
  for (const [k, action] of cases) {
    const m = modelOf(subjectsAll);
    press(m, k);
    const d = m.state.dialog;
    expect(d !== undefined && dialogAsking(d)).toBe(true); // the key asks
    expect(d!.closed.action).toBe(action);
    expect(m.state.exit).toBe(false);
  }
});

// ---------------------------------------------------------------- pickers

test("the programs list shows every program and ticks only the missing", () => {
  const rows = programRowsOf(manifestFor(), system, machineState());
  expect(names(rows)).toEqual(["kitty", "git"]); // the missing first
  expect(rows[0]!.status).toBe("missing");
  expect(rows[1]!.version).toBe("2.55.0");
  const missing = missingRowsOf(manifestFor(), system, machineState());
  expect(missing.length).toBe(1);
  expect(missing[0]!.command).toBe("sudo dnf install -y kitty");

  const m = withState(modelOf([]), { sections: [newSection({ subject: SubjectPrograms })], programs: rows, missing, chosen: setOf("kitty") });
  press(m, HomeKey.Select);
  expect(m.state.chosen.size).toBe(0);
  press(m, HomeKey.Enter);
  expect(m.state.dialog).toBeUndefined();
  expect(message(m)).toContain("nothing ticked");
  press(m, HomeKey.Down, HomeKey.Select);
  expect(message(m)).toContain("isn't missing");
  expect(m.state.chosen.size).toBe(0);
  press(m, HomeKey.SelectAll);
  expect(m.state.chosen).toEqual(setOf("kitty")); // a ticks what's missing
});

test("enter on the sidebar goes into the list, and only the list acts", () => {
  const m = withState(modelOf([]), {
    sections: [newSection({ subject: SubjectScripts })],
    picked: setOf("pull"),
    scripts: [scriptRow("pull", { command: "sh pull", status: "pending" })],
  });
  focus(m, FocusArea.Sidebar);
  press(m, HomeKey.Enter);
  expect(focusOf(m)).toBe(FocusArea.Main); // enter on a subject opens its list
  expect(m.state.dialog).toBeUndefined(); // and asks nothing: the ticks weren't in view
  press(m, HomeKey.Enter);
  expect(m.state.dialog).toBeDefined(); // enter in the list acts on its ticks
  expect(m.state.dialog!.items).toEqual([{ name: "pull", text: "" }]);
});

test("the scripts picker ticks one script at a time and enter asks", () => {
  const m = withState(modelOf([]), {
    sections: [newSection({ subject: SubjectScripts })],
    picked: setOf("pull"),
    scripts: [scriptRow("pull", { command: "sh pull", status: "pending" }), scriptRow("apply", { command: "sh apply", status: "done" })],
  });
  // space on a done script ticks it: that is the force.
  press(m, HomeKey.Down, HomeKey.Select);
  expect(m.state.picked).toEqual(setOf("pull", "apply"));
  press(m, HomeKey.SelectNone);
  expect(m.state.picked.size).toBe(0); // u clears
  press(m, HomeKey.SelectAll, HomeKey.Enter);
  const d = m.state.dialog!;
  expect(d.pane).toBe(app.PaneScripts);
  expect(d.items).toEqual([
    { name: "pull", text: "" },
    { name: "apply", text: "" },
  ]); // in run order, not tick order
  press(m, HomeKey.Esc);
  expect(m.state.picked).toEqual(setOf("pull", "apply")); // esc leaves the picks for another go
});

test("the arrows move the list and the window follows", () => {
  const scripts = Array.from({ length: 30 }, (_, i) => scriptRow(`s${String(i).padStart(2, "0")}`));
  const m = withState(modelOf([]), { sections: [newSection({ subject: SubjectScripts })], scripts });
  m.width = 140;
  m.height = 30;
  const view = listHeight(m);
  press(m, HomeKey.Up);
  expect(current(m).index).toBe(0); // the top is the end of the road
  press(m, HomeKey.PageDown);
  expect(current(m).index).toBe(view);
  expect(m.state.offsets.get(SubjectScripts)).toBe(1); // just enough to show the cursor
  for (let i = 0; i < 10; i++) press(m, HomeKey.PageDown);
  expect(current(m).index).toBe(29);
  // Every list keeps its own place.
  press(m, HomeKey.Subject1);
  press(m, HomeKey.Subject1);
  m.state.subject = 0;
  expect(m.state.cursors.get(SubjectScripts)).toBe(29);
});

test("ctrl+d and ctrl+u move half a page", () => {
  const scripts = Array.from({ length: 60 }, (_, i) => scriptRow(`s${String(i).padStart(2, "0")}`));
  const m = withState(modelOf([]), { sections: [newSection({ subject: SubjectScripts })], scripts });
  m.width = 140;
  m.height = 30;
  focus(m, FocusArea.Main);
  const half = Math.trunc(listHeight(m) / 2);
  expect(half).toBeGreaterThan(1);
  press(m, HomeKey.HalfDown);
  expect(current(m).index).toBe(half); // ctrl+d goes down half a page
  press(m, HomeKey.HalfDown);
  expect(current(m).index).toBe(2 * half);
  press(m, HomeKey.HalfUp);
  expect(current(m).index).toBe(half); // ctrl+u goes back up half a page
  press(m, HomeKey.HalfUp, HomeKey.HalfUp);
  expect(current(m).index).toBe(0); // the top is the end of the road

  // The inspector scrolls the same way.
  m.state.inspect = { name: "s00", items: [], err: "", machine: [], fleet: [], scroll: 0 };
  press(m, HomeKey.HalfDown);
  expect(m.state.inspect.scroll).toBe(half);
  press(m, HomeKey.HalfUp, HomeKey.HalfUp);
  expect(m.state.inspect!.scroll).toBe(0);
});

test("the half-page keys are bound", () => {
  const cases: [KeyPressMsg, HomeKey][] = [
    [new KeyPressMsg(0x64, "", ModCtrl), HomeKey.HalfDown],
    [new KeyPressMsg(0x75, "", ModCtrl), HomeKey.HalfUp],
  ];
  for (const [msg, want] of cases) expect(homeKeyOf(msg)).toBe(want);
});

test("the remote tree folds and ticks by what will act", () => {
  const ans = newAnswered({
    updates: [update("kitty", "1", "2"), update("ruby", "3.4.8", "3.4.10", "asdf-tools")],
    tools: [
      newToolUpdates({ tool: "dnf", installers: ["dnf"], total: 14, declared: ["kitty"], others: ["kernel", "glibc"], command: "sudo dnf upgrade -y" }),
      newToolUpdates({ tool: "flatpak", installers: ["flatpak"], total: 0, command: "flatpak --user update -y" }),
    ],
    mechanismOf: new Map([["kitty", "dnf"]]),
    toolOf: new Map([
      ["dnf", "dnf"],
      ["flatpak", "flatpak"],
    ]),
    mechanismsOfTool: new Map([
      ["dnf", ["dnf"]],
      ["flatpak", ["flatpak"]],
    ]),
    sources: new Map([["asdf-tools", true]]),
  });
  const lines = remoteLines(ans, undefined);
  expect(remoteKinds(lines)).toEqual(["Tool", "Program", "Others", "Gap", "Tool", "Gap", "Source", "Item"]);
  expect(lines[0]!.key).toBe("tool:dnf");
  expect(lines[1]!.key).toBe("tool:dnf"); // a program under its tool ticks the tool
  expect(lines[7]!.key).toBe("item:asdf-tools/ruby");
  expect(lines[0]!.foldable && !lines[4]!.foldable).toBe(true); // a clean tool hides nothing

  const m = withState(modelOf([]), { sections: [newSection({ subject: SubjectRemote })], remote: ans });
  press(m, HomeKey.Down, HomeKey.Down);
  expect(remoteRowOf(m).kind).toBe(RemoteKind.Others); // the cost line is a stop
  press(m, HomeKey.Enter);
  expect(m.state.dialog!.kind).toBe(DialogKind.List); // enter on it lists the packages
  expect(m.state.dialog!.lines).toEqual(["kernel", "glibc"]);
  press(m, HomeKey.Enter);
  expect(m.state.dialog).toBeUndefined();
  press(m, HomeKey.Down);
  expect(current(m).name).toBe("flatpak"); // the gap is skipped
  press(m, HomeKey.Down);
  expect(remoteRowOf(m).kind).toBe(RemoteKind.Source);
  press(m, HomeKey.Select);
  expect(m.state.selection).toEqual(setOf("item:asdf-tools/ruby")); // the heading ticks every item under it
  press(m, HomeKey.Select);
  expect(m.state.selection.size).toBe(0); // and clears them when they all are

  // h folds the group under the cursor and lands on its heading.
  press(m, HomeKey.Up, HomeKey.Up);
  expect(remoteRowOf(m).kind).toBe(RemoteKind.Others);
  press(m, HomeKey.Close);
  expect(m.state.collapsed).toEqual(setOf("tool:dnf"));
  expect(remoteRowOf(m).kind).toBe(RemoteKind.Tool);
  expect(current(m).name).toBe("dnf");
  expect(focusOf(m)).toBe(FocusArea.Main);
  press(m, HomeKey.Open);
  expect(m.state.collapsed.size).toBe(0); // l unfolds
  // On a clean tool there is nothing to fold: h goes back to the sidebar.
  press(m, HomeKey.NextHeading);
  expect(current(m).name).toBe("flatpak"); // ] jumps over the rows to the next group
  press(m, HomeKey.Close);
  expect(m.state.collapsed.size).toBe(0);
  expect(focusOf(m)).toBe(FocusArea.Sidebar);
  m.state.focus = FocusArea.Main;
  press(m, HomeKey.PrevHeading);
  expect(current(m).name).toBe("dnf");
  press(m, HomeKey.Select);
  expect(m.state.selection).toEqual(setOf("tool:dnf")); // one key, one mechanism
  press(m, HomeKey.Enter);
  expect(m.state.dialog === undefined || m.state.dialog.kind === DialogKind.Confirm).toBe(true);
});

test("K opens the row's page only when its source gave one", () => {
  const rows: app.UpdateRow[] = [
    { name: "golang", current: "a", candidate: "b", source: "asdf-plugins", note: "", link: "https://github.com/x/y/compare/a...b" },
    { name: "nodejs", current: "a", candidate: "b", source: "asdf-plugins", note: "" },
  ];
  const ans = newAnswered({ updates: rows, sources: new Map([["asdf-plugins", true]]) });
  expect(link(remoteLines(ans, undefined)[1]!)).toBe("https://github.com/x/y/compare/a...b");
  const m = withState(modelOf([]), { sections: [newSection({ subject: SubjectRemote })], remote: ans });
  press(m, HomeKey.Down, HomeKey.Down, HomeKey.OpenLink);
  expect(message(m)).toContain("no page");
});

test("a row with no mechanism says so instead of ticking", () => {
  const m = withState(modelOf([]), { sections: [newSection({ subject: SubjectRemote })], remote: newAnswered({ updates: [update("oracle", "a", "b")] }) });
  press(m, HomeKey.Down, HomeKey.Select);
  expect(m.state.selection.size).toBe(0);
  expect(message(m)).toContain("can't update");
});

test("the same name in two sources is two rows", () => {
  const m = withState(modelOf([]), {
    sections: [newSection({ subject: SubjectRemote })],
    remote: newAnswered({
      updates: [update("python", "3.14.1", "3.14.2", "asdf-tools"), update("python", "d4caa7d", "abc2a03", "asdf-plugins")],
      sources: new Map([
        ["asdf-tools", true],
        ["asdf-plugins", true],
      ]),
    }),
  });
  press(m, HomeKey.Down, HomeKey.Select);
  expect(m.state.selection).toEqual(setOf("item:asdf-tools/python"));
  press(m, HomeKey.Down, HomeKey.Select);
  expect(m.state.selection).toEqual(setOf("item:asdf-tools/python", "item:asdf-plugins/python"));
});

// -------------------------------------------------------------- inspector

test("the inspector explains the row with this machine and the fleet", () => {
  const fleet: diff.DiffReport = {
    machines: ["m1", "m2"],
    rows: [
      {
        program: "git",
        perMachine: new Map([
          ["m1", { kind: "installed", version: "2.55.0" }],
          ["m2", { kind: "missing" }],
        ]),
      },
    ],
    configs: [],
  };
  const rows = programRowsOf(manifestFor(), system, machineState());
  const m = withState(modelOf([]), { sections: [newSection({ subject: SubjectPrograms })], programs: rows, fleet });
  let asked: string[] = [];
  m.explain = (names) => {
    asked = names;
    return [
      {
        name: names[0]!,
        items: [{ kind: "program", name: names[0]!, description: "", folder: "", notes: [], rows: [{ label: "install.dnf", value: "sudo dnf install -y git", machine: "m1" }] }],
      },
    ];
  };
  press(m, HomeKey.Down, HomeKey.Inspect);
  expect(asked).toEqual(["git"]); // explain answers for the row under the cursor
  const inspector = m.state.inspect!;
  expect(inspector.name).toBe("git");
  expect(inspector.items[0]!.kind).toBe("program");
  expect(inspector.machine).toEqual([{ label: "program", value: "installed 2.55.0", machine: "" }]);
  expect(inspector.fleet).toEqual([
    { label: "m1", value: "2.55.0", machine: "" },
    { label: "m2", value: "missing", machine: "" },
    { label: "verdict", value: "missing somewhere", machine: "" },
  ]);
  const joined = strip(inspectorLines(m, style.dark(), inspector, 80).join("\n"));
  expect(joined).toContain("← m1");
  expect(joined).toContain("This machine");
  expect(joined).toContain("Fleet");
  press(m, HomeKey.Down);
  expect(m.state.inspect!.scroll).toBe(1); // the arrows scroll it
  press(m, HomeKey.Esc);
  expect(m.state.inspect).toBeUndefined(); // esc goes back to the list

  // A remote tool line is no program: i says what it inspects.
  m.explain = () => {
    throw new app.NoSuchItemError("no program or script named 'x'", []);
  };
  withState(m, {
    sections: [newSection({ subject: SubjectRemote })],
    remote: newAnswered({
      updates: [update("kitty", "1", "2")],
      tools: [newToolUpdates({ tool: "dnf", installers: ["dnf"], total: 1, declared: ["kitty"], command: "x" })],
      mechanismOf: new Map([["kitty", "dnf"]]),
      toolOf: new Map([["dnf", "dnf"]]),
      mechanismsOfTool: new Map([["dnf", ["dnf"]]]),
    }),
  });
  press(m, HomeKey.Inspect);
  expect(m.state.inspect).toBeUndefined();
  expect(message(m)).toContain("i inspects");
  press(m, HomeKey.Down, HomeKey.Inspect);
  expect(m.state.inspect!.err).toBe("no program or script named 'x'"); // a program row is explained, or why not
});

test("an inspector whose explain takes a moment opens when it answers", async () => {
  const rows = programRowsOf(manifestFor(), system, machineState());
  const m = withState(modelOf([]), { sections: [newSection({ subject: SubjectPrograms })], programs: rows });
  m.explain = async (names) => [{ name: names[0]!, items: [] }];
  press(m, HomeKey.Inspect);
  expect(m.state.inspect).toBeUndefined(); // not yet
  const cmds = m.cmds;
  m.cmds = [];
  for (const cmd of cmds) apply(m, await cmd());
  expect(m.state.inspect?.name).toBe("kitty");
});

// -------------------------------------------------------------------- runs

/**
 * FakeTerm is the run panel's terminal without a pseudo-terminal: the test
 * delivers its exit.
 */
class FakeTerm implements Terminal {
  cmd: TermCommand | undefined;
  focused = false;
  closed = false;
  keys: Msg[] = [];
  interrupts = 0;
  plain = "";
  fgColor: style.Color | undefined;
  bgColor: style.Color | undefined;
  at = "";
  /** shownText is the output its first row shows. */
  shownText = "";

  constructor(
    readonly id: number,
    public w: number,
    public h: number,
  ) {}

  ID(): number {
    return this.id;
  }
  start(cmd: TermCommand): Cmd | null {
    this.cmd = cmd;
    return null;
  }
  update(msg: Msg): Cmd | null {
    this.keys.push(msg);
    return null;
  }
  view(): string {
    const rows = Array.from({ length: this.h }, () => " ".repeat(this.w));
    if (this.shownText !== "") rows[0] = style.fit(this.shownText, this.w);
    return rows.join("\n");
  }
  cursor(): Cursor | null {
    return { x: 2, y: 1, shape: "block", blink: true };
  }
  size(): [number, number] {
    return [this.w, this.h];
  }
  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
  }
  focus(): void {
    this.focused = true;
  }
  blur(): void {
    this.focused = false;
  }
  running(): boolean {
    return !this.closed;
  }
  interrupt(): void {
    this.interrupts++;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  scrollUp(): void {}
  scrollDown(): void {}
  pageUp(): void {}
  pageDown(): void {}
  top(): void {
    this.at = "top";
  }
  bottom(): void {
    this.at = "bottom";
  }
  scrolled(): number {
    return 0;
  }
  setColors(fg: style.Color, bg: style.Color): void {
    this.fgColor = fg;
    this.bgColor = bg;
  }
  plainText(): string {
    return this.plain;
  }
}

/** runSomething confirms a script run on m and returns its terminal. */
function runSomething(m: HomeModel): FakeTerm {
  let f: FakeTerm | undefined;
  m.runCommand = () => ({ argv: ["loadout"] });
  m.newTerm = (w, h) => {
    f = new FakeTerm(m.runs.length + 1, w, h);
    return f;
  };
  confirm(m, { action: app.ActionHandOff, handoff: { kind: app.PaneScripts, args: ["pull"] } });
  if (f === undefined) throw new Error("a terminal was made");
  return f;
}

function exited(f: FakeTerm, code: number, interrupted = false): ExitMsg {
  return new ExitMsg(f.id, code, interrupted, null);
}

test("a run starts in the panel and ends with a toast", () => {
  const m = modelOf(subjectsAll);
  m.state.dark = true;
  const f = runSomething(m);
  expect(m.active !== undefined && m.shown === m.active).toBe(true);
  expect(m.active!.command).toBe("loadout run pull --force");
  expect(m.active!.label).toBe("run pull");
  expect(f.cmd).toBeDefined(); // the command started in the terminal
  expect(f.bgColor).toEqual(style.dark().bgBase); // the terminal answers colour queries with the theme
  expect(m.jobs.isHeld()).toBe(true); // no background check runs beside the command
  expect([f.w, f.h]).toEqual(termSize(layout(m, true))); // the emulator is the panel's size
  expect(terminalTakesKeys(m)).toBe(true);

  // One run at a time; q refused while it runs.
  confirm(m, { action: app.ActionSync });
  expect(message(m)).toContain("a command is running");
  press(m, HomeKey.Leave, HomeKey.Quit);
  expect(m.state.exit).toBe(false);
  expect(message(m)).toContain("ctrl+c stops it");
  press(m, HomeKey.Interrupt);
  expect(f.interrupts).toBe(1); // ctrl+c on the dashboard stops the command

  runExited(m, exited(f, 0));
  expect(m.active).toBeUndefined();
  expect(m.shown).toBe(m.runs[0]!); // the run stays in the panel
  expect(focusOf(m)).toBe(FocusArea.Main); // focus leaves the finished terminal
  expect(toastKind(m)).toBe(style.ToastKind.OK);
  expect(message(m)).toBe("run pull done");
  expect(m.jobs.isHeld()).toBe(false); // the checks are back
  expect(f.closed).toBe(false); // the newest run keeps its emulator
  press(m, HomeKey.Tab);
  expect(focusOf(m)).toBe(FocusArea.Terminal);
  press(m, HomeKey.Esc);
  expect(m.shown).toBeUndefined(); // esc dismisses a finished run
  expect(f.closed).toBe(true); // and closes its emulator; its text stays for the Runs list
  expect(m.runs.length).toBe(1);
});

test("esc closes a finished run from any area", () => {
  // The finished run keeps the focus; from the list, esc closes it too.
  let m = modelOf(subjectsAll);
  let f = runSomething(m);
  press(m, HomeKey.Leave, HomeKey.Esc);
  expect(m.shown).toBeDefined(); // esc never closes a running command's panel
  focus(m, FocusArea.Terminal); // watching the output when it ends
  runExited(m, exited(f, 0));
  expect(focusOf(m)).toBe(FocusArea.Terminal); // the finished run keeps the focus
  expect(f.focused).toBe(false); // but its emulator is blurred: keys are the screen's now
  focus(m, FocusArea.Main);
  expect(shortHelp(m).some((b) => b.help.desc === "close run")).toBe(true); // the help line says esc closes it
  press(m, HomeKey.Esc);
  expect(m.shown).toBeUndefined(); // esc on the list closes the finished run
  expect(f.closed).toBe(true);
  expect(focusOf(m)).toBe(FocusArea.Main); // and the focus stays on the list

  // A filter clears first; the next esc closes the run.
  m = modelOf(subjectsAll);
  f = runSomething(m);
  runExited(m, exited(f, 0));
  focus(m, FocusArea.Main); // a filter is the list's
  m.state.filters = withValue(m.state.filters, subjectOf(m.state), "x");
  press(m, HomeKey.Esc);
  expect(m.shown).toBeDefined(); // the filter clears first
  expect(m.state.filters.get(subjectOf(m.state))).toBe("");
  press(m, HomeKey.Esc);
  expect(m.shown).toBeUndefined();

  // The sidebar.
  m = modelOf(subjectsAll);
  f = runSomething(m);
  runExited(m, exited(f, 1));
  focus(m, FocusArea.Sidebar);
  press(m, HomeKey.Esc);
  expect(m.shown).toBeUndefined(); // esc on the sidebar closes the finished run
  press(m, HomeKey.Esc);
  expect(message(m)).toContain("nothing to close");
});

test("a run opened from the sidebar gives the focus back to its entry", () => {
  let m = modelOf(subjectsAll);
  let f = runSomething(m);
  runExited(m, exited(f, 0));
  press(m, HomeKey.Esc); // close it from the list
  expect(m.shown).toBeUndefined();

  // The sidebar's cursor goes past the subjects onto the run, enter opens it.
  focus(m, FocusArea.Sidebar);
  for (const _ of m.state.sections) press(m, HomeKey.Down);
  expect(m.state.sideRun).toBe(0); // the cursor is on the run
  press(m, HomeKey.Enter);
  expect(m.shown).toBe(m.runs[0]!);
  expect(focusOf(m)).toBe(FocusArea.Terminal);

  // h leaves the panel open and goes back to the entry.
  press(m, HomeKey.Close);
  expect(focusOf(m)).toBe(FocusArea.Sidebar); // h goes back to the sidebar
  expect(m.state.sideRun).toBe(0); // on the run's entry
  expect(m.shown).toBeDefined();

  // esc closes it and goes back to the entry.
  press(m, HomeKey.Enter, HomeKey.Esc);
  expect(m.shown).toBeUndefined();
  expect(focusOf(m)).toBe(FocusArea.Sidebar); // esc goes back to the sidebar, not the list
  expect(m.state.sideRun).toBe(0); // on the run's entry

  // A run started from the list still gives the focus back to the list.
  m = modelOf(subjectsAll);
  f = runSomething(m);
  runExited(m, exited(f, 0));
  focus(m, FocusArea.Terminal);
  press(m, HomeKey.Esc);
  expect(focusOf(m)).toBe(FocusArea.Main);
});

test("each sidebar row settles when its own checks land", () => {
  const manifest = manifestFor();
  const m = modelOf([]);
  m.manifest = manifest;
  m.system = system;
  // The refresh under way, as refresh() leaves it: every subject checking.
  m.state.checking = new Set([SubjectPrograms, SubjectScripts]);
  m.partial = newMachineState({ machine: "m1" });
  m.state.sections = sectionsOf(manifest, system, undefined, undefined, undefined, { checking: m.state.checking });
  const busy = (subject: string) => sectionNamed(m.state.sections, subject).busy;
  expect(busy(SubjectPrograms) && busy(SubjectScripts)).toBe(true); // both spin while their checks run

  const part = (p: Partial<engine.Part> & { kind: engine.PartKind }): engine.Part => ({
    programs: new Map(),
    toolsDown: [],
    scripts: new Map(),
    detail: new Map(),
    configs: new Map(),
    ...p,
  });
  apply(m, new PartMsg(part({ kind: "scripts", scripts: new Map([["dotfiles", { status: "done" }]]) })));
  expect(busy(SubjectScripts)).toBe(false); // scripts stop the moment their own checks are in
  expect(busy(SubjectPrograms)).toBe(true); // programs keep spinning: theirs aren't
  expect(m.state.checking).toEqual(setOf(SubjectPrograms));

  apply(
    m,
    new PartMsg(
      part({
        kind: "programs",
        programs: new Map([
          ["git", { status: "installed" }],
          ["kitty", { status: "missing" }],
        ]),
      }),
    ),
  );
  expect(busy(SubjectPrograms)).toBe(false); // and programs stop when theirs are
  expect(sectionNamed(m.state.sections, SubjectPrograms).summary).toBe("1 installed · 1 missing"); // with their fresh answer

  // A part that failed leaves its row to the refresh's own message.
  m.state.checking = setOf(SubjectScripts);
  apply(m, new PartMsg(part({ kind: "scripts", err: new Error("boom") })));
  expect(m.state.checking).toEqual(setOf(SubjectScripts));
});

/** plainFrame is m's frame without styles. */
function plainFrame(m: HomeModel): string[] {
  return screenLines(m, 0).map(strip);
}

/** cell is the code point at col of line, "" past its end. */
function cell(line: string, col: number): string {
  return [...line][col] ?? "";
}

test("rules set the areas apart", () => {
  const m = modelOf(subjectsAll);
  m.width = 140;
  m.height = 40;
  const edge = 1 + sidebarWidth + 1; // the gutter's middle column
  let lines = plainFrame(m);
  lines.slice(0, -1).forEach((line) => expect(cell(line, edge)).toBe("│")); // every row has the sidebar's edge
  expect(lines.join("\n")).not.toContain("├"); // no panel, no rule across

  const f = runSomething(m);
  runExited(m, exited(f, 0));
  const l = layout(m, true);
  lines = plainFrame(m);
  expect(cell(lines[l.panelY - 1]!, edge)).toBe("├"); // the rule above the run panel meets the edge
  expect([...lines[l.panelY - 1]!].filter((c) => c === "─").length).toBeGreaterThanOrEqual(l.mainW); // and runs across the main pane

  m.state.maximized = true;
  lines = plainFrame(m);
  expect(lines.join("\n")).not.toContain("├"); // a zoomed panel needs no rule
});

test("zoom gives the run the whole height of the main pane", () => {
  const m = modelOf(subjectsAll);
  m.width = 140;
  m.height = 40;
  const f = runSomething(m);
  runExited(m, exited(f, 0));
  focus(m, FocusArea.Terminal);
  const half = f.h;
  press(m, HomeKey.Zoom);
  const l = layout(m, true);
  expect(l.panelY).toBe(l.titleY); // zoomed, the panel starts at the top
  expect(f.h).toBe(l.statusY - l.titleY - 1); // and its terminal fills every row down to the help line
  expect(f.h).toBeGreaterThan(half);
  press(m, HomeKey.Zoom);
  expect(f.h).toBe(half); // z again gives the list its half back
});

test("only the focused area's title is highlighted", () => {
  const m = modelOf(subjectsAll);
  m.width = 140;
  m.height = 40;
  const f = runSomething(m);
  runExited(m, exited(f, 0));
  const l = layout(m, true);
  const fill = "48;2;107;80;255";
  const titles = (): [boolean, boolean] => {
    const lines = screenLines(m, 0);
    return [lines[l.titleY]!.includes(fill), lines[l.panelY]!.includes(fill)];
  };
  focus(m, FocusArea.Terminal);
  let [mainLit, runLit] = titles();
  expect(runLit && !mainLit).toBe(true); // tab onto the terminal lights the run's title, like a selected row
  focus(m, FocusArea.Main);
  [mainLit, runLit] = titles();
  expect(mainLit && !runLit).toBe(true); // on the list, its title
  focus(m, FocusArea.Sidebar);
  [mainLit, runLit] = titles();
  expect(!mainLit && !runLit).toBe(true); // on the sidebar, its own selected entry and no title
});

test("home, gg, end and G jump through a finished run's output", () => {
  const m = modelOf(subjectsAll);
  const f = runSomething(m);
  runExited(m, exited(f, 0));
  focus(m, FocusArea.Terminal);
  press(m, HomeKey.Top);
  expect(f.at).toBe("top"); // home goes to the start
  press(m, HomeKey.Bottom);
  expect(f.at).toBe("bottom"); // end (and G) to the end
  press(m, HomeKey.G);
  expect(f.at).toBe("bottom"); // one g alone does nothing yet
  press(m, HomeKey.G);
  expect(f.at).toBe("top"); // gg goes to the start
  press(m, HomeKey.Bottom, HomeKey.G, HomeKey.Down, HomeKey.G);
  expect(f.at).toBe("bottom"); // a key between the two g's disarms the first
  press(m, HomeKey.G);
  expect(f.at).toBe("top"); // and the next pair works

  const cases: [KeyPressMsg, HomeKey][] = [
    [new KeyPressMsg(KeyHome), HomeKey.Top],
    [new KeyPressMsg(KeyEnd), HomeKey.Bottom],
    [new KeyPressMsg(0x67, "G", ModShift), HomeKey.Bottom],
    [new KeyPressMsg(0x67, "g"), HomeKey.G],
  ];
  for (const [msg, want] of cases) expect(homeKeyOf(msg)).toBe(want);
});

test("a run reopened from Runs fills the zoomed panel too", () => {
  const m = modelOf(subjectsAll);
  m.width = 140;
  m.height = 40;
  const f = runSomething(m);
  runExited(m, exited(f, 0));
  press(m, HomeKey.Esc); // closes the panel: the run's emulator is released, its text kept
  expect(m.shown === undefined && f.closed).toBe(true);

  focus(m, FocusArea.Sidebar);
  for (const _ of m.state.sections) press(m, HomeKey.Down);
  press(m, HomeKey.Enter); // the run again, from the sidebar's Runs
  expect(m.shown).toBe(m.runs[0]!);
  press(m, HomeKey.Zoom);
  const l = layout(m, true);
  expect(f.h).toBe(l.statusY - l.titleY - 1); // the reopened run fills the zoomed panel
  press(m, HomeKey.Zoom);
  expect(f.h).toBe(termSize(layout(m, true))[1]); // and goes back to the half panel
});

test("a failed or interrupted run says so", () => {
  const m = modelOf(subjectsAll);
  let f = runSomething(m);
  runExited(m, exited(f, 130, true));
  expect(toastKind(m)).toBe(style.ToastKind.Warning);
  expect(message(m)).toBe("run pull interrupted");
  expect(m.runs[0]!.status()).toBe("interrupted");

  f = runSomething(m);
  expect(m.runs[0]!.released).toBe(true); // an older run gives its emulator back
  runExited(m, exited(f, 3));
  expect(toastKind(m)).toBe(style.ToastKind.Error);
  expect(message(m)).toBe("run pull: exit 3");
  expect(runsNewestFirst(m).map((r) => r.status())).toEqual(["failed", "interrupted"]);
});

test("an upgrade that succeeded clears its ticks", () => {
  const m = modelOf(subjectsAll);
  m.state.selection = setOf("tool:dnf");
  const upgrade: app.Closed = { action: app.ActionHandOff, handoff: { kind: app.PaneUpgrade, args: ["dnf"] } };
  followUp(m, upgrade, false);
  expect(m.state.selection).toEqual(setOf("tool:dnf")); // a failed upgrade keeps its ticks for another go
  followUp(m, upgrade, true);
  expect(m.state.selection.size).toBe(0);
});

test("a run waits for the checks still running", async () => {
  const m = modelOf(subjectsAll);
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  m.jobs.start(async () => {
    await released;
    return new SayMsg(style.ToastKind.Hey, "checked");
  });
  let f: FakeTerm | undefined;
  m.runCommand = () => ({ argv: ["loadout"] });
  m.newTerm = (w, h) => {
    f = new FakeTerm(9, w, h);
    return f;
  };
  confirm(m, { action: app.ActionSync });
  expect(f).toBeUndefined(); // nothing starts while a check runs
  expect(m.waiting).toBeDefined();
  release();
  await settle(m);
  for (const msg of m.jobs.take()) apply(m, msg);
  afterJobs(m);
  expect(f !== undefined && m.active !== undefined).toBe(true); // the run starts once the checks are done
});

test("self-upgrade ends the screen with its output", () => {
  const m = modelOf(subjectsAll);
  let f: FakeTerm | undefined;
  m.runCommand = () => ({ argv: ["loadout"] });
  m.newTerm = (w, h) => {
    f = new FakeTerm(4, w, h);
    f.plain = "installed 9.9.9";
    return f;
  };
  confirm(m, { action: app.ActionUpgrade });
  runExited(m, exited(f!, 0));
  expect(m.state.exit).toBe(true); // the binary on disk changed: the screen ends
  expect(m.ended!.message.startsWith("installed 9.9.9")).toBe(true);
  expect(m.ended!.message).toContain("run loadout again");
  expect(m.ended!.code).toBe(0);
});

test("keys go to the running command, except ctrl+]", () => {
  const m = modelOf(subjectsAll);
  const f = runSomething(m);
  key(m, new KeyPressMsg(0x71, "q"));
  expect(m.state.exit).toBe(false); // q is the command's
  key(m, new KeyPressMsg(0x63, "", ModCtrl));
  expect(f.keys.length).toBe(2); // ctrl+c too: the terminal sends it to the command
  key(m, new KeyPressMsg(0x5d, "", ModCtrl));
  expect(focusOf(m)).toBe(FocusArea.Main); // ctrl+] is the screen's
  expect(f.keys.length).toBe(2);
  expect(terminalCursor(m)).toBeNull(); // no cursor once the dashboard has the keys
  press(m, HomeKey.Tab);
  const c = terminalCursor(m)!;
  const l = layout(m, true);
  expect([c.x, c.y]).toEqual([2 + l.mainX, 1 + l.panelY + 1]); // the command's cursor, where the panel is
});

// ------------------------------------------------------------------ frame

test("the frame is exactly the screen in both layouts", () => {
  const sections = sectionsOf(manifestFor(), system, machineState(script("dotfiles", "pending")), undefined, undefined, {});
  const sizes: [number, number][] = [
    [140, 40],
    [100, 30],
    [100, 12],
    [99, 30],
    [80, 24],
    [60, 20],
    [200, 50],
  ];
  for (const [w, h] of sizes) {
    const m = withState(modelOf([]), {
      sections,
      machine: "m1",
      system: "linux/fedora · x86_64",
      programs: programRowsOf(manifestFor(), system, machineState()),
    });
    m.width = w;
    m.height = h;
    handleTextless(m);
    for (const open of [false, true]) {
      if (open) {
        runSomething(m);
        const panel = strip(screenLines(m, 0).join("\n"));
        // (A short screen's toast may cover the panel's title.)
        expect(h < 20 || panel.includes("loadout run pull --force")).toBe(true); // the run panel names the command
        m.state.dialog = newDialog({ kind: DialogKind.Confirm, pane: app.PaneScripts, row: -1, items: [{ name: "pull", text: "Pull the dotfiles repo" }] });
      }
      const lines = screenLines(m, 0);
      expect(lines.length).toBe(h); // one line per row
      for (const line of lines) expect(stringWidth(line)).toBe(w); // every row exactly the width
      const joined = strip(lines.join("\n"));
      if (open) {
        expect(joined).toContain("These scripts will run, in order:");
        expect(joined.includes("Run") && joined.includes("Cancel")).toBe(true);
      }
      if (!open) {
        const wide = w >= wideMinWidth;
        const edge = [...strip(lines[1]!)][1 + sidebarWidth + 1];
        expect(edge === "│").toBe(wide); // the sidebar's edge only side by side
        expect(strip(lines[0]!).startsWith(" loadout › ")).toBe(!wide); // the breadcrumb only stacked
      }
    }
  }
});

/** handleTextless puts a long toast up ("long " 60 times). */
function handleTextless(m: HomeModel): void {
  m.cmds.push(m.toasts.show(style.ToastKind.Hey, "long ".repeat(60)));
}

test("an obsolete sudo on a script still loads", () => {
  const manifest = manifestOf((b) => {
    b.script("hid", { run: "true", sudo: true });
    b.script("plain", { run: "true" });
    b.machine("m1", { scripts: ["hid", "plain"] });
  });
  expect(names(scriptRowsOf(manifest, system, undefined))).toEqual(["hid", "plain"]);
});

test("the upgrade question says what moves, not which command runs", () => {
  // Rows say how much moves and how much is yours, not the command.
  const ans = newAnswered({
    updates: [
      update("brave", "1.82.1", "1.82.3", "omarchy-aur"),
      update("kitty", "0.48.2", "0.48.3", "omarchy-pkg"),
      update("chezmoi", "2.72.1", "2.72.2", "brew"),
      update("ruby", "3.4.8", "3.4.10", "asdf-tools"),
    ],
    tools: [
      newToolUpdates({ tool: "omarchy", installers: ["omarchy-pkg", "omarchy-aur"], total: 168, declared: ["brave", "kitty"], command: "omarchy update -y" }),
      newToolUpdates({ tool: "brew", installers: ["brew", "brew-cask"], total: 8, declared: ["chezmoi"], command: "brew upgrade" }),
    ],
    mechanismOf: new Map([
      ["brave", "omarchy-aur"],
      ["kitty", "omarchy-pkg"],
      ["chezmoi", "brew"],
    ]),
    sources: new Map([["asdf-tools", true]]),
  });
  const step = (tool: string, ...installers: string[]): engine.UpgradeStep => ({
    installers,
    command: "a very long command",
    covers: [],
    sweep: true,
    tool,
    origin: "",
    program: false,
    sudo: false,
  });
  expect(upgradeItem(step("omarchy", "omarchy-aur", "omarchy-pkg"), ans)).toEqual({ name: "omarchy", text: "all 168 packages · 2 in your loadout" });
  // brew's formulae and casks upgrade by two commands: the tool's total
  // can't say how much each one moves.
  expect(upgradeItem(step("brew", "brew"), ans)).toEqual({ name: "brew", text: "every package it manages · 1 in your loadout" });
  const ruby: engine.UpgradeStep = { installers: ["asdf-tools"], command: "x", covers: ["ruby"], sweep: false, origin: "", program: false, sudo: false };
  expect(upgradeItem(ruby, ans)).toEqual({ name: "asdf-tools", text: "ruby 3.4.8 → 3.4.10" });
});

// A source's item may be named like a mapped program: the live repo has a
// `tpack` tmux plugin AND a `tpack` brew cask. The row belongs to its source
// either way — filed under brew, ticking it ran `brew upgrade`, which cannot
// fast-forward a git clone, so the row came back outdated after every
// refresh.
test("a source row named like a program is never the program", () => {
  const row: app.UpdateRow = { name: "tpack", current: "27172d5", candidate: "1f8b694", source: "tmux-plugins", note: "156 commit(s) behind" };
  const answeredWith = (upgradable: boolean) =>
    newAnswered({
      updates: [row],
      tools: [newToolUpdates({ tool: "brew", installers: ["brew-cask"], total: 0, command: "brew upgrade" })],
      mechanismOf: new Map([["tpack", "brew-cask"]]),
      toolOf: new Map([["brew-cask", "brew"]]),
      mechanismsOfTool: new Map([["brew", ["brew-cask"]]]),
      sources: new Map([["tmux-plugins", upgradable]]),
    });

  // Upgradable: its own item, under its own source.
  const own = answeredWith(true);
  expect(remoteKinds(remoteLines(own, undefined))).toEqual(["Tool", "Gap", "Source", "Item"]);
  expect(remoteLines(own, undefined)[3]!.group).toBe("source:tmux-plugins");
  expect(selectionKey(own, row)).toBe("item:tmux-plugins/tpack");

  // Read-only: still its source's row — NOT a brew program, even though a
  // read-only source isn't upgradable.
  const readOnly = answeredWith(false);
  expect(remoteKinds(remoteLines(readOnly, undefined))).toEqual(["Tool", "Gap", "Source", "Item"]);
  expect(remoteLines(readOnly, undefined)[3]!.group).toBe("source:tmux-plugins");
  expect(selectionKey(readOnly, row)).toBe(""); // nothing loadout can move — never brew's sweep
  expect(refusal(remoteLines(readOnly, undefined)[3]!)).toBe("tmux-plugins can't update its items from loadout");
});

test("the scripts picker lists maintenance scripts with their last verdicts", () => {
  const manifest = manifestFor();
  const rows = scriptRowsOf(manifest, system, machineState(script("dotfiles", "pending")));
  // bootstrap is setup-only: converge's, never the picker's.
  expect(rows.length).toBe(1);
  expect(rows[0]!.name).toBe("dotfiles");
  expect(rows[0]!.status).toBe("pending");
  expect(rows[0]!.command).toBe("true");
  // Never observed = unproven, not done — and so ticked.
  const unseen = scriptRowsOf(manifest, system, machineState());
  expect(unseen[0]!.status).toBe("");
  expect(preselect(unseen)).toEqual(setOf("dotfiles"));
  expect(preselect(scriptRowsOf(manifest, system, machineState(script("dotfiles", "done"))))).toEqual(new Set());
});

test("a program with its own upgrade ticks alone and hands off by name", () => {
  const row = update("claude", "1.0.0", "1.2.0", "script");
  const ans = newAnswered({ updates: [row], programUpgrades: new Set(["claude"]) });
  expect(selectionKey(ans, row)).toBe("prog:claude");
  const step: engine.UpgradeStep = {
    installers: ["claude"],
    command: "sh 'outdated.sh' update",
    covers: ["claude"],
    sweep: false,
    origin: "",
    program: true,
    sudo: false,
  };
  expect(upgradeItem(step, ans)).toEqual({ name: "claude", text: "claude 1.0.0 → 1.2.0" });
});

// ---------------------------------------------------------------- stacked

/** stackedAt is a model at w × h on the home page, with programs to list. */
function stackedAt(w: number, h: number): HomeModel {
  const sections = sectionsOf(manifestFor(), system, machineState(script("dotfiles", "pending")), undefined, undefined, {});
  const m = withState(modelOf([]), {
    sections,
    machine: "m1",
    system: "linux/fedora · x86_64",
    programs: programRowsOf(manifestFor(), system, machineState()),
    missing: missingRowsOf(manifestFor(), system, machineState()),
  });
  m.width = w;
  m.height = h;
  focus(m, FocusArea.Sidebar);
  return m;
}

/** frameOf is m's frame as plain text, checked to be exactly the screen. */
function frameOf(m: HomeModel): string[] {
  const lines = screenLines(m, 0);
  expect(lines.length).toBe(m.height); // one line per row
  return lines.map((line) => {
    expect(stringWidth(line)).toBe(m.width); // every row exactly the width
    return strip(line);
  });
}

test("stacked, one page fills the screen", () => {
  const sizes: [number, number][] = [
    [99, 30],
    [80, 24],
    [60, 20],
    [100, 30],
  ];
  for (const [w, h] of sizes) {
    const m = stackedAt(w, h);
    const wide = w >= wideMinWidth;
    expect(stacked(m)).toBe(!wide);

    const home = frameOf(m).join("\n");
    expect(home.includes("Machine ─") && home.includes("programs")).toBe(true); // the home page
    expect(home.includes("kitty")).toBe(wide); // no list on the home page, unless side by side

    press(m, HomeKey.Enter);
    const subject = frameOf(m);
    let joined = subject.join("\n");
    expect(joined.includes("kitty") && joined.includes("> filter")).toBe(true); // the subject page
    expect(joined.includes("Machine ─")).toBe(wide); // no sidebar on the subject page, unless side by side
    if (!wide) {
      expect(subject[1]!.trim()).toBe("─".repeat(w - 2)); // a rule under the breadcrumb
      expect(joined).not.toContain("│ "); // and no vertical one
    }

    const f = runSomething(m);
    f.shownText = "hello from pull";
    const run = frameOf(m).join("\n");
    expect(run).toContain("hello from pull"); // the run page
    expect(run.includes("kitty")).toBe(wide); // no list on the run page, unless side by side
    if (!wide) expect(f.size()).toEqual([w - 2, h - 4]); // the run fills the page under its title
    handleTextless(m);
    m.state.dialog = newDialog({ kind: DialogKind.Confirm, pane: app.PaneScripts, row: -1, items: [{ name: "pull", text: "Pull the dotfiles repo ".repeat(8) }] });
    joined = frameOf(m).join("\n");
    expect(joined.includes("Run") && joined.includes("Cancel")).toBe(true); // the dialog fits
    for (const kind of [DialogKind.Help, DialogKind.Palette, DialogKind.List]) {
      m.state.dialog = newDialog({ kind, title: "Not in your loadout", lines: ["x".repeat(120)] });
      frameOf(m);
    }
  }
});

test("the breadcrumb says which page", () => {
  const m = stackedAt(80, 24);
  const crumb = () => frameOf(m)[0]!.trim().split(/\s+/).join(" ");
  expect(crumb().startsWith("loadout › m1 ")).toBe(true);
  const [settled, open] = verdictCounts(m);
  expect(crumb().endsWith(`✓${settled} ●${open}`)).toBe(true); // the verdict counts at the right
  press(m, HomeKey.Enter);
  expect(crumb().startsWith("loadout › programs ✓")).toBe(true);
  press(m, HomeKey.Inspect);
  expect(crumb().startsWith("loadout › programs › inspect › kitty ")).toBe(true);
  press(m, HomeKey.Esc);
  const f = runSomething(m);
  expect(crumb().startsWith("loadout › programs › run ✓")).toBe(true); // a running command's own page names no ⟳
  press(m, HomeKey.Leave);
  expect(crumb().startsWith("loadout › programs ⟳ run pull ✓")).toBe(true); // behind the list, it says it's still going
  press(m, HomeKey.Esc);
  expect(focusOf(m)).toBe(FocusArea.Sidebar);
  expect(crumb().startsWith("loadout › m1 ⟳ run pull")).toBe(true);
  runExited(m, exited(f, 0));
  expect(crumb()).not.toContain("⟳"); // done
  press(m, HomeKey.Down, HomeKey.Down, HomeKey.Down, HomeKey.Down, HomeKey.Down);
  expect(m.state.sideRun).toBe(0);
  press(m, HomeKey.Enter);
  expect(crumb().startsWith("loadout › m1 › run ")).toBe(true); // opened from Runs
});

test("stacked pages push and pop", () => {
  const m = stackedAt(80, 24);
  press(m, HomeKey.Enter);
  expect(focusOf(m)).toBe(FocusArea.Main); // enter pushes the subject page
  press(m, HomeKey.Esc);
  expect(focusOf(m)).toBe(FocusArea.Sidebar); // esc pops home
  press(m, HomeKey.Open);
  expect(focusOf(m)).toBe(FocusArea.Main); // l pushes it too
  press(m, HomeKey.Inspect);
  expect(m.state.inspect).toBeDefined(); // i pushes the inspector
  press(m, HomeKey.Close);
  expect(m.state.inspect).toBeUndefined(); // h pops back to the list
  expect(focusOf(m)).toBe(FocusArea.Main);
  m.state.filters = withValue(m.state.filters, SubjectPrograms, "kit");
  press(m, HomeKey.Esc);
  expect(focusOf(m)).toBe(FocusArea.Main); // esc clears a filter first
  expect(m.state.filters.get(SubjectPrograms)).toBe("");
  press(m, HomeKey.Close);
  expect(focusOf(m)).toBe(FocusArea.Sidebar); // h pops home

  for (const k of [HomeKey.Tab, HomeKey.ShiftTab]) {
    press(m, k);
    expect(focusOf(m)).toBe(FocusArea.Sidebar); // tab does nothing: one page shows
  }
  press(m, HomeKey.Enter, HomeKey.Tab);
  expect(focusOf(m)).toBe(FocusArea.Main);

  press(m, HomeKey.Esc, HomeKey.Subject2);
  expect(focusOf(m)).toBe(FocusArea.Main); // a subject key shows the subject's page from home
  expect(subjectOf(m.state)).toBe(SubjectScripts);
  press(m, HomeKey.Subject1);
  expect(subjectOf(m.state)).toBe(SubjectPrograms);
  expect(shortHelp(m).some((b) => b.help.key === "esc" && b.help.desc === "back")).toBe(true); // the list's help says esc goes back
  for (const group of fullHelp(true)) {
    for (const h of group) expect(h.help.key !== "tab" && h.help.key !== "z").toBe(true); // stacked, the full help has no tab and no zoom
  }
});

test("a stacked run has its own page", () => {
  const m = stackedAt(80, 24);
  press(m, HomeKey.Enter);
  const f = runSomething(m);
  expect(focusOf(m)).toBe(FocusArea.Terminal); // a confirmed run pushes the run page
  expect(terminalTakesKeys(m)).toBe(true); // keys go to the command
  const l = layout(m, true);
  const c = terminalCursor(m)!;
  expect([c.x, c.y]).toEqual([2 + l.mainX, 1 + l.panelY + 1]); // the command's cursor, on its page
  press(m, HomeKey.Leave);
  expect(focusOf(m)).toBe(FocusArea.Main); // ctrl+] pops back to the list while it runs
  press(m, HomeKey.Esc);
  expect(focusOf(m)).toBe(FocusArea.Sidebar); // esc on the list pops home: the panel isn't on this page
  expect(m.shown).toBeDefined();
  press(m, HomeKey.Enter, HomeKey.Tab);
  expect(focusOf(m)).toBe(FocusArea.Main); // tab can't get back to a hidden terminal
  focus(m, FocusArea.Terminal);

  runExited(m, exited(f, 0));
  expect(focusOf(m)).toBe(FocusArea.Terminal); // finished, it stays on its output
  expect(message(m)).toBe("run pull done");
  press(m, HomeKey.Zoom);
  expect(m.state.maximized).toBe(false); // z means nothing: the run page is already full
  press(m, HomeKey.Esc);
  expect(m.shown).toBeUndefined(); // esc closes the finished run
  expect(focusOf(m)).toBe(FocusArea.Main); // and pops back to the list it came from

  // Opened from the home page's Runs, esc pops back to that entry.
  press(m, HomeKey.Esc, HomeKey.Down, HomeKey.Down, HomeKey.Down, HomeKey.Down, HomeKey.Down);
  expect(m.state.sideRun).toBe(0);
  press(m, HomeKey.Enter);
  expect(focusOf(m)).toBe(FocusArea.Terminal); // enter on a run pushes its page
  press(m, HomeKey.Esc);
  expect(focusOf(m)).toBe(FocusArea.Sidebar);
  expect(m.state.sideRun).toBe(0); // on the run's entry

  // Home never closes a run it doesn't show.
  press(m, HomeKey.Enter, HomeKey.Close);
  expect(focusOf(m)).toBe(FocusArea.Sidebar); // h pops too, keeping the run
  expect(m.shown).toBeDefined();
  press(m, HomeKey.Esc);
  expect(m.shown).toBeDefined(); // esc on home closes nothing hidden
  expect(message(m)).toContain("nothing to close");
});

test("resizing across the breakpoint keeps the focus", () => {
  const m = stackedAt(140, 40);
  press(m, HomeKey.Enter);
  const f = runSomething(m);
  runExited(m, exited(f, 0));
  focus(m, FocusArea.Terminal);
  for (const w of [80, 140, 99, 100]) {
    resize(m, w, 30);
    expect(focusOf(m)).toBe(FocusArea.Terminal);
    expect(f.size()).toEqual(termSize(layout(m, true))); // the emulator follows the layout
  }
  resize(m, 80, 24);
  expect(frameOf(m).join("\n")).toContain("Run"); // stacked, its page
});

test("stacked clicks hit the visible page", () => {
  const m = stackedAt(80, 24);
  const l = layout(m, false);
  // The home page: machine, system, blank, Machine ─, blank, then the subjects.
  click(m, { button: MouseButton.Left, x: 5, y: l.pageY + sideHead(false) + 1 });
  expect(focusOf(m)).toBe(FocusArea.Main); // a subject opens its page
  expect(m.state.subject).toBe(1);
  press(m, HomeKey.Subject1);
  click(m, { button: MouseButton.Left, x: 5, y: l.listY + 1 });
  expect(m.state.cursors.get(SubjectPrograms)).toBe(1); // a list row selects
  wheel(m, { button: MouseButton.WheelUp, x: 5, y: l.listY + 1 });
  expect(m.state.cursors.get(SubjectPrograms)).toBe(0); // the wheel scrolls the page shown
});
