// term is the home screen's run panel: one command in a
// pseudo-terminal (Bun.spawn's `terminal`), its screen kept by
// @xterm/headless and drawn as styled lines.
//
// The child gets the PTY as its controlling terminal (Bun starts it in a new
// session with the PTY as its controlling tty), so /dev/tty prompts (sudo,
// gum) use it and Ctrl-C, sent as a key, makes the line discipline signal
// the child's foreground process group, never this process.
//
// It speaks the screen's messages (src/tui/messages.ts): start returns a command
// whose message (OutputMsg, BellMsg, ExitMsg) goes to update, which returns
// the command that keeps them coming. Messages carry the terminal's ID: a
// parent holding several terminals (a finished run kept for viewing beside
// a new one) routes each to its owner, and update ignores the others'.

import { readFileSync } from "node:fs";
import os from "node:os";
import { Terminal as Emulator, type IBufferCell as Cell } from "@xterm/headless";
import { ResetStyle, stringWidth, truncate } from "../style/ansi.ts";
import type { Color } from "../style/style.ts";
import {
  KeyBackspace,
  KeyDelete,
  KeyDown,
  KeyEnd,
  KeyEnter,
  KeyEscape,
  KeyF1,
  KeyHome,
  KeyInsert,
  KeyKp0,
  KeyKpComma,
  KeyKpDecimal,
  KeyKpEnter,
  KeyKpEqual,
  KeyKpMinus,
  KeyKpMultiply,
  KeyKpPlus,
  KeyLeft,
  KeyPgDown,
  KeyPgUp,
  KeyPressMsg,
  KeyRight,
  KeySpace,
  KeyTab,
  KeyUp,
  ModAlt,
  ModCtrl,
  ModShift,
  PasteMsg,
  type Cmd,
  type Msg,
} from "../messages.ts";

/** ScrollbackLines bounds the scrollback the emulator keeps (and so plain). */
export const ScrollbackLines = 2000;

/**
 * exitGrace is how long ExitMsg waits for the PTY's last output once the
 * child is reaped, in ms: a background grandchild may keep the tty open
 * forever.
 */
const exitGrace = 200;

/** closeGrace is how long close waits after SIGHUP, then after SIGKILL, in ms. */
const closeGrace = 1000;

/** OutputMsg says the terminal's screen changed: re-render. */
export class OutputMsg {
  constructor(readonly id: number) {}
}

/** BellMsg says the child rang the bell. */
export class BellMsg {
  constructor(readonly id: number) {}
}

/**
 * ExitMsg says the child exited and its last output is on the screen.
 * code is the exit code, 128+n when killed by signal n, -1 when it never
 * started (err says why). interrupted is exit 130 or death by SIGINT.
 */
export class ExitMsg {
  constructor(
    readonly id: number,
    readonly code: number,
    readonly interrupted: boolean,
    readonly err: Error | null,
  ) {}
}

/**
 * TermCommand is what start runs: argv (no shell), its folder, and its
 * environment (undefined = this process's).
 */
export interface TermCommand {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Cursor is where the cursor shows inside view, and how. */
export interface Cursor {
  readonly x: number;
  readonly y: number;
  readonly shape: "block" | "underline" | "bar";
  readonly blink: boolean;
}

let lastID = 0;

type Subprocess = ReturnType<typeof Bun.spawn>;
type PtyTerminal = NonNullable<Subprocess["terminal"]>;

/** The emulator's internals the public API doesn't expose: DECTCEM and DECSCUSR state. */
interface EmulatorCore {
  _core?: {
    coreService?: {
      isCursorHidden?: boolean;
      decPrivateModes?: { cursorStyle?: "block" | "underline" | "bar"; cursorBlink?: boolean };
    };
  };
}

/** Model is one embedded terminal. */
export class Model {
  private readonly id = ++lastID;
  private w: number;
  private h: number;

  private emu: Emulator | null;
  private titleText = "";
  private fgColor: Color = { r: 0xdd, g: 0xdd, b: 0xdd };
  private bgColor: Color = { r: 0x1e, g: 0x1e, b: 0x1e };

