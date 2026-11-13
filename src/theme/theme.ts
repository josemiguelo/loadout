// Package theme is the one source of truth for loadout's visual identity,
// shared by the home screen (Lip Gloss colours) and the CLI (24-bit ANSI).
// Color is signal, never decoration: every role below means something
// (ok/warn/error/dim as statuses, accent for headers and actions, machine
// for machine identity).

import { envVar, terminalBackgroundLuma } from "../core/platform/platform.ts";
import { Refusal } from "../model/refusal.ts";

/** Rgb is one 24-bit colour. */
export class Rgb {
  constructor(
    readonly r: number,
    readonly g: number,
    readonly b: number,
  ) {}

  /** hex is the colour as `#rrggbb`, how Lip Gloss takes it. */
  hex(): string {
    const h = (v: number) => v.toString(16).padStart(2, "0");
    return `#${h(this.r)}${h(this.g)}${h(this.b)}`;
  }
}

/** ThemePalette is every role a surface paints with. */
export interface ThemePalette {
  /** text is body text. Explicit so an overlay can paint over coloured cells. */
  readonly text: Rgb;
  readonly accent: Rgb;
  readonly onAccent: Rgb;
  readonly machine: Rgb;
  readonly dim: Rgb;
  readonly ok: Rgb;
  readonly warn: Rgb;
  readonly error: Rgb;
  readonly selectionBg: Rgb;
  readonly selectionFg: Rgb;
  /** idleBg/idleFg is an unfocused button; a focused one is accent/onAccent. */
  readonly idleBg: Rgb;
  readonly idleFg: Rgb;
}

/** Dark is Tokyo Night. */
export const Dark: ThemePalette = {
  text: new Rgb(0xc0, 0xca, 0xf5),
  accent: new Rgb(0x7a, 0xa2, 0xf7),
  onAccent: new Rgb(0x1a, 0x1b, 0x26),
  machine: new Rgb(0xbb, 0x9a, 0xf7),
  // Tokyo Night dark5, not comment (0x565f89): de-emphasized must still be
  // readable — comment-gray drowned on translucent terminal backgrounds.
  dim: new Rgb(0x73, 0x7a, 0xa2),
  ok: new Rgb(0x9e, 0xce, 0x6a),
  warn: new Rgb(0xe0, 0xaf, 0x68),
  error: new Rgb(0xf7, 0x76, 0x8e),
  selectionBg: new Rgb(0x36, 0x4a, 0x82),
  selectionFg: new Rgb(0xc0, 0xca, 0xf5),
  idleBg: new Rgb(0x3b, 0x42, 0x61),
  idleFg: new Rgb(0xa9, 0xb1, 0xd6),
};

/** Light is vivid-but-readable on white (GitHub-light-like saturation). */
export const Light: ThemePalette = {
  text: new Rgb(0x37, 0x60, 0xbf),
  // Navy, not GitHub's #0969da: on white the lighter blue sat too close to
  // the dark palette's pastel accent to read as a different mode.
  accent: new Rgb(0x03, 0x3a, 0x85),
  onAccent: new Rgb(0xff, 0xff, 0xff),
  machine: new Rgb(0x82, 0x50, 0xdf),
  dim: new Rgb(0x6e, 0x77, 0x81),
  ok: new Rgb(0x1a, 0x7f, 0x37),
  warn: new Rgb(0x9a, 0x67, 0x00),
  error: new Rgb(0xd1, 0x24, 0x2f),
  selectionBg: new Rgb(0x2e, 0x33, 0x40),
  selectionFg: new Rgb(0xe5, 0xe9, 0xf0),
  idleBg: new Rgb(0xd8, 0xde, 0xe4),
  idleFg: new Rgb(0x24, 0x29, 0x2f),
};

/** paletteFor is the palette for a dark or a light terminal. */
export function paletteFor(dark: boolean): ThemePalette {
  return dark ? Dark : Light;
}

/**
 * detectDarkTerminal says whether the terminal looks dark: from its
 * background's luminance (OSC 11, undefined when it didn't answer), else
 * the COLORFGBG convention ("<fg>;<bg>", bg 7/15 = light). Unknown -> dark,
 * the safer default.
 */
export function detectDarkTerminal(bgLuma: number | undefined, colorFgBg: string): boolean {
  if (bgLuma !== undefined) return bgLuma < 0.5;
  const last = colorFgBg.slice(colorFgBg.lastIndexOf(";") + 1);
  // strconv.Atoi: an optional sign, then decimal digits only.
  if (colorFgBg === "" || !/^[+-]?[0-9]+$/.test(last)) return true;
  const bg = Number(last);
  return bg !== 7 && bg !== 15;
}

/** ThemeException is a LOADOUT_THEME that is neither dark nor light. */
export class ThemeException extends Refusal {}

/**
 * forcedDark is the palette LOADOUT_THEME asks for: dark (true) or light
 * (false), and whether it asks at all ("" = detect one). Some terminals
 * can't be asked: a tmux popup running its own tmux client answers no
 * background query at all, so a light one gets painted dark. This is the
 * explicit answer for those — and being explicit, it also spares the
 * terminal the question. A value that is neither is a refusal, not a shrug:
 * a typo that silently kept detecting would look exactly like the bug it
 * was set to fix. main validates it first, so later callers can ignore the
 * error (it throws a ThemeException).
 */
export function forcedDark(loadoutTheme: string): { dark: boolean; forced: boolean } {
  switch (loadoutTheme.trim().toLowerCase()) {
    case "":
      return { dark: false, forced: false };
    case "dark":
      return { dark: true, forced: true };
    case "light":
      return { dark: false, forced: true };
  }
  throw new ThemeException(`LOADOUT_THEME must be dark or light, not "${loadoutTheme.trim()}"`);
}

/**
 * terminalIsDark is the answer both surfaces use: what LOADOUT_THEME asks
 * for, else what the terminal says (an OSC 11 query: call it before a
 * screen owns the terminal).
 */
export function terminalIsDark(): boolean {
  try {
    const { dark, forced } = forcedDark(envVar("LOADOUT_THEME") ?? "");
    if (forced) return dark;
  } catch {
    // main refused it already
  }
  return detectDarkTerminal(terminalBackgroundLuma(), envVar("COLORFGBG") ?? "");
}
