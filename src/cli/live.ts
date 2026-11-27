// live is how the commands that run steps look on a terminal: the command
// runs again as an inner loadout on a pseudo-terminal of its own (one, for
// the whole run: sudo's password, asked once, holds for every step, and a
// step's prompts work as they would on the real terminal), and this outer
// loadout draws it. A finished step is one line; the step running now shows
// a spinner and its last lines (a third of the terminal's rows, at least
// ten), where any prompt it asks appears; a failed step's whole output
// stays. Everything, a successful step's output too, goes to the run's log
// ($XDG_STATE_HOME/loadout/runs/, the newest 20 kept), named at the end. What the inner loadout prints between steps
// (the plan, the confirmation) passes through as it is. The inner loadout
// marks where steps start and end with events (progress.ts) and is
// otherwise unchanged; keys typed here go to it.
//
// Only on a terminal, and not inside the home screen's run panel (it has its
// own) or a live run's inner loadout; LOADOUT_PLAIN=1 turns it off.

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Terminal as Emulator } from "@xterm/headless";
import { selfExecutable } from "../core/platform/platform.ts";
import { renderRows, terminalEnv } from "../tui/term/term.ts";
import { exitWith } from "./errors.ts";
import { duration, endLine, EventParser, liveEnv, type ProgressEvent } from "./progress.ts";
import { spinnerFrames } from "./spinner.ts";
import { Style } from "./style.ts";
import { codePointCount } from "./table.ts";

/** gutter is what a step's lines are indented by: "  │ ". */
const gutter = 4;
/** tailMin is the fewest of the running step's last lines that show; a tall terminal shows a third of its rows. */
const tailMin = 10;
/** keptLogs is how many run logs stay (runs/ in loadout's state folder). */
const keptLogs = 20;

/** plain is s without its SGR escapes: what the run log gets. */
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

interface Step {
  name: string;
  detail: string;
  index: number;
  total: number;
  started: number;
  /** startLine is the normal buffer's line the step's output starts on. */
  startLine: number;
}