  private proc: Subprocess | null = null;
  private pty: PtyTerminal | null = null;
  private started = false;
  private closed = false;

  // The waiter's state: what the next wait() delivers.
  private dirty = false; // coalesces output bursts into one redraw
  private bell = false;
  private done: ExitMsg | null = null; // the one result
  private quit = false; // set by close: ends a pending wait
  private wake: (() => void)[] = [];

  private reaped = false; // the child is reaped
  private readonly reapedP: Promise<void>;
  private resolveReaped!: () => void;
  private readonly readP: Promise<void>; // settles once the PTY reached EOF (every holder of the tty closed it)
  private resolveRead!: () => void;

  private focused = false;
  private exited = false;
  private exit: ExitMsg;

  private offset = 0; // lines scrolled up from the bottom; 0 = live
  private seenSB = 0; // scrollback length at the last OutputMsg, to hold a scrolled view

  private plain: string[] = []; // after close: the whole log, the emulator dropped

  /** constructor makes an idle terminal of w x h cells. */
  constructor(w: number, h: number) {
    this.w = Math.max(w, 1);
    this.h = Math.max(h, 1);
    this.exit = new ExitMsg(this.id, -1, false, null);
    this.reapedP = new Promise((r) => (this.resolveReaped = r));
    this.readP = new Promise((r) => (this.resolveRead = r));
    const emu = new Emulator({ cols: this.w, rows: this.h, scrollback: ScrollbackLines, allowProposedApi: true });
    this.emu = emu;
    emu.onTitleChange((t) => (this.titleText = t));
    emu.onBell(() => this.notify("bell"));
    // Answers to DA/DSR queries and the like go back to the child.
    emu.onData((d) => this.pty?.write(d));
    // OSC 10/11 queries are answered with setColors' colours (programs pick
    // light or dark from them); xterm leaves them unanswered.
    for (const [ident, which] of [
      [10, "fg"],
      [11, "bg"],
    ] as const) {
      emu.parser.registerOscHandler(ident, (data) => {
        if (data !== "?") return false;
        const c = which === "fg" ? this.fgColor : this.bgColor;
        const x = (v: number) => (v * 257).toString(16).padStart(4, "0");
        this.pty?.write(`\x1b]${ident};rgb:${x(c.r)}/${x(c.g)}/${x(c.b)}\x1b\\`);
        return true;
      });
    }
  }

  /** ID tells this terminal's messages from another's. */
  ID(): number {
    return this.id;
  }

  /**
   * setColors sets the default foreground and background: the colours OSC
   * 10/11 queries are answered with (programs pick light or dark from them).
   */
  setColors(fg: Color, bg: Color): void {
    this.fgColor = fg;
    this.bgColor = bg;
  }

  /**
   * start runs cmd on a new PTY of the terminal's size. Its stdio becomes
   * the PTY; its env (undefined = this process's) gets TERM=xterm-256color
   * and loses what describes the outer terminal. The returned command
   * delivers this terminal's messages; update keeps it going. A second
   * start is an error.
   */
  start(cmd: TermCommand): Cmd {
    const fail = (err: Error): Cmd => {
      this.exited = true;
      this.exit = new ExitMsg(this.id, -1, false, err);
      const msg = this.exit;
      return async () => msg;
    };
    if (this.started || this.closed) return fail(new Error("terminal already used"));
    this.started = true;
    const emu = this.emu!; // the callbacks keep their own reference: close drops this.emu
    let proc: Subprocess;
    try {
      proc = Bun.spawn([...cmd.argv], {
        cwd: cmd.cwd,
        env: terminalEnv(cmd.env),
        terminal: {
          cols: this.w,
          rows: this.h,
          name: "xterm-256color",
          // PTY -> emulator. Ends on EIO (Linux) or EOF (macOS) once every
          // holder of the tty closed it, or when close closes the PTY.
          data: (_t, data) => {
            emu.write(data, () => this.notify("dirty"));
          },
          exit: () => {
            // The emulator parses asynchronously: the read has ended once
            // what it was given is on its screen.
            emu.write("", () => this.resolveRead());
          },
        },
      });
    } catch (e) {
      return fail(e instanceof Error ? e : new Error(String(e)));
    }
    this.proc = proc;
    this.pty = proc.terminal!;
    // Reap; report only once the last output is in the emulator (bounded).
    void proc.exited.then(async () => {
      this.reaped = true;
      this.resolveReaped();
      await Promise.race([this.readP, Bun.sleep(exitGrace)]);
      this.done = exitMsg(this.id, proc);
      this.notify();
    });
    return this.wait();
  }

