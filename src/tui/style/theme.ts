// Package style is the home screen's look: Charmtone colours (Crush's
// "Pantera" dark and a light variant designed here), and pure rendering
// helpers — wordmark, title rows, section headers, rows, dialogs, the status
// bar, toasts and the busy animation — that the screen composes. Nothing here
// holds screen state beyond the small toast and animation models.
//
// Colour roles map onto src/theme's (the CLI keeps its own palette):
// ok = Success/SuccessSubtle, warn = Warning, error = Error, dim =
// FgMoreSubtle/FgMostSubtle, accent = Primary, machine = Secondary.
//
// Rendering produces the bytes Lip Gloss v2 does (lipgloss.ts), and the
// renderer writes them as they are.

import * as charmtone from "./charmtone.ts";
import type { Color } from "./lipgloss.ts";

export type { Color } from "./lipgloss.ts";

/**
 * Theme is every colour token of the screen. Names follow the spec's table;
 * the comments name the Charmtone colour the dark theme uses.
 */
export interface Theme {
  readonly dark: boolean;

  readonly primary: Color; // Charple: focus, titles, borders, selection
  readonly secondary: Color; // Dolly: gradient end, scrollbar thumb, focused button
  readonly accent: Color; // Bok

  readonly bgBase: Color; // Pepper: the app background
  readonly bgLeast: Color; // BBQ
  readonly bgLess: Color; // Char: blurred buttons, dim selection
  readonly bgMost: Color; // Iron: unfocused selection bar
  readonly separator: Color; // Char: rules, the help separator, scrollbar track

  readonly fgBase: Color; // Sash: body text
  readonly fgSubtle: Color; // Smoke
  readonly fgMoreSubtle: Color; // Squid: names, help keys
  readonly fgMostSubtle: Color; // Oyster: summaries, help descriptions, hints
  readonly onPrimary: Color; // Butter: text on Primary / Secondary fills

  readonly success: Color; // Julep
  readonly successSubtle: Color; // Guac
  readonly warning: Color; // Mustard
  readonly attention: Color; // Tang
  readonly busy: Color; // Citron
  readonly error: Color; // Sriracha
  readonly destructive: Color; // Coral
  readonly info: Color; // Malibu
}

/** dark is Charmtone Pantera, Crush's theme. */
export function dark(): Theme {
  return {
    dark: true,
    primary: charmtone.Charple,
    secondary: charmtone.Dolly,
    accent: charmtone.Bok,
    bgBase: charmtone.Pepper,
    bgLeast: charmtone.BBQ,
    bgLess: charmtone.Char,
    bgMost: charmtone.Iron,
    separator: charmtone.Char,
    fgBase: charmtone.Sash,
    fgSubtle: charmtone.Smoke,
    fgMoreSubtle: charmtone.Squid,
    fgMostSubtle: charmtone.Oyster,
    onPrimary: charmtone.Butter,
    success: charmtone.Julep,
    successSubtle: charmtone.Guac,
    warning: charmtone.Mustard,
    attention: charmtone.Tang,
    busy: charmtone.Citron,
    error: charmtone.Sriracha,
    destructive: charmtone.Coral,
    info: charmtone.Malibu,
  };
}

/**
 * light is the same roles on Salt. Neutrals step down the Charmtone greys
 * (Pepper → Char → Oyster → Squid) so every text tier still reads; Primary
 * stays Charple (4.6:1 on Salt); Secondary is Urchin, Dolly's darker
 * neighbour, for the gradients. Charmtone has no yellow, orange or green dark
 * enough for text on a light background, so those statuses keep their
 * Charmtone hue and are deepened (scaled toward black) until they reach 4.5:1
 * on Salt; Error is Pom and SuccessSubtle Gator, Charmtone's own deep red
 * and green.
 */
export function light(): Theme {
  const bg = charmtone.Salt;
  return {
    dark: false,
    primary: charmtone.Charple,
    secondary: charmtone.Urchin,
    accent: charmtone.Oceania,
    bgBase: bg,
    bgLeast: charmtone.Sash,
    bgLess: charmtone.Steep,
    bgMost: charmtone.Smoke,
    separator: charmtone.Steep,
    fgBase: charmtone.Pepper,
    fgSubtle: charmtone.Char,
    fgMoreSubtle: charmtone.Oyster,
    fgMostSubtle: charmtone.Squid,
    onPrimary: charmtone.Butter,
    success: deepen(charmtone.Guac, bg, 4.5),
    successSubtle: charmtone.Gator,
    warning: deepen(charmtone.Mustard, bg, 4.5),
    attention: deepen(charmtone.Tang, bg, 4.5),
    busy: deepen(charmtone.Citron, bg, 4.5),
    error: charmtone.Pom,
    destructive: deepen(charmtone.Coral, bg, 4.5),
    info: deepen(charmtone.Malibu, bg, 4.5),
  };
}

/** themeFor is the theme for a dark (true) or light terminal; src/theme's terminalIsDark decides which. */
export function themeFor(isDark: boolean): Theme {
  return isDark ? dark() : light();
}

/**
 * ink is the text colour to put on fill: the default ink (t.onPrimary) when
 * it reads at 4.5:1, else whichever of onPrimary, fgBase and bgBase
 * contrasts most.
 */
export function ink(t: Theme, fill: Color): Color {
  if (contrast(t.onPrimary, fill) >= 4.5) return t.onPrimary;
  return bestInk(fill, t.onPrimary, t.fgBase, t.bgBase);
}

/** bestInk is the candidate with the highest contrast against fill. */
export function bestInk(fill: Color, ...candidates: Color[]): Color {
  let best = candidates[0]!;
  let bestRatio = -1;
  for (const c of candidates) {
    const r = contrast(c, fill);
    if (r > bestRatio) {
      best = c;
      bestRatio = r;
    }
  }
  return best;
}

/** luminance is a colour's WCAG 2 relative luminance, 0 (black) to 1 (white). */
export function luminance(c: Color): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * contrast is the WCAG 2 contrast ratio of two colours, 1 to 21. Body text
 * wants 4.5, large text and badges 3.
 */
export function contrast(a: Color, b: Color): number {
  let la = luminance(a);
  let lb = luminance(b);
  if (la < lb) [la, lb] = [lb, la];
  return (la + 0.05) / (lb + 0.05);
}

/**
 * deepen scales c toward black, keeping its hue, until it contrasts at least
 * target with bg (a light background). c already there comes back as is.
 */
export function deepen(c: Color, bg: Color, target: number): Color {
  if (contrast(c, bg) >= target) return c;
  for (let f = 0.99; f > 0; f -= 0.01) {
    const d = { r: Math.trunc(c.r * f), g: Math.trunc(c.g * f), b: Math.trunc(c.b * f) };
    if (contrast(d, bg) >= target) return d;
  }
  return { r: 0, g: 0, b: 0 };
}

/**
 * mix is a over b at weight w (0 = all b, 1 = all a), in sRGB: subtler
 * fills of a hue over the background.
 */
export function mix(a: Color, b: Color, w: number): Color {
  const m = (x: number, y: number) => goRound(x * w + y * (1 - w)) & 0xff;
  return { r: m(a.r, b.r), g: m(a.g, b.g), b: m(a.b, b.b) };
}

/** goRound is Go's math.Round: half away from zero. */
function goRound(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** hex is c as `#rrggbb`. */
export function hex(c: Color): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
