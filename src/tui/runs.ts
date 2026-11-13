import * as app from "../app/index.ts";
import { toolTooOld as repoToolTooOld } from "../core/loader/loader.ts";
import type { Color } from "./style/index.ts";
import type { Cmd, Msg } from "./tea.ts";
import type { Cursor, ExitMsg, TermCommand } from "./term/term.ts";
import { askRemotesAgain, errorText, FocusArea, firstLine, type HomeModel, load, refresh, reload, theme } from "./homemodel.ts";
import { fail, hey, okay, warn } from "./keys.ts";
import { layout, termSize } from "./view.ts";

/**
 * maxRuns is how many of this session's runs the Runs list keeps. Only the
 * newest finished one keeps its emulator (4 MiB); the others keep their
 * text.
 */
export const maxRuns = 10;

/**
 * interruptedCode is the exit of a command stopped by Ctrl-C (128 + SIGINT):
 * the child loadout traps it and exits with it (LOADOUT_HANDOFF).
 */
const interruptedCode = 130;

/**
 * Terminal is what the screen needs of the run panel's emulator
 * (term.Model, which is one); tests drive a fake.
 */
export interface Terminal {
  ID(): number;
  start(cmd: TermCommand): Cmd | null;
  update(msg: Msg): Cmd | null;
  view(): string;
  cursor(): Cursor | null;
  size(): [w: number, h: number];
  resize(w: number, h: number): void;
  focus(): void;
  blur(): void;
  running(): boolean;
  interrupt(): void;
  close(): Promise<void>;
  scrollUp(n: number): void;
  scrollDown(n: number): void;
  pageUp(): void;
  pageDown(): void;
  top(): void;
  bottom(): void;
  scrolled(): number;
  setColors(fg: Color, bg: Color): void;
  plainText(): string;
}

/** Run is one command this session ran in the run panel. */
export class Run {
  done = false;
  code = 0;
  interrupted = false;
  err: Error | null = null;
  ended = new Date(0);
  /** released says the emulator was closed: its text stays, unstyled. (Go's closed.) */
  released = false;
  /** closing is the emulator's close, once released (the screen waits for it on exit). */
  closing: Promise<void> | undefined;

  constructor(
    readonly closed: app.Closed,
    /**
     * command is the whole command line ("loadout upgrade brew --yes"),
     * label the short name the Runs list shows ("upgrade brew").
     */
    readonly command: string,
    readonly label: string,
    readonly started: Date,
    readonly term: Terminal | undefined,
  ) {}

  /** status is the run's glyph status. */
  status(): "running" | "interrupted" | "done" | "failed" {
    if (!this.done) return "running";
    if (this.interrupted) return "interrupted";
    if (this.code === 0 && this.err === null) return "done";
    return "failed";
  }