  private notify(what?: "dirty" | "bell"): void {
    if (what === "dirty") this.dirty = true;
    if (what === "bell") this.bell = true;
    const w = this.wake;
    this.wake = [];
    for (const f of w) f();
  }

  private wait(): Cmd {
    return () =>
      new Promise<Msg>((resolve) => {
        const check = (): boolean => {
          if (this.dirty) {
            this.dirty = false;
            resolve(new OutputMsg(this.id));
          } else if (this.bell) {
            this.bell = false;
            resolve(new BellMsg(this.id));
          } else if (this.done) {
            const d = this.done;
            this.done = null;
            resolve(d);
          } else if (this.quit) {
            resolve(null);
          } else return false;
          return true;
        };
        const again = () => {
          if (!check()) this.wake.push(again);
        };
        again();
      });
  }

  /**
   * update handles this terminal's messages and, while it is focused and
   * running, keys and pastes (every key: the parent keeps its own, such as
   * ctrl+], from reaching it). It returns the command that keeps messages
   * coming.
   */
  update(msg: Msg): Cmd | null {
    if (msg instanceof OutputMsg) {
      if (msg.id === this.id && !this.closed) {
        this.holdScroll();
        return this.wait();
      }
    } else if (msg instanceof BellMsg) {
      if (msg.id === this.id && !this.closed) return this.wait();
    } else if (msg instanceof ExitMsg) {
      if (msg.id === this.id) {
        this.exited = true;
        this.exit = msg;
        this.holdScroll();
      }
    } else if (msg instanceof KeyPressMsg) {
      if (this.running() && this.focused) {
        this.offset = 0;
        this.pty!.write(encodeKey(msg, this.emu!.modes.applicationCursorKeysMode, this.emu!.modes.applicationKeypadMode));
      }
    } else if (msg instanceof PasteMsg) {
      if (this.running() && this.focused) {
        this.offset = 0;
        const bracketed = this.emu!.modes.bracketedPasteMode;
        this.pty!.write(bracketed ? `\x1b[200~${msg.content}\x1b[201~` : msg.content);
      }
    }
    return null;
  }

  /**
   * write sends raw bytes to the child, as typed (keys the screen already
   * holds encoded); nothing unless running.
   */
  write(data: string | Uint8Array): void {
    if (this.running()) {
      this.offset = 0;
      this.pty!.write(data);
    }
  }

  /** holdScroll keeps a scrolled view on the same lines while output pushes new ones into the scrollback. */
  private holdScroll(): void {
    if (!this.emu) return;
    const n = this.scrollbackLen();
    if (this.offset > 0 && n > this.seenSB) this.offset += n - this.seenSB;
    this.seenSB = n;
    this.offset = Math.min(this.offset, this.maxOffset());
  }

  private scrollbackLen(): number {
    const b = this.emu!.buffer.active;
    return b.type === "alternate" ? 0 : b.baseY;
  }

  /** running is true from start until the child exited. */
  running(): boolean {
    return this.started && !this.exited && !this.closed;
  }

  /** hasExited is true once the child exited (or failed to start). */
  hasExited(): boolean {
    return this.exited;
  }

  /** exitCode is the child's exit code (see ExitMsg); -1 before it exits. */
  exitCode(): number {
    return this.exited ? this.exit.code : -1;
  }

  /** interrupted is true when the child exited 130 or by SIGINT. */
  interrupted(): boolean {
    return this.exited && this.exit.interrupted;
  }

