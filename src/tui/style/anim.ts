import { tick, type Cmd, type Msg } from "../messages.ts";
import { fg } from "./text.ts";
import type { Theme } from "./theme.ts";

/**
 * busySpinner is the busy glyph: a braille spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏), at
 * its own pace. One cell, calm, and unlike any status glyph (● means
 * "needs attention" in the sidebar), so a row being checked never reads as
 * a verdict (user decision).
 */
const busySpinner = {
  frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  fps: 1000 / 12, // ms
};

/**
 * BusyTickMsg advances a Busy clock. Ticks of a stopped (or restarted) clock
 * are dropped, so a stop really stops.
 */
export class BusyTickMsg {
  constructor(
    readonly id: number,
    readonly gen: number,
  ) {}
}

let busyIDs = 0;

/**
 * Busy is the one shared clock every busy row animates from: it ticks at
 * the spinner's pace while something is busy and not at all otherwise. Rows
 * draw their own frame from frame() (Run / Inline), so a hundred busy rows
 * cost one timer.
 */
export class Busy {
  private readonly id = ++busyIDs;
  private gen = 0;
  private frameN = 0;
  private isRunning = false;
  /** interval overrides the spinner's pace, in ms (tests). */
  interval = 0;

  /** running says the clock ticks. */
  running(): boolean {
    return this.isRunning;
  }

  /** frame is the clock's current frame. */
  frame(): number {
    return this.frameN;
  }

  /** start makes the clock tick; already running, it does nothing (null). */
  start(): Cmd | null {
    if (this.isRunning) return null;
    this.isRunning = true;
    this.gen++;
    return this.tick();
  }

  /** stop ends the ticking: the pending tick is dropped when it arrives. */
  stop(): void {
    if (this.isRunning) {
      this.isRunning = false;
      this.gen++;
    }
  }

  /**
   * sync starts or stops the clock to match whether anything is busy: call it
   * after every update that may change that (and sync(false) on exit).
   */
  sync(anyBusy: boolean): Cmd | null {
    if (anyBusy) return this.start();
    this.stop();
    return null;
  }

  /**
   * update advances on this clock's current tick and schedules the next; it
   * reports whether msg was this clock's tick (a stale one counts, returning
   * no command).
   */
  update(msg: Msg): [Cmd | null, boolean] {
    if (!(msg instanceof BusyTickMsg) || msg.id !== this.id) return [null, false];
    if (!this.isRunning || msg.gen !== this.gen) return [null, true];
    this.frameN++;
    return [this.tick(), true];
  }

  private tick(): Cmd {
    const { id, gen } = this;
    const d = this.interval > 0 ? this.interval : busySpinner.fps;
    return tick(d, () => new BusyTickMsg(id, gen));
  }
}

/** newBusy is a stopped clock. */
export function newBusy(): Busy {
  return new Busy();
}

/**
 * busyGlyph is a busy row's status slot at frame: the spinner's frame in
 * Primary. Every row shows the same frame: one calm rhythm on the screen.
 */
export function busyGlyph(t: Theme, frame: number): string {
  const frames = busySpinner.frames;
  const n = frames.length;
  return fg(t.primary, frames[((frame % n) + n) % n]!);
}

/** busyLabel is the spinner then label in FgMostSubtle: `⠹ checking…`. */
export function busyLabel(t: Theme, frame: number, label: string): string {
  return busyGlyph(t, frame) + " " + fg(t.fgMostSubtle, label);
}