  /** duration is how long it ran (so far), as m:ss or Ns. */
  duration(now: Date): string {
    const end = this.done ? this.ended : now;
    // Go's Duration.Round(time.Second): half away from zero.
    const ms = end.getTime() - this.started.getTime();
    const d = Math.sign(ms) * Math.round(Math.abs(ms) / 1000);
    if (d < 60 && this.done) return `${Math.trunc(d)}s`;
    const minutes = Math.trunc(d / 60);
    const seconds = Math.trunc(d) % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  /** release closes the run's emulator, keeping its text. */
  release(): void {
    if (this.term !== undefined && !this.released) {
      this.closing = this.term.close().catch(() => {});
      this.released = true;
    }
  }
}

/** commandLine is closed's command as the user would type it, and its short label. */
export function commandLine(closed: app.Closed): [line: string, label: string] {
  const command = app.closedCommand(closed) ?? { name: "", args: [] };
  const words = [command.name, ...command.args];
  const short = words.filter((w) => w !== "--yes" && w !== "--force");
  return ["loadout " + words.join(" "), short.join(" ")];
}

/**
 * confirm runs closed: now, or once the background checks still running have
 * finished (none may run beside the command, or write the state file after
 * it). One run at a time.
 */
export function confirm(m: HomeModel, closed: app.Closed): void {
  m.state.dialog = undefined;
  if (m.active !== undefined || m.waiting !== undefined) {
    hey(m, "a command is running — wait for it or ctrl+c it");
    return;
  }
  m.jobs.hold();
  if (m.jobs.busy()) {
    m.waiting = closed;
    hey(m, "finishing the checks still running…");
    return;
  }
  startRun(m, closed);
}

/** afterJobs starts the run that waited for the checks, once they're done. */
export function afterJobs(m: HomeModel): void {
  if (m.waiting !== undefined && !m.jobs.busy()) {
    const closed = m.waiting;
    m.waiting = undefined;
    startRun(m, closed);
  }
}

/** startRun starts closed's command in the run panel, focused. */
function startRun(m: HomeModel, closed: app.Closed): void {
  if (m.runCommand === undefined) {
    m.jobs.release();
    return;
  }
  let cmd: app.ChildCommand | undefined;
  try {
    cmd = m.runCommand(closed);
  } catch (e) {
    m.jobs.release();
    fail(m, firstLine(errorText(e)));
    return;
  }
  if (cmd === undefined) {
    m.jobs.release();
    return;
  }
  const [line, label] = commandLine(closed);
  m.state.maximized = false;
  const [w, h] = termSize(layout(m, true));
  const t = m.newTerm(w, h);
  const th = theme(m);
  t.setColors(th.fgBase, th.bgBase);
  const run = new Run(closed, line, label, m.now(), t);
  // Only the newest finished run keeps its emulator.
  for (const r of m.runs) r.release();
  m.runs.push(run);
  if (m.runs.length > maxRuns) m.runs.splice(0, m.runs.length - maxRuns);
  m.active = run;
  m.shown = run;
  m.state.sideRun = -1;
  m.state.runFromSidebar = false;
  m.state.focus = FocusArea.Terminal;
  t.focus();
  const start = t.start(cmd);
  if (start !== null) m.cmds.push(start);
}

/** runOf is the run whose terminal has id. */
function runOf(m: HomeModel, id: number): Run | undefined {
  return m.runs.find((r) => r.term !== undefined && r.term.ID() === id);
}

/** terminalMsg routes a terminal's output and bell to it. */
export function terminalMsg(m: HomeModel, id: number, msg: Msg): void {
  const r = runOf(m, id);
  if (r !== undefined && !r.released) {
    const cmd = r.term!.update(msg);
    if (cmd !== null) m.cmds.push(cmd);
  }
}

/**
 * runExited is a run's command ending: the toast, the checks back on, and
 * the same follow-ups as the command's own re-check would need.
 */
export function runExited(m: HomeModel, msg: ExitMsg): void {
  const r = runOf(m, msg.id);
  if (r === undefined || r.done) return;
  r.term!.update(msg);
  r.term!.blur();
  r.done = true;
  r.code = msg.code;
  r.interrupted = msg.interrupted || msg.code === interruptedCode;
  r.err = msg.err;
  r.ended = m.now();
  if (m.active === r) m.active = undefined;
  // Its output stays in view and keeps the focus (user decision): stacked on
  // the run page, side by side in the panel below the list, ready to scroll,
  // jump (gg/G), zoom or close (esc). The emulator is blurred, so keys reach
  // the screen's own bindings, not the ended command.
  const ok = r.code === 0 && r.err === null;
  if (ok) okay(m, r.label + " done");
  else if (r.interrupted) warn(m, r.label + " interrupted");
  else if (r.err !== null) fail(m, r.label + ": " + firstLine(r.err.message));
  else fail(m, `${r.label}: exit ${r.code}`);
  m.jobs.release();
  // The binary on disk is another version now: self-upgrade, or a sync that
  // pulled a repo this binary can't read (it upgraded loadout to carry on).
  // This one can't go on reading the repo.
  if (r.closed.action === app.ActionUpgrade) {
    let message = "loadout self-upgrade finished — run loadout again to use the new version";
    let code = 0;
    if (!ok) {
      message = `loadout self-upgrade failed (exit ${r.code})`;
      code = r.code;
    }
    end(m, r, message, code);
    return;
  }
  if (r.closed.action === app.ActionSync && toolTooOld(m)) {
    end(m, r, "loadout upgraded itself to sync this repo — run loadout again to use the new version", 0);
    return;
  }
  followUp(m, r.closed, ok);
}

/** end ends the screen after r, printing its output and message on the normal screen. */
function end(m: HomeModel, r: Run, message: string, code: number): void {
  const out = r.term!.plainText().replace(/\n+$/, "");
  if (out !== "") message = out + "\n\n" + message;
  m.ended = { message, code };
  m.state.exit = true;
}

/** toolTooOld says the repo now refuses this binary (a sync upgraded loadout). */
function toolTooOld(m: HomeModel): boolean {
  return m.app !== undefined && repoToolTooOld(m.app.repoRoot);
}

/**
 * followUp is what a finished run changes on screen (ok: it exited 0). Rows
 * re-read the state file the command wrote; the remotes are asked again
 * after an upgrade, everything after sync or set-up (the repo may have
 * changed), the machine after a failure (the file may be stale). Upgrade
 * ticks clear on success only.
 */
export function followUp(m: HomeModel, closed: app.Closed, ok: boolean): void {
  const upgraded = closed.handoff !== undefined && closed.handoff.kind === app.PaneUpgrade;
  if (upgraded && ok) m.state.selection = new Set();
  if (closed.action === app.ActionSync || closed.action === app.ActionSetup) {
    if (m.app !== undefined) {
      m.app.reloadLayout();
      try {
        load(m);
      } catch (e) {
        fail(m, firstLine(errorText(e)));
      }
    }
    refresh(m, true);
  } else if (!ok) {
    reload(m);
    refresh(m, upgraded);
  } else {
    reload(m);
    if (upgraded) askRemotesAgain(m);
  }
}

/** showRun puts r in the run panel. */
export function showRun(m: HomeModel, r: Run): void {
  if (m.shown !== undefined && m.shown !== r && m.shown !== m.active) m.shown.release();
  m.shown = r;
  if (r.term !== undefined) {
    const [w, h] = termSize(layout(m, true));
    r.term.resize(w, h);
  }
}

/**
 * finishedPanel says the run panel shows a command that has ended: esc
 * closes it from any area (a running one only stops with ctrl+c).
 */
export function finishedPanel(m: HomeModel): boolean {
  return m.shown !== undefined && m.shown !== m.active;
}

/** dismissRun hides the run panel; a finished run's emulator closes. */
export function dismissRun(m: HomeModel): void {
  if (m.shown === undefined || m.shown === m.active) return;
  m.shown.release();
  m.shown = undefined;
  m.state.maximized = false;
  if (m.state.focus === FocusArea.Terminal) m.state.focus = backFromRun(m);
  m.state.runFromSidebar = false;
}

/**
 * backFromRun is where the focus goes when it leaves the run panel: the
 * sidebar, on the same Runs entry, when the run was opened from there;
 * otherwise the main pane.
 */
export function backFromRun(m: HomeModel): FocusArea {
  const runs = runsNewestFirst(m);
  const s = m.state;
  if (s.runFromSidebar && s.sideRun >= 0 && s.sideRun < runs.length) return FocusArea.Sidebar;
  return FocusArea.Main;
}

/** blurTerm stops the run panel's terminal taking keys. */
export function blurTerm(m: HomeModel): void {
  m.shown?.term?.blur();
}

/** interrupt sends Ctrl-C to the running command's terminal. */
export function interrupt(m: HomeModel): void {
  if (m.active?.term !== undefined) {
    m.active.term.interrupt();
    hey(m, "interrupting " + m.active.label + "…");
  }
}

/** closeRuns ends every emulator (the screen is leaving); it settles once they're closed. */
export async function closeRuns(m: HomeModel): Promise<void> {
  for (const r of m.runs) r.release();
  await Promise.all(m.runs.map((r) => r.closing));
}

/** runsNewestFirst is the Runs list's order. */
export function runsNewestFirst(m: HomeModel): Run[] {
  return [...m.runs].reverse();
}
