import { stringWidth, truncate as ansiTruncate } from "./ansi.ts";
import { newStyle, type Color, type Style } from "./style.ts";

// Glyphs the screen uses. One cell each.
export const GlyphDot = "●";
export const GlyphCheck = "✓";
export const GlyphCross = "×";
export const GlyphDiamond = "◇";
export const GlyphDiamondOn = "◆";
export const GlyphMore = "⋯";
export const GlyphRunning = "⟳";
export const GlyphArrow = "→";
export const GlyphUp = "↑";
export const GlyphTicked = "◉";
export const GlyphUnticked = "○";
export const GlyphTrack = "│";
export const GlyphThumb = "┃";
export const GlyphRule = "─";
export const GlyphBullet = "•";
export const GlyphCrumb = "›";
export const GlyphFoldOpen = "▾";
export const GlyphFoldShut = "▸";
export const Ellipsis = "…";

/** width is s's width in cells, styles ignored. */
export function width(s: string): number {
  return stringWidth(s);
}

/**
 * truncate cuts s (styled or not) to at most width cells, ending in "…" when
 * it cut. Width ≤ 0 is "".
 */
export function truncate(s: string, w: number): string {
  if (w <= 0) return "";
  return ansiTruncate(s, w, Ellipsis);
}

/** fit is s cut or padded with spaces to exactly width cells. */
export function fit(s: string, w: number): string {
  if (w <= 0) return "";
  s = truncate(s, w);
  const sw = width(s);
  if (sw < w) s += " ".repeat(w - sw);
  return s;
}

/** fg is s in colour c. */
export function fg(c: Color, s: string): string {
  if (s === "") return "";
  return newStyle().foreground(c).render(s);
}

/**
 * Span is a piece of a row: text in a colour (undefined = the row's
 * default), optionally bold, with the code point positions a fuzzy filter
 * matched (underlined).
 */
export interface Span {
  readonly text: string;
  readonly fg?: Color | undefined;
  readonly bold?: boolean;
  readonly matches?: readonly number[];
}

/** s is a Span of text in c. */
export function s(text: string, c?: Color): Span {
  return { text, fg: c };
}

export function spansWidth(spans: readonly Span[]): number {
  let w = 0;
  for (const sp of spans) w += width(sp.text);
  return w;
}

/** truncateSpans cuts spans to width cells, the last kept one ending in "…". */
export function truncateSpans(spans: readonly Span[], w: number): Span[] {
  if (spansWidth(spans) <= w) return [...spans];
  if (w <= 0) return [];
  const out: Span[] = [];
  let left = w - 1; // room for the ellipsis
  for (const sp of spans) {
    const sw = width(sp.text);
    if (sw <= left) {
      out.push(sp);
      left -= sw;
      continue;
    }
    out.push({ ...sp, text: ansiTruncate(sp.text, left, "") + Ellipsis });
    return out;
  }
  return out;
}

/**
 * renderSpans styles spans; fgOverride, when set, overrides every span's
 * colour (a selected row's ink), bg paints behind them, def is the colour of
 * spans without one.
 */
export function renderSpans(spans: readonly Span[], def: Color | undefined, fgOverride: Color | undefined, bg: Color | undefined): string {
  let b = "";
  for (const sp of spans) {
    let st = newStyle();
    let c = sp.fg ?? def;
    if (fgOverride) c = fgOverride;
    if (c) st = st.foreground(c);
    if (bg) st = st.background(bg);
    if (sp.bold) st = st.bold(true);
    b += underlineMatches(st, sp.text, sp.matches ?? []);
  }
  return b;
}

/**
 * underline is text in st with the code points at matches (indices, as a
 * fuzzy matcher reports them) underlined.
 */
export function underline(st: Style, text: string, matches: readonly number[]): string {
  return underlineMatches(st, text, matches);
}

function underlineMatches(st: Style, text: string, matches: readonly number[]): string {
  if (text === "") return "";
  if (matches.length === 0) return st.render(text);
  const hit = new Set(matches);
  const ul = st.underline(true);
  let b = "";
  let run = "";
  let runHit = false;
  const flush = () => {
    if (run === "") return;
    b += runHit ? ul.render(run) : st.render(run);
    run = "";
  };
  let i = 0;
  for (const r of text) {
    if (hit.has(i) !== runHit) {
      flush();
      runHit = hit.has(i);
    }
    run += r;
    i++;
  }
  flush();
  return b;
}
