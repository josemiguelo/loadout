import { isStdoutTty } from "../core/platform/platform.ts";
import { Dark, Light, type Rgb, type ThemePalette, terminalIsDark } from "../theme/theme.ts";

/**
 * Styler is ANSI styling for CLI screens, using the SAME Tokyo Night / Day
 * palette as the home screen (src/theme) so every surface speaks one
 * visual language — same roles too: ok/warn/error/dim as statuses, accent
 * for headers/actions, machine for machine identity. Color is signal, never
 * decoration. Dark vs light is settled once, at the first styled output
 * (LOADOUT_THEME if set, else an OSC 11 background query, COLORFGBG
 * fallback, dark default) — only when stdout is a TTY, so piped output stays
 * plain and never touches the terminal.
 * Style AFTER padding — escape codes would break padEnd widths.
 */
export class Styler {
  private settled = false;
  private on = false;
  private colours: ThemePalette = Dark;

  /**
   * forced (tests) skips detection: styled or not, with that palette.
   */
  constructor(forced?: { enabled: boolean; palette: ThemePalette }) {
    if (forced !== undefined) {
      this.settled = true;
      this.on = forced.enabled;
      this.colours = forced.palette;
    }
  }

  /** init settles the palette, once: the root runs it before any command. */
  init(): void {
    if (this.settled) return;
    this.settled = true;
    this.on = isStdoutTty();
    this.colours = Dark;
    if (this.on && !terminalIsDark()) this.colours = Light;
  }

  /** enabled says whether output is styled (stdout is a terminal). */
  enabled(): boolean {
    this.init();
    return this.on;
  }

  /** palette is the palette output is styled with. */
  palette(): ThemePalette {
    this.init();
    return this.colours;
  }

  ok(text: string): string {
    return this.fg(text, this.palette().ok);
  }
  warn(text: string): string {
    return this.fg(text, this.palette().warn);
  }
  error(text: string): string {
    return this.fg(text, this.palette().error);
  }
  dim(text: string): string {
    return this.fg(text, this.palette().dim);
  }
  accent(text: string): string {
    return this.fg(text, this.palette().accent);
  }
  machine(text: string): string {
    return this.fg(text, this.palette().machine);
  }

  bold(text: string): string {
    if (!this.enabled()) return text;
    return "\x1b[1m" + text + "\x1b[0m";
  }

  /** header is bold accent — section headers, mirroring the TUI's title styling. */
  header(text: string): string {
    return this.bold(this.accent(text));
  }

  private fg(text: string, c: Rgb): string {
    if (!this.enabled()) return text;
    return `\x1b[38;2;${c.r};${c.g};${c.b}m${text}\x1b[0m`;
  }

  /**
   * Help's roles in the palette: warning = section titles, info =
   * option/argument/command names, muted = metavars, danger = errors.
   * Each resets to the default foreground.
   */
  private helpFg(text: string, c: Rgb): string {
    if (!this.enabled() || text === "") return text;
    return `\x1b[38;2;${c.r};${c.g};${c.b}m${text}\x1b[39m`;
  }

  helpTitle(text: string): string {
    return this.helpFg(text, this.palette().warn);
  }
  helpName(text: string): string {
    return this.helpFg(text, this.palette().accent);
  }
  helpMuted(text: string): string {
    return this.helpFg(text, this.palette().dim);
  }
  helpDanger(text: string): string {
    return this.helpFg(text, this.palette().error);
  }
}

/** Style is the CLI's one styler. */
export const Style = new Styler();
