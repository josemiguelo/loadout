import type { Cursor } from "./term/term.ts";

/**
 * Renderer draws the screen's frames on the terminal's alternate screen, as
 * Bubble Tea's renderer does: only what changed (whole rows here, cells
 * there), inside synchronized output, then the command's cursor where it
 * stands, or none. Each row is written as view built it, Lip Gloss's bytes
 * unchanged.
 *
 * Not Ink's renderer: it re-tokenizes every styled cell of the frame on each
 * render (60–130 ms for a 140×40 screen), and the busy spinner redraws
 * twelve times a second: the screen sat at a full core, and the run panel's
 * answers to a command's terminal queries came too late for it.
 */
export class Renderer {
  private last: string[] = [];
  private cursorShown = false;
  private shape = 0;
  private started = false;

  constructor(private readonly write: (s: string) => void) {}

  /** start enters the alternate screen, cleared, the cursor hidden. */
  start(): void {
    this.started = true;
    this.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
  }

  /** draw puts lines (one per row) on the screen, and the cursor at cursor (null: hidden). */
  draw(lines: readonly string[], cursor: Cursor | null): void {
    if (!this.started) return;
    let b = "";
    if (this.cursorShown) b += "\x1b[?25l";
    lines.forEach((line, y) => {
      if (this.last[y] === line) return;
      b += `\x1b[${y + 1};1H` + line + "\x1b[m\x1b[K";
    });
    for (let y = lines.length; y < this.last.length; y++) b += `\x1b[${y + 1};1H\x1b[K`;
    this.last = [...lines];
    this.cursorShown = cursor !== null;
    if (cursor !== null) {
      const shape = cursorShape(cursor);
      if (shape !== this.shape) {
        this.shape = shape;
        b += `\x1b[${shape} q`;
      }
      b += `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h`;
    }
    if (b === "") return;
    this.write("\x1b[?2026h" + b + "\x1b[?2026l");
  }

  /** repaint forgets what is on the screen: the next draw writes every row (after a resize). */
  repaint(): void {
    this.last = [];
    if (this.started) this.write("\x1b[H\x1b[2J");
  }

  /** stop gives the normal screen back as it was, the cursor shown in its default shape. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.write((this.shape !== 0 ? "\x1b[0 q" : "") + "\x1b[?25h\x1b[?1049l");
  }
}

/** cursorShape is DECSCUSR's parameter for c. */
function cursorShape(c: Cursor): number {
  const base = c.shape === "underline" ? 3 : c.shape === "bar" ? 5 : 1;
  return c.blink ? base : base + 1;
}