  /** err is why the child couldn't start, if so. */
  err(): Error | null {
    return this.exit.err;
  }

  /** title is the last title the child set (OSC 0/2). */
  title(): string {
    return this.titleText;
  }

  /** pid is the child's process ID, 0 before it started (tests). */
  pid(): number {
    return this.proc?.pid ?? 0;
  }

  /** focus routes keys to the child (and reports focus to it if it asked). */
  focus(): void {
    this.focused = true;
    if (this.emu && this.running() && this.emu.modes.sendFocusMode) this.pty!.write("\x1b[I");
  }

  /** blur stops routing keys to the child. */
  blur(): void {
    this.focused = false;
    if (this.emu && this.running() && this.emu.modes.sendFocusMode) this.pty!.write("\x1b[O");
  }

  /** isFocused says whether keys go to the child. */
  isFocused(): boolean {
    return this.focused;
  }

  /** size is the terminal's size in cells. */
  size(): [w: number, h: number] {
    return [this.w, this.h];
  }

  /** resize resizes the emulator and the PTY (the child gets SIGWINCH). */
  resize(w: number, h: number): void {
    w = Math.max(w, 1);
    h = Math.max(h, 1);
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.emu?.resize(w, h);
    if (this.pty && !this.closed) this.pty.resize(w, h);
    this.offset = Math.min(this.offset, this.maxOffset());
  }

  /**
   * interrupt sends SIGINT to the PTY's foreground process group (the
   * child's, or a job it put in the foreground), as ^C would.
   */
  interrupt(): void {
    if (!this.running()) return;
    for (const pg of this.groups()) signalGroup(pg, "SIGINT");
  }

  /**
   * groups is the child's process group and the PTY's foreground one. Bun
   * doesn't expose the PTY's descriptor, so the foreground group is the
   * session's as the kernel reports it: /proc on Linux; macOS has no /proc
   * and gets the child's group alone (a child that puts a job of its own in
   * the foreground, a shell with job control, is the case that misses).
   */
  private groups(): number[] {
    const pid = this.proc!.pid;
    const groups = [pid];
    const fg = foreground(pid);
    if (fg > 0 && fg !== pid) groups.push(fg);
    return groups;
  }

  /**
   * close ends the terminal: a running child's process groups get SIGHUP,
   * then SIGKILL if they outlive the grace; the PTY is released, the
   * emulator is dropped and its text kept for view and plain. The child's
   * exit is recorded if no ExitMsg was handled yet. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.quit = true;
    this.notify();
    try {
      if (!this.pty || !this.proc) return;
      if (!this.reaped) {
        for (const sig of ["SIGHUP", "SIGKILL"] as const) {
          for (const pg of this.groups()) signalGroup(pg, sig);
          if (await within(this.reapedP, closeGrace)) break;
        }
      }
      this.pty.close();
      await within(this.readP, closeGrace);
      if (!this.exited && this.reaped) {
        this.exited = true;
        this.exit = exitMsg(this.id, this.proc);
      }
    } finally {
      this.snapshot();
    }
  }

  /** snapshot keeps the text and drops the emulator. */
  private snapshot(): void {
    if (!this.emu) return;
    this.plain = plainLines(this.emu);
    this.emu.dispose();
    this.emu = null;
    this.offset = Math.min(this.offset, Math.max(this.plain.length - this.h, 0));
  }

  /**
   * plainText is the whole log, scrollback then screen, without styles:
   * trailing spaces and trailing blank lines trimmed. Cheap after close.
   */
  plainText(): string {
    return (this.emu ? plainLines(this.emu) : this.plain).join("\n");
  }

  /**
   * view is the screen (or, scrolled, the lines above it): exactly h lines
   * of w cells, styled. After close it is the kept text, unstyled.
   */
  view(): string {
    if (!this.emu) {
      const end = this.plain.length - this.offset;
      return this.frame(this.plain.slice(Math.max(end - this.h, 0), end));
    }
    const b = this.emu.buffer.active;
    if (b.type === "alternate") return this.frame(renderRows(this.emu, b.baseY, b.baseY + this.h));
    const end = this.contentLen() - this.offset;
    return this.frame(renderRows(this.emu, Math.max(end - this.h, 0), end));
  }