/** LiveView turns the inner loadout's output into what the terminal shows. */
export class LiveView {
  private readonly emu: Emulator;
  private readonly parser = new EventParser();
  private step: Step | undefined;
  /** flushed is the first line of the normal buffer not printed for good yet. */
  private flushed = 0;
  /** shown is how many lines the live area takes on screen; at is the row of the cursor in it. */
  private shown = 0;
  private at = 0;
  private pending: string[] = [];
  private frame = 0;
  private queue: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    private cols: number,
    private rows: number,
    private readonly out: (s: string) => void,
    private readonly now: () => number = () => performance.now(),
    private readonly log: (line: string) => void = () => {},
  ) {
    this.emu = new Emulator({ cols: ptyColumns(cols), rows, scrollback: 100_000, allowProposedApi: true });
  }

  /** ptyCols is the inner loadout's width: the terminal's less the gutter, so a step's lines fit beside it. */
  get ptyCols(): number {
    return ptyColumns(this.cols);
  }

  /** feed takes a chunk of the inner loadout's output; a step's start or end redraws at once. */
  feed(chunk: string): Promise<void> {
    for (const piece of this.parser.feed(chunk)) {
      if (typeof piece === "string") {
        this.queue = this.queue.then(() => new Promise<void>((done) => this.emu.write(piece, done)));
        this.dirty = true;
      } else {
        this.queue = this.queue.then(() => {
          this.apply(piece);
          this.draw();
        });
      }
    }
    return this.queue;
  }

  /** tick moves the spinner and draws what came since. */
  tick(): void {
    this.frame++;
    this.queue = this.queue.then(() => this.draw());
  }

  /** resize follows the terminal to cols x rows. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.queue = this.queue.then(() => {
      this.emu.resize(ptyColumns(cols), rows);
      this.draw();
    });
  }

  /** finish prints what's left for good, leaving the cursor on a line of its own. */
  finish(): Promise<void> {
    this.queue = this.queue.then(() => {
      if (this.step !== undefined) this.endStep("failed", "stopped", (this.now() - this.step.started) / 1000);
      const last = this.lastLine();
      if (last >= this.flushed) {
        this.pending.push(...this.render(this.flushed, last + 1));
        this.logRows(this.flushed, last + 1);
      }
      this.flushed = last + 1;
      this.draw();
      this.out("\x1b[?25h");
    });
    return this.queue;
  }

  private buffer() {
    return this.emu.buffer.normal;
  }

  private cursorLine(): number {
    const b = this.buffer();
    return b.baseY + b.cursorY;
  }

  /** lastLine is the normal buffer's last line with anything on it (before flushed: nothing left). */
  private lastLine(): number {
    for (let y = this.buffer().length - 1; y >= this.flushed; y--) if (!this.blank(y)) return y;
    return this.flushed - 1;
  }

  private render(from: number, to: number): string[] {
    return renderRows(this.emu, from, to, this.buffer());
  }

  /** logRows writes rows [from, to) of the normal buffer to the run log, as plain text. */
  private logRows(from: number, to: number): void {
    for (let y = from; y < to; y++) this.log(this.buffer().getLine(y)?.translateToString(true) ?? "");
  }

  /** tail is how many of the running step's last lines show: a third of the rows, at least tailMin, room left for the header. */
  private tail(): number {
    return Math.max(1, Math.min(Math.max(tailMin, Math.floor(this.rows / 3)), this.rows - 3));
  }

  private blank(line: number): boolean {
    return (this.buffer().getLine(line)?.translateToString(true) ?? "").trim() === "";
  }

  private apply(ev: ProgressEvent): void {
    switch (ev.t) {
      case "start":
        this.flushPlain();
        this.step = {
          name: ev.name,
          detail: ev.detail,
          index: ev.index,
          total: ev.total,
          started: this.now(),
          startLine: this.cursorLine(),
        };
        this.log("");
        this.log("━━ " + ev.index + "/" + ev.total + " " + ev.name + (ev.detail === "" ? "" : "  " + ev.detail));
        return;
      case "end":
        this.endStep(ev.status, ev.note, ev.seconds);
        return;
      case "phase":
        this.flushPlain();
        this.pending.push("", Style.header("── " + ev.name) + (ev.note === "" ? "" : Style.dim(" (" + ev.note + ")")));
        this.log("");
        this.log("── " + ev.name + (ev.note === "" ? "" : " (" + ev.note + ")"));
        return;
    }
  }

  /** endStep prints the step's line, and its output when it failed; the rest of its output goes. */
  private endStep(status: "ok" | "failed" | "skipped" | "done", note: string, seconds: number): void {
    const step = this.step;
    if (step === undefined) return;
    const c = this.cursorLine();
    const end = this.blank(c) ? c : c + 1;
    if (status === "failed") {
      let lines = this.render(step.startLine, end);
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines = lines.slice(0, -1);
      this.pending.push(...lines.map((l) => "  " + Style.dim("│") + " " + l));
    }
    this.pending.push(endLine(step.name, status, note, seconds));
    // The log keeps every step's output, a successful one's too.
    this.logRows(step.startLine, end);
    this.log(plain(endLine(step.name, status, note, seconds)));
    this.flushed = end;
    this.step = undefined;
  }

  /** flushPlain prints for good the finished lines between steps (the plan, answers). */
  private flushPlain(): void {
    if (this.step !== undefined || this.emu.buffer.active !== this.buffer()) return;
    const c = this.cursorLine();
    if (c > this.flushed) {
      this.pending.push(...this.render(this.flushed, c));
      this.logRows(this.flushed, c);
    }
    this.flushed = Math.max(this.flushed, c);
  }

  /** live is the live area's lines, and where the cursor goes in it (undefined: hidden). */
  private live(): { lines: string[]; cursor?: [row: number, col: number] } {
    const active = this.emu.buffer.active;
    if (active !== this.buffer()) {
      // A full-screen program (a pager, a menu): its whole screen.
      const lines = renderRows(this.emu, active.viewportY, active.viewportY + Math.min(this.rows - 1, this.emu.rows), active);
      return { lines, cursor: [active.cursorY, active.cursorX] };
    }
    const c = this.cursorLine();
    const x = this.buffer().cursorX;
    if (this.step === undefined) {
      if (c < this.flushed) return { lines: [] };
      const lines = this.render(this.flushed, c + 1);
      if (lines.every((l) => l.trim() === "") && x === 0) return { lines: [] };
      return { lines, cursor: [lines.length - 1, x] };
    }
    const step = this.step;
    const lines = [this.header(step)];
    let last = c;
    if (x === 0 && this.blank(c)) last--;
    const from = Math.max(step.startLine, last - this.tail() + 1);
    if (from > step.startLine) lines.push("  " + Style.dim("│ … " + (from - step.startLine) + " more line(s)"));
    let cursor: [number, number] | undefined;
    for (const [i, l] of this.render(from, last + 1).entries()) {
      if (from + i === c) cursor = [lines.length, gutter + x];
      lines.push("  " + Style.dim("│") + " " + l);
    }
    return { lines, cursor };
  }

  /** header is the running step's line: spinner, name, what it runs, where the run is. */
  private header(step: Step): string {
    const right = step.index + "/" + step.total + "  " + duration((this.now() - step.started) / 1000);
    const room = this.cols - 2 - codePointCount(step.name) - 2 - codePointCount(right) - 2;
    let detail = step.detail;
    if (room <= 1) detail = "";
    else if (codePointCount(detail) > room) detail = [...detail].slice(0, room - 1).join("") + "…";
    const used = 2 + codePointCount(step.name) + (detail === "" ? 0 : 2 + codePointCount(detail));
    const pad = Math.max(2, this.cols - used - codePointCount(right));
    const spinner = Style.accent(spinnerFrames[this.frame % spinnerFrames.length]!);
    return spinner + " " + Style.bold(step.name) + (detail === "" ? "" : "  " + Style.dim(detail)) + " ".repeat(pad) + Style.dim(right);
  }

  /** draw replaces the live area: what's printed for good first, then the live lines. */
  private draw(): void {
    if (this.step === undefined) this.flushPlain();
    const live = this.live();
    let s = "\x1b[?25l";
    if (this.shown > 0) s += "\r" + (this.at > 0 ? `\x1b[${this.at}A` : "") + "\x1b[J";
    for (const l of this.pending) s += l + "\x1b[K\r\n";
    this.pending = [];
    s += live.lines.join("\r\n");
    this.shown = live.lines.length;
    this.at = Math.max(0, live.lines.length - 1);
    if (live.cursor !== undefined && live.lines.length > 0) {
      const up = live.lines.length - 1 - live.cursor[0];
      s += (up > 0 ? `\x1b[${up}A` : "") + "\r" + (live.cursor[1] > 0 ? `\x1b[${live.cursor[1]}C` : "") + "\x1b[?25h";
      this.at = live.cursor[0];
    }
    this.dirty = false;
    this.out(s);
  }

  /** changed says text arrived since the last draw. */
  get changed(): boolean {
    return this.dirty;
  }
}

