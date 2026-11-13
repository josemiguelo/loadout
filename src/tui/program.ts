import { openSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import tty from "node:tty";
import * as app from "../app/index.ts";
import { envVar } from "../core/platform/platform.ts";
import { terminalIsDark } from "../theme/theme.ts";
import { matches, newBinding } from "./key.ts";
import * as style from "./style/index.ts";
import { strip } from "./style/ansi.ts";
import { type Cmd, KeyPressMsg, ModAlt, ModCtrl, type Msg, PasteMsg } from "./tea.ts";
import { BellMsg, type Cursor, ExitMsg, OutputMsg } from "./term/term.ts";
import { apply, FocusArea, type HomeModel, load, newHomeModel, refresh } from "./homemodel.ts";
import { Renderer } from "./renderer.ts";
import { Decoder, keyString, type Mouse, MouseButton, MouseClickMsg, MouseWheelMsg } from "./input.ts";
import { focus, handleKey, handleText, HomeKey, moveCursor, setCursor, sidebarKey, typing, goSubject } from "./keys.ts";
import { listOf, subjectOf } from "./lists.ts";
import { afterJobs, closeRuns, runExited, runsNewestFirst, showRun, terminalMsg } from "./runs.ts";
import { type Layout, layout, Page, page, resize, screenLines, sideHead, sideOffset, sidebarWidth } from "./view.ts";

/**
 * screenDumpEnv names a file the screen writes its current frame to, as
 * plain text, after every render: the integration tests' window on the
 * screen (the renderer writes only changed cells, so the raw output can't be
 * grepped). Undocumented for users.
 */
const screenDumpEnv = "LOADOUT_SCREEN_DUMP";

/** newScreen is the home screen for a: the stored state on screen, the first refresh started. */
export function newScreen(a: app.AppContext): app.Screen {
  // The background query runs before the screen owns the terminal.
  const m = newHomeModel(a, terminalIsDark());
  load(m);
  refresh(m, true);
  return new HomeScreen(m);
}

/** WindowSizeMsg is the terminal's size, at the start and after every resize. */
export class WindowSizeMsg {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
}

/** JobsMsg says a background job finished: its answer is in the queue. */
class JobsMsg {}

/**
 * Program is the loop over HomeModel, Bubble Tea's: keys, mouse, the jobs'
 * answers, the terminal's output and the clocks arrive as messages, update
 * applies each and runs the commands it asks for, whose messages come back
 * the same way. Every state write happens in update; view is the frame,
 * drawn by the renderer (renderer.ts).
 */
export class Program {
  readonly busy = style.newBusy();
  /** dump and dumped are the screen-dump file and its last contents. */
  private dumped = "";
  private quitting = false;
  private viewPending = false;

  constructor(
    readonly m: HomeModel,
    private readonly dump: string,
    /** draw puts a frame on the terminal (the renderer); tests leave it out. */
    private readonly draw: (lines: readonly string[], cursor: Cursor | null) => void = () => {},
    /**
     * schedule runs a redraw soon, once for every message that lands
     * before it (a burst of output is one frame); unset: at once.
     */
    private readonly schedule?: (redraw: () => void) => void,
    /** quit is called once, when the model exits. */
    private readonly quit: () => void = () => {},
  ) {}

  /** init is the first update's commands: the queued answers, the busy clock. */
  init(): Cmd[] {
    const cmds: Cmd[] = [async () => new JobsMsg()];
    const tick = this.busy.sync(anyBusy(this.m));
    if (tick !== null) cmds.push(tick);
    return cmds;
  }

  /** send is one message through update, its commands started, the frame redrawn. */
  send(msg: Msg): void {
    if (this.quitting || msg === null || msg === undefined) return;
    for (const cmd of this.update(msg)) this.run(cmd);
    if (this.quitting) return;
    if (this.schedule === undefined) this.view();
    else if (!this.viewPending) {
      this.viewPending = true;
      this.schedule(() => {
        this.viewPending = false;
        if (!this.quitting) this.view();
      });
    }
  }

  /** run starts cmd; its message comes back through send. */
  run(cmd: Cmd): void {
    void cmd().then(
      (msg) => this.send(msg),
      () => {},
    );
  }

  /** update applies msg to the model, and is the commands it asked for. */
  update(msg: Msg): Cmd[] {
    const m = this.m;
    const cmds: Cmd[] = [];
    if (msg instanceof WindowSizeMsg) resize(m, msg.width, msg.height);
    else if (msg instanceof KeyPressMsg) key(m, msg);
    else if (msg instanceof PasteMsg) {
      if (terminalTakesKeys(m)) terminalMsg(m, m.shown!.term!.ID(), msg);
      else if (typing(m)) handleText(m, msg.content);
    } else if (msg instanceof MouseClickMsg) click(m, msg.mouse);
    else if (msg instanceof MouseWheelMsg) wheel(m, msg.mouse);
    else if (msg instanceof JobsMsg) {
      for (const answer of m.jobs.take()) apply(m, answer);
      afterJobs(m);
    } else if (msg instanceof OutputMsg || msg instanceof BellMsg) terminalMsg(m, msg.id, msg);
    else if (msg instanceof ExitMsg) runExited(m, msg);
    else if (msg instanceof style.ToastExpiredMsg) m.toasts.update(msg);
    else {
      const [cmd, ok] = this.busy.update(msg);
      if (ok && cmd !== null) cmds.push(cmd);
      // A reducer's continuation (an explain, a plan) lands like a job's answer.
      if (!ok) apply(m, msg);
    }
    cmds.push(...takeCmds(m));
    // EVERY clock stops on exit: one still re-arming would outlive the screen.
    if (m.state.exit) {
      this.busy.sync(false);
      this.quitting = true;
      this.view();
      this.quit();
      return [];
    }
    const tick = this.busy.sync(anyBusy(m));
    if (tick !== null) cmds.push(tick);
    return cmds;
  }

  /** view is the frame: drawn, and dumped when it changed. */
  view(): string {
    const m = this.m;
    const lines = screenLines(m, this.busy.frame());
    const content = lines.join("\n");
    this.writeDump(lines);
    this.draw(lines, terminalCursor(m));
    return content;
  }

  /**
   * writeDump writes the frame as plain text to the dump file, when there is
   * one: atomically (a reader never sees half a frame) and only when changed.
   */
  private writeDump(lines: readonly string[]): void {
    if (this.dump === "") return;
    const text = lines.map((line) => strip(line).replace(/ +$/, "")).join("\n") + "\n";
    if (text === this.dumped) return;
    this.dumped = text;
    const tmp = join(dirname(this.dump), "." + basename(this.dump) + ".tmp");
    try {
      writeFileSync(tmp, text, { mode: 0o644 });
      renameSync(tmp, this.dump);
    } catch {
      // the dump is the tests' window, never the screen's problem
    }
  }
}

/** takeCmds is what the reducers asked to run since the last update. */
export function takeCmds(m: HomeModel): Cmd[] {
  const cmds = m.cmds;
  m.cmds = [];
  return cmds;
}

/** anyBusy says something on screen animates: a check, the remotes, a run. */
export function anyBusy(m: HomeModel): boolean {
  if (m.state.exit) return false;
  return m.state.checking.size > 0 || m.state.remote?.kind === "asking" || m.active !== undefined;
}

/**
 * terminalTakesKeys says keys go to the running command: its terminal is
 * focused (ctrl+] is kept back, see key).
 */
export function terminalTakesKeys(m: HomeModel): boolean {
  return m.state.focus === FocusArea.Terminal && m.state.dialog === undefined && m.shown !== undefined && m.shown === m.active && m.shown.term !== undefined;
}

/** terminalCursor is the command's cursor on the screen, while it has the keys. */
export function terminalCursor(m: HomeModel): Cursor | null {
  if (!terminalTakesKeys(m)) return null;
  const c = m.shown!.term!.cursor();
  if (c === null) return null;
  const l = layout(m, true);
  return { ...c, x: c.x + l.mainX, y: c.y + l.panelY + 1 };
}

/** key is one key press: to the running command, to an input, or to the screen's reducers. */
export function key(m: HomeModel, msg: KeyPressMsg): void {
  if (terminalTakesKeys(m)) {
    if (matches(keyString(msg), leaveKey)) {
      handleKey(m, HomeKey.Leave);
      return;
    }
    terminalMsg(m, m.shown!.term!.ID(), msg);
    return;
  }
  if (typing(m) && msg.text !== "" && (msg.mod & (ModCtrl | ModAlt)) === 0) {
    handleText(m, msg.text);
    return;
  }
  const k = homeKeyOf(msg);
  if (k !== undefined) handleKey(m, k);
}

/** click is a mouse click: a subject, a run, a list row or the run panel — stacked, on the page shown only. */
export function click(m: HomeModel, mouse: Mouse): void {
  if (mouse.button !== MouseButton.Left || m.state.dialog !== undefined) return;
  const l = layout(m, m.shown !== undefined);
  const { x, y } = mouse;
  if (!l.wide) {
    switch (page(m)) {
      case Page.Home:
        // A subject or a run opens its page.
        sideClick(m, y - l.pageY + sideOffset(m, sideLen(m, false), l.statusY - l.pageY, false), false);
        break;
      case Page.Subject:
        listClick(m, l, y);
        break;
    }
    return;
  }
  if (x < l.sideX + sidebarWidth) sideClick(m, y + sideOffset(m, sideLen(m, true), l.statusY, true), true);
  else if (m.shown !== undefined && y >= l.panelY && y < l.panelY + l.panelH) focus(m, FocusArea.Terminal);
  else listClick(m, l, y);
}

/** sideLen is how many lines the sidebar has (sideLines' count). */
function sideLen(m: HomeModel, logo: boolean): number {
  return sideHead(logo) + m.state.sections.length + 3 + Math.max(m.runs.length, 1);
}

/**
 * sideClick is a click on the sidebar's line n: a subject (wide: shown
 * beside it; stacked: its page opens) or a run (its panel opens).
 */
function sideClick(m: HomeModel, n: number, wide: boolean): void {
  const s = m.state;
  const i = n - sideHead(wide);
  if (i >= 0 && i < s.sections.length) {
    goSubject(m, i);
    focus(m, wide ? FocusArea.Sidebar : FocusArea.Main);
    return;
  }
  const runs = runsNewestFirst(m);
  const r = n - sideHead(wide) - s.sections.length - 3;
  if (r >= 0 && r < runs.length) {
    s.sideRun = r;
    showRun(m, runs[r]!);
    s.runFromSidebar = true;
    focus(m, FocusArea.Terminal);
  }
}

/** listClick is a click on row y of the main pane: a list row is selected. */
function listClick(m: HomeModel, l: Layout, y: number): void {
  const s = m.state;
  if (y < l.listY || y >= l.listY + l.listH || s.inspect !== undefined) return;
  const subject = subjectOf(s);
  const items = listOf(s, subject);
  const n = y - l.listY + Math.min(Math.max(s.offsets.get(subject) ?? 0, 0), Math.max(items.length - l.listH, 0));
  if (n < items.length && items[n]!.focusable) {
    focus(m, FocusArea.Main);
    setCursor(m, subject, n);
  }
}

/** wheel scrolls the pane under the mouse (stacked: the page shown). */
export function wheel(m: HomeModel, mouse: Mouse): void {
  if (m.state.dialog !== undefined) return;
  const up = mouse.button === MouseButton.WheelUp;
  if (mouse.button !== MouseButton.WheelUp && mouse.button !== MouseButton.WheelDown) return;
  const l = layout(m, m.shown !== undefined);
  let panel = m.shown?.term !== undefined && mouse.y >= l.panelY && mouse.y < l.panelY + l.panelH;
  let main = mouse.x >= l.mainX;
  if (!l.wide) {
    const p = page(m);
    if (p === Page.Home) {
      // The home page moves its selection, as ↑↓ do.
      sidebarKey(m, up ? HomeKey.Up : HomeKey.Down);
      return;
    }
    panel = p === Page.Run && m.shown?.term !== undefined;
    main = p === Page.Subject;
  }
  if (panel) {
    if (up) m.shown!.term!.scrollUp(3);
    else m.shown!.term!.scrollDown(3);
  } else if (main) {
    const inspector = m.state.inspect;
    if (inspector !== undefined) {
      m.state.inspect = { ...inspector, scroll: up ? Math.max(inspector.scroll - 3, 0) : inspector.scroll + 3 };
      return;
    }
    moveCursor(m, up ? -3 : 3);
  }
}

const leaveKey = newBinding({ keys: ["ctrl+]"] });

/** keys maps the terminal's keys onto the screen's. */
const keys: [ReturnType<typeof newBinding>, HomeKey][] = [
  [newBinding({ keys: ["up", "k"] }), HomeKey.Up],
  [newBinding({ keys: ["down", "j"] }), HomeKey.Down],
  [newBinding({ keys: ["right", "l"] }), HomeKey.Open],
  [newBinding({ keys: ["left", "h"] }), HomeKey.Close],
  [newBinding({ keys: ["pgup"] }), HomeKey.PageUp],
  [newBinding({ keys: ["pgdown"] }), HomeKey.PageDown],
  // vim's and less's half pages (user decision).
  [newBinding({ keys: ["ctrl+u"] }), HomeKey.HalfUp],
  [newBinding({ keys: ["ctrl+d"] }), HomeKey.HalfDown],
  // vim's section jump: over the rows to the next group.
  [newBinding({ keys: ["["] }), HomeKey.PrevHeading],
  [newBinding({ keys: ["]"] }), HomeKey.NextHeading],
  [newBinding({ keys: ["enter"] }), HomeKey.Enter],
  [newBinding({ keys: ["esc"] }), HomeKey.Esc],
  [newBinding({ keys: ["space"] }), HomeKey.Select],
  [newBinding({ keys: ["a"] }), HomeKey.SelectAll],
  [newBinding({ keys: ["u"] }), HomeKey.SelectNone],
  // Lazy's key for "show me the diff": the row's compare page, in the browser.
  [newBinding({ keys: ["K", "shift+k"] }), HomeKey.OpenLink],
  [newBinding({ keys: ["r"] }), HomeKey.Refresh],
  // Capitals for the consequential ones: S pushes, U replaces the binary, C
  // converges the machine.
  [newBinding({ keys: ["S", "shift+s"] }), HomeKey.Sync],
  [newBinding({ keys: ["U", "shift+u"] }), HomeKey.Upgrade],
  [newBinding({ keys: ["C", "shift+c"] }), HomeKey.Converge],
  [newBinding({ keys: ["t"] }), HomeKey.Theme],
  [newBinding({ keys: ["q"] }), HomeKey.Quit],
  [newBinding({ keys: ["tab"] }), HomeKey.Tab],
  [newBinding({ keys: ["shift+tab"] }), HomeKey.ShiftTab],
  [newBinding({ keys: ["y"] }), HomeKey.Yes],
  [newBinding({ keys: ["n"] }), HomeKey.No],
  [newBinding({ keys: ["/"] }), HomeKey.Filter],
  [newBinding({ keys: ["i"] }), HomeKey.Inspect],
  [newBinding({ keys: ["ctrl+p"] }), HomeKey.Palette],
  [newBinding({ keys: ["ctrl+g"] }), HomeKey.Help],
  [leaveKey, HomeKey.Leave],
  [newBinding({ keys: ["ctrl+c"] }), HomeKey.Interrupt],
  [newBinding({ keys: ["z"] }), HomeKey.Zoom],
  // vim's and less's ends of a text (user decision): the run's output.
  [newBinding({ keys: ["home"] }), HomeKey.Top],
  [newBinding({ keys: ["end", "G", "shift+g"] }), HomeKey.Bottom],
  [newBinding({ keys: ["g"] }), HomeKey.G],
  [newBinding({ keys: ["backspace"] }), HomeKey.Backspace],
  [newBinding({ keys: ["1"] }), HomeKey.Subject1],
  [newBinding({ keys: ["2"] }), HomeKey.Subject2],
  [newBinding({ keys: ["3"] }), HomeKey.Subject3],
  [newBinding({ keys: ["4"] }), HomeKey.Subject4],
  [newBinding({ keys: ["5"] }), HomeKey.Subject5],
];

/** homeKeyOf is the screen's key for msg, undefined when it has none. */
export function homeKeyOf(msg: KeyPressMsg): HomeKey | undefined {
  const s = keyString(msg);
  for (const [binding, k] of keys) if (matches(s, binding)) return k;
  return undefined;
}

// ---------------------------------------------------------------- the terminal

/**
 * HomeScreen is the home screen: one program for the whole session, drawn
 * on the alternate screen, its input read from the tty.
 */
class HomeScreen implements app.Screen {
  constructor(private readonly m: HomeModel) {}

  /**
   * run runs the program on the alternate screen until the model exits. Keys
   * come from the terminal even when stdin is a pipe.
   */
  async run(): Promise<app.Ended> {
    const m = this.m;
    let input: tty.ReadStream;
    let ownInput = false;
    if (process.stdin.isTTY) input = process.stdin as tty.ReadStream;
    else {
      try {
        input = new tty.ReadStream(openSync("/dev/tty", "r"));
        ownInput = true;
      } catch {
        throw new Error("Unable to run in non-interactive mode.");
      }
    }
    const out = process.stdout;
    const write = (s: string) => {
      try {
        out.write(s);
      } catch {
        // the terminal went away
      }
    };

    const renderer = new Renderer(write);
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const p = new Program(
      m,
      envVar(screenDumpEnv) ?? "",
      (lines, cursor) => renderer.draw(lines, cursor),
      (redraw) => setTimeout(redraw, 0),
      () => done(),
    );

    // Bubble Tea's terminal: the alternate screen, mouse cell motion in SGR,
    // bracketed paste, the window's title. No background colour: the
    // terminal's own (a transparent one included) shows.
    input.setRawMode(true);
    renderer.start();
    write("\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b]2;loadout\x07");

    const decoder = new Decoder();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const onData = (data: Buffer | string) => {
      clearTimeout(flushTimer);
      for (const msg of decoder.feed(data.toString())) p.send(msg);
      if (decoder.pending()) flushTimer = setTimeout(() => decoder.flush().forEach((msg) => p.send(msg)), 50);
    };
    input.on("data", onData);
    input.resume();
    const onResize = () => {
      renderer.repaint();
      p.send(new WindowSizeMsg(out.columns ?? m.width, out.rows ?? m.height));
    };
    out.on("resize", onResize);
    m.jobs.setNotify(() => queueMicrotask(() => p.send(new JobsMsg())));

    p.send(new WindowSizeMsg(out.columns ?? m.width, out.rows ?? m.height));
    for (const cmd of p.init()) p.run(cmd);
    await finished;

    m.jobs.setNotify(undefined);
    clearTimeout(flushTimer);
    input.off("data", onData);
    out.off("resize", onResize);
    write("\x1b[?2004l\x1b[?1006l\x1b[?1002l");
    renderer.stop();
    input.setRawMode(false);
    input.pause();
    if (ownInput) input.destroy();
    await closeRuns(m);
    return m.ended ?? { message: "", code: 0 };
  }
}