  /**
   * contentLen is how many lines view can show, oldest first: the
   * scrollback, then the screen down to its live end (its last written row,
   * or the cursor's row when lower). The live view is its last h lines,
   * scrolling moves back through it. So a panel that grew (z zooms it)
   * shows the scrollback's last lines in the rows it gained, as kitty or
   * iTerm do on a resize, instead of its output at the top over blank rows.
   * A full-screen program (the alternate screen) draws every row itself and
   * isn't asked.
   */
  private contentLen(): number {
    const emu = this.emu!;
    const b = emu.buffer.active;
    let end = 0;
    for (let y = emu.rows - 1; y >= 0; y--) {
      if ((b.getLine(b.baseY + y)?.translateToString(true) ?? "").trim() !== "") {
        end = y + 1;
        break;
      }
    }
    // The cursor's row is the live end, written or not: a prompt waits on it.
    end = Math.min(Math.max(end, b.cursorY + 1), emu.rows);
    return b.baseY + end;
  }

  /** frame pads or cuts lines to exactly w x h. */
  private frame(lines: readonly string[]): string {
    const out: string[] = [];
    for (let y = 0; y < this.h; y++) {
      let l = lines[y] ?? "";
      const lw = stringWidth(l);
      if (lw > this.w) l = truncate(l, this.w, "");
      else if (lw < this.w) {
        if (l.includes("\x1b")) l += ResetStyle;
        l += " ".repeat(this.w - lw);
      }
      out.push(l);
    }
    return out.join("\n");
  }

  /**
   * cursor is the cursor's position inside view, or null when it shouldn't
   * show: not focused, not running, scrolled back, or hidden by the child.
   * The parent adds the panel's offset.
   */
  cursor(): Cursor | null {
    if (!this.focused || !this.running() || this.offset > 0 || !this.emu) return null;
    const core = (this.emu as unknown as EmulatorCore)._core?.coreService;
    if (core?.isCursorHidden) return null;
    const b = this.emu.buffer.active;
    let y = b.cursorY;
    if (b.type !== "alternate") {
      // The live view starts at content's last h lines: screen row 0 sits
      // baseY-start rows down.
      y += b.baseY - Math.max(this.contentLen() - this.h, 0);
    }
    const modes = core?.decPrivateModes;
    return { x: b.cursorX, y, shape: modes?.cursorStyle ?? "block", blink: modes?.cursorBlink ?? false };
  }

  /** scrolled is how many lines the view is above the live screen. */
  scrolled(): number {
    return this.offset;
  }

  /**
   * scrollUp moves the view n lines back into the scrollback (not while the
   * child shows its alternate screen, which has none).
   */
  scrollUp(n: number): void {
    this.offset = Math.min(this.offset + n, this.maxOffset());
  }

  /** scrollDown moves the view n lines towards the live screen. */
  scrollDown(n: number): void {
    this.offset = Math.max(this.offset - n, 0);
  }

  /** pageUp scrolls back one screen. */
  pageUp(): void {
    this.scrollUp(Math.max(this.h - 1, 1));
  }

  /** pageDown scrolls forward one screen. */
  pageDown(): void {
    this.scrollDown(Math.max(this.h - 1, 1));
  }

  /** top shows the start of the output: the oldest line the scrollback keeps. */
  top(): void {
    this.offset = this.maxOffset();
  }

  /** bottom returns to the live screen. */
  bottom(): void {
    this.offset = 0;
  }