function ptyColumns(cols: number): number {
  return Math.max(20, cols - gutter);
}

/** liveWanted says this command should run live: a terminal, and nothing turning it off. */
export function liveWanted(): boolean {
  if (process.env[liveEnv] === "1" || process.env.LOADOUT_HANDOFF === "1" || process.env.LOADOUT_PLAIN === "1") return false;
  if (process.env.TERM === "dumb" || process.platform === "win32") return false;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  return (process.stdout.columns ?? 0) >= 40;
}

/**
 * runLive runs this command again as the inner loadout of a live run and
 * draws it; its exit code. undefined when it can't (no binary of its own to
 * run): the command then runs plainly.
 */
export async function runLive(): Promise<number | undefined> {
  const self = selfExecutable();
  if (self === "") return undefined;
  const stdout = process.stdout;
  const log = openRunLog();
  const view = new LiveView(stdout.columns ?? 80, stdout.rows ?? 24, (s) => stdout.write(s), undefined, log?.line);
  const decoder = new TextDecoder();
  let closed: () => void = () => {};
  const ended = new Promise<void>((done) => (closed = done));
  const term = new Bun.Terminal({
    cols: view.ptyCols,
    rows: stdout.rows ?? 24,
    data: (_t, data) => void view.feed(decoder.decode(data, { stream: true })),
    exit: () => closed(),
  });
  const proc = Bun.spawn([self, ...process.argv.slice(2)], { terminal: term, env: { ...terminalEnv(process.env), [liveEnv]: "1" } });
  const stdin = process.stdin;
  const keys = (d: Buffer) => term.write(d);
  stdin.setRawMode(true);
  stdin.on("data", keys);
  stdin.resume();
  const onResize = () => {
    view.resize(stdout.columns ?? 80, stdout.rows ?? 24);
    term.resize(view.ptyCols, stdout.rows ?? 24);
  };
  stdout.on("resize", onResize);
  const timer = setInterval(() => view.tick(), 80);
  try {
    const code = await proc.exited;
    // The last of its output arrives after it exits.
    await Promise.race([ended, Bun.sleep(1000)]);
    await view.finish();
    if (log !== undefined) {
      await log.close();
      stdout.write(Style.dim("Full output: " + log.path) + "\n");
    }
    return code;
  } finally {
    clearInterval(timer);
    stdout.off("resize", onResize);
    stdin.off("data", keys);
    stdin.setRawMode(false);
    stdin.pause();
    term.close();
  }
}

/**
 * openRunLog starts this run's log in loadout's state folder
 * ($XDG_STATE_HOME/loadout/runs/<date>-<time>.log), keeping the newest
 * keptLogs; undefined when it can't be written (the run goes on without).
 */
function openRunLog(): { path: string; line: (s: string) => void; close: () => Promise<void> } | undefined {
  try {
    const state = process.env.XDG_STATE_HOME || join(process.env.HOME ?? "", ".local", "state");
    const dir = join(state, "loadout", "runs");
    mkdirSync(dir, { recursive: true });
    const old = readdirSync(dir).filter((f) => f.endsWith(".log")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - (keptLogs - 1)))) rmSync(join(dir, f), { force: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..*$/, "");
    const path = join(dir, stamp + ".log");
    const writer = Bun.file(path).writer();
    writer.write("loadout " + process.argv.slice(2).join(" ") + "\n");
    return {
      path,
      line: (s) => void writer.write(s + "\n"),
      close: async () => {
        await writer.end();
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * ranLive runs the command live when it should, and says whether it did; a
 * live run that failed throws its exit code. The commands that run steps
 * call it first, and stop when it ran.
 */
export async function ranLive(): Promise<boolean> {
  if (!liveWanted()) return false;
  const code = await runLive();
  if (code === undefined) return false;
  if (code !== 0) throw exitWith(code);
  return true;
}