  private maxOffset(): number {
    if (!this.emu) return Math.max(this.plain.length - this.h, 0);
    if (this.emu.buffer.active.type === "alternate") return 0;
    return Math.max(this.contentLen() - this.h, 0);
  }
}

/** newModel is an idle terminal of w x h cells. */
export function newModel(w: number, h: number): Model {
  return new Model(w, h);
}

function exitMsg(id: number, proc: Subprocess): ExitMsg {
  let code = -1;
  let interrupted = false;
  if (proc.signalCode) {
    const n = (os.constants.signals as Record<string, number>)[proc.signalCode] ?? 0;
    code = 128 + n;
    interrupted = proc.signalCode === "SIGINT";
  } else if (proc.exitCode !== null) {
    code = proc.exitCode;
  }
  return new ExitMsg(id, code, interrupted || code === 130, null);
}

function plainLines(emu: Emulator): string[] {
  const b = emu.buffer.active;
  const lines: string[] = [];
  const from = b.type === "alternate" ? b.baseY : 0;
  for (let y = from; y < b.baseY + emu.rows; y++) lines.push((b.getLine(y)?.translateToString(true) ?? "").trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** renderRows is the active buffer's rows [from, to) as styled lines. */
function renderRows(emu: Emulator, from: number, to: number): string[] {
  const b = emu.buffer.active;
  const out: string[] = [];
  const cell = b.getNullCell();
  for (let y = from; y < to; y++) {
    const line = b.getLine(y);
    if (!line) {
      out.push("");
      continue;
    }
    // The last cell that shows anything: text, or a background.
    let last = -1;
    for (let x = line.length - 1; x >= 0; x--) {
      line.getCell(x, cell);
      if (cell.getChars() !== "" || !cell.isBgDefault() || cell.isInverse()) {
        last = x;
        break;
      }
    }
    let s = "";
    let cur = "";
    for (let x = 0; x <= last; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue; // a wide character's second half
      const sgr = cellSgr(cell);
      if (sgr !== cur) {
        if (cur !== "") s += ResetStyle;
        if (sgr !== "") s += `\x1b[${sgr}m`;
        cur = sgr;
      }
      s += cell.getChars() || " ";
    }
    if (cur !== "") s += ResetStyle;
    out.push(s);
  }
  return out;
}

/** cellSgr is a cell's attributes as SGR parameters, "" for none. */
function cellSgr(c: Cell): string {
  if (c.isAttributeDefault()) return "";
  const p: string[] = [];
  if (c.isBold()) p.push("1");
  if (c.isDim()) p.push("2");
  if (c.isItalic()) p.push("3");
  if (c.isUnderline()) p.push("4");
  if (c.isBlink()) p.push("5");
  if (c.isInverse()) p.push("7");
  if (c.isInvisible()) p.push("8");
  if (c.isStrikethrough()) p.push("9");
  if (c.isOverline()) p.push("53");
  const color = (palette: boolean, rgb: boolean, v: number, base: number, bright: number, ext: number) => {
    if (palette) {
      if (v < 8) p.push(String(base + v));
      else if (v < 16) p.push(String(bright + v - 8));
      else p.push(`${ext};5;${v}`);
    } else if (rgb) {
      p.push(`${ext};2;${(v >> 16) & 0xff};${(v >> 8) & 0xff};${v & 0xff}`);
    }
  };
  color(c.isFgPalette(), c.isFgRGB(), c.getFgColor(), 30, 90, 38);
  color(c.isBgPalette(), c.isBgRGB(), c.getBgColor(), 40, 100, 48);
  return p.join(";");
}

/**
 * terminalEnv is env (undefined = this process's) for a child of the
 * emulator: TERM is what it emulates, and variables naming the outer
 * terminal (or its size) go, so nothing talks to that terminal's
 * extensions.
 */
export function terminalEnv(env: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? process.env)) {
    if (v === undefined) continue;
    if (
      ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLUMNS", "LINES", "TERMINFO", "VTE_VERSION", "WT_SESSION", "ITERM_SESSION_ID"].includes(k) ||
      ["KITTY_", "WEZTERM_", "GHOSTTY_", "ALACRITTY_"].some((p) => k.startsWith(p))
    ) {
      continue;
    }
    out[k] = v;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  return out;
}

/** encodeKey is a key press as the bytes a terminal sends for it (vt's SendKey). */
export function encodeKey(key: KeyPressMsg, appCursorKeys: boolean, appKeypad: boolean): string {
  let seq = "";
  let mod = key.mod;
  if (mod & ModAlt) {
    seq = "\x1b";
    mod &= ~ModAlt; // Remove the Alt modifier for easier matching
  }
  const code = key.code;
  if (mod === ModCtrl) {
    if (code === KeySpace) return seq + "\x00";
    if (code >= 0x61 && code <= 0x7a) return seq + String.fromCharCode(code - 0x60); // ctrl+a … ctrl+z
    const ctl: Record<number, string> = { 0x5b: "\x1b", 0x5c: "\x1c", 0x5d: "\x1d", 0x5e: "\x1e", 0x5f: "\x1f" };
    if (ctl[code] !== undefined) return seq + ctl[code];
  }
  if (mod === ModShift && code === KeyTab) return seq + "\x1b[Z";
  if (mod === 0) {
    const arrow = (c: string) => (appCursorKeys ? "\x1bO" : "\x1b[") + c;
    const kp = (app: string, plain: string) => (appKeypad ? "\x1bO" + app : plain);
    switch (code) {
      case KeyEnter:
        return seq + "\r";
      case KeyTab:
        return seq + "\t";
      case KeyBackspace:
        return seq + "\x7f";
      case KeyEscape:
        return seq + "\x1b";
      case KeyUp:
        return seq + arrow("A");
      case KeyDown:
        return seq + arrow("B");
      case KeyRight:
        return seq + arrow("C");
      case KeyLeft:
        return seq + arrow("D");
      case KeyInsert:
        return seq + "\x1b[2~";
      case KeyDelete:
        return seq + "\x1b[3~";
      case KeyHome:
        return seq + "\x1b[H";
      case KeyEnd:
        return seq + "\x1b[F";
      case KeyPgUp:
        return seq + "\x1b[5~";
      case KeyPgDown:
        return seq + "\x1b[6~";
      case KeyKpEnter:
        return seq + kp("M", "\r");
      case KeyKpEqual:
        return seq + kp("X", "=");
      case KeyKpMultiply:
        return seq + kp("j", "*");
      case KeyKpPlus:
        return seq + kp("k", "+");
      case KeyKpComma:
        return seq + kp("l", ",");
      case KeyKpMinus:
        return seq + kp("m", "-");
      case KeyKpDecimal:
        return seq + kp("n", ".");
    }
    if (code >= KeyKp0 && code <= KeyKp0 + 9) {
      const n = code - KeyKp0;
      // vt drops a pending alt prefix on a plain keypad 8 (seq = "8"): kept as it does.
      if (n === 8 && !appKeypad) return "8";
      return seq + kp("pqrstuvwxy"[n]!, String(n));
    }
    const fkeys = ["\x1bOP", "\x1bOQ", "\x1bOR", "\x1bOS", "\x1b[15~", "\x1b[17~", "\x1b[18~", "\x1b[19~", "\x1b[20~", "\x1b[21~", "\x1b[23~", "\x1b[24~"];
    if (code >= KeyF1 && code < KeyF1 + fkeys.length) return seq + fkeys[code - KeyF1]!;
  }
  if (key.text !== "" && (mod & ModCtrl) === 0) return seq + key.text;
  if (key.text === "" && mod === 0) return seq + String.fromCodePoint(code);
  return seq;
}

/** signalGroup sends sig to process group pg, ignoring a group that's gone. */
function signalGroup(pg: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pg, sig);
  } catch {
    // gone already
  }
}

/** foreground is the foreground process group of pid's terminal, or 0 (Linux's /proc only). */
function foreground(pid: number): number {
  if (process.platform !== "linux") return 0;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // pid (comm) state ppid pgrp session tty_nr tpgid …: comm may hold spaces.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[5]) || 0;
  } catch {
    return 0;
  }
}

/** within says whether p settled within ms. */
async function within(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)));
  const ok = await Promise.race([p.then(() => true), timeout]);
  clearTimeout(timer);
  return ok;
}
