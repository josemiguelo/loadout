import { strip } from "./ansi.ts";
import { blend1D, newStyle, type Color } from "./lipgloss.ts";
import {
  fg,
  fit,
  GlyphCheck,
  GlyphCross,
  GlyphDot,
  GlyphFoldOpen,
  GlyphFoldShut,
  GlyphRule,
  GlyphRunning,
  GlyphThumb,
  GlyphTicked,
  GlyphTrack,
  GlyphUnticked,
  renderSpans,
  s,
  spansWidth,
  truncate,
  truncateSpans,
  width,
  type Span,
} from "./text.ts";
import type { Theme } from "./theme.ts";

/** ramp is n colours blending from → to (n ≥ 1). */
export function ramp(n: number, from: Color, to: Color): Color[] {
  if (n <= 0) return [];
  if (n === 1) return [from];
  return blend1D(n, from, to);
}

/**
 * gradient is s with a per-cell horizontal gradient from → to; spaces stay
 * plain (they show no colour anyway).
 */
export function gradient(str: string, from: Color, to: Color, bold: boolean): string {
  const runes = [...str];
  if (runes.length === 0) return "";
  const r = ramp(runes.length, from, to);
  let b = "";
  runes.forEach((ch, i) => {
    if (ch === " ") {
      b += ch;
      return;
    }
    let st = newStyle().foreground(r[i]!);
    if (bold) st = st.bold(true);
    b += st.render(ch);
  });
  return b;
}

/**
 * titleRow is a pane or dialog title row, exactly width cells:
 * `Title          info` — the title bold in Primary, info (already styled,
 * or plain: FgMoreSubtle) at the right, spaces between. Narrow widths drop
 * info first, then cut the title.
 */
export function titleRow(t: Theme, title: string, info: string, w: number): string {
  return titleRowIn(t, t.primary, title, info, w);
}

/**
 * titleRowFocused is the title row of the area that has the focus: the
 * same highlight as a focused list's selected row (listRow), a full-width
 * Primary fill with OnPrimary ink and the title bold, so tab lands on
 * something that stands out in every area, the run panel included (user
 * decision). info's own colours give way to the fill's ink.
 */
export function titleRowFocused(t: Theme, title: string, info: string, w: number): string {
  if (w <= 0) return "";
  return listRow(t, [{ text: title, bold: true }], [s(strip(info))], Focus.SelectedFocused, w);
}

/**
 * titleRowMuted is titleRow for an area without the focus: the title in
 * FgMoreSubtle, so the focused area's purple title is the one that reads.
 */
export function titleRowMuted(t: Theme, title: string, info: string, w: number): string {
  return titleRowIn(t, t.fgMoreSubtle, title, info, w);
}

/**
 * divider is the colour of the rules between the screen's areas (the
 * sidebar's edge, the line above the run panel): BgMost, quiet but
 * visible on the terminal's own background, transparent included.
 */
export function divider(t: Theme, str: string): string {
  return fg(t.bgMost, str);
}

function titleRowIn(t: Theme, c: Color, title: string, info: string, w: number): string {
  if (w <= 0) return "";
  const tw = width(title);
  let iw = width(info);
  if (info !== "" && tw + 2 + iw > w) {
    info = "";
    iw = 0;
  }
  if (tw >= w) return fit(boldFg(c, truncate(title, w)), w);
  if (info === "") return boldFg(c, title) + " ".repeat(w - tw);
  return boldFg(c, title) + " ".repeat(w - tw - iw) + styledOr(info, t.fgMoreSubtle);
}

/**
 * section is a sidebar/main section header, exactly width cells:
 * `Title ────────── info` — title in FgMostSubtle, the rule in Separator,
 * info (styled, or plain: FgMostSubtle) at the right.
 */
export function section(t: Theme, title: string, info: string, w: number): string {
  if (w <= 0) return "";
  const tw = width(title);
  let iw = width(info);
  if (info !== "" && tw + 1 + 2 + 1 + iw > w) {
    info = "";
    iw = 0;
  }
  if (tw + 1 >= w) return fit(fg(t.fgMostSubtle, truncate(title, w)), w);
  let rule = w - tw - 1;
  let tail = "";
  if (info !== "") {
    rule -= iw + 1;
    tail = " " + styledOr(info, t.fgMostSubtle);
  }
  return fg(t.fgMostSubtle, title) + " " + fg(t.separator, GlyphRule.repeat(rule)) + tail;
}

/** none is an empty section's placeholder. */
export function none(t: Theme): string {
  return fg(t.fgMostSubtle, "None");
}

/** styledOr colours plain str in c; styled str is left as the caller made it. */
export function styledOr(str: string, c: Color): string {
  if (str.includes("\x1b")) return str;
  return fg(c, str);
}

/** Focus is a row's selection state. */
export enum Focus {
  /** Unselected is a plain row. */
  Unselected = 0,
  /** SelectedFocused is the cursor's row in the focused area. */
  SelectedFocused = 1,
  /**
   * SelectedBlurred is the cursor's row while its area isn't focused: kept,
   * in a dimmer tone.
   */
  SelectedBlurred = 2,
}

/**
 * subjectRow is a sidebar subject, exactly width cells:
 * `  ● name            summary`. glyph is one styled cell (a status glyph
 * or a busy frame). Unselected: name FgMoreSubtle, summary FgMostSubtle.
 * The selected row stands out like the main pane's: the whole row on a
 * fill — Primary with OnPrimary ink and a bold name when the sidebar has
 * the focus, BgLess with FgSubtle when it doesn't. No bar.
 * The summary is cut first when space runs out; summaries line up.
 */
export function subjectRow(t: Theme, glyph: string, name: string, summary: string, focus: Focus, w: number): string {
  if (w <= 0) return "";
  if (glyph === "") glyph = " ";
  let ink: Color;
  let bg: Color;
  let bold = false;
  switch (focus) {
    case Focus.SelectedFocused:
      [ink, bg, bold] = [t.onPrimary, t.primary, true];
      break;
    case Focus.SelectedBlurred:
      [ink, bg] = [t.fgSubtle, t.bgLess];
      break;
    default: {
      const lead = "  " + glyph + " ";
      return fit(lead + spread(t, [s(name, t.fgMoreSubtle)], [s(summary, t.fgMostSubtle)], w - width(lead), undefined, undefined), w);
    }
  }
  // Selected: the whole row on a fill, like the main pane's selected row,
  // with no bar (user decision); the glyph keeps its column and takes the
  // fill's ink so it stays legible.
  if (w < 3) return newStyle().background(bg).render(" ".repeat(w));
  const fill = newStyle().background(bg).render("  ");
  const left: Span[] = [s(strip(glyph) + " "), { text: name, bold }];
  return fill + spread(t, left, [s(summary)], w - 2, ink, bg);
}

/**
 * spread lays left and right spans over width cells: right flush right,
 * cut first, left cut after; one space at least between them.
 */
function spread(t: Theme, left: readonly Span[], right: readonly Span[], w: number, ink: Color | undefined, bg: Color | undefined): string {
  if (w <= 0) return "";
  let lw = spansWidth(left);
  let rw = spansWidth(right);
  if (rw > 0 && lw + 1 + rw > w) {
    right = truncateSpans(right, Math.max(w - lw - 1, 0));
    if (spansWidth(right) < 2) right = []; // a lone "…" says nothing
    rw = spansWidth(right);
  }
  const gapMin = rw > 0 ? 1 : 0;
  left = truncateSpans(left, w - rw - gapMin);
  lw = spansWidth(left);
  let gap = " ".repeat(Math.max(w - lw - rw, 0));
  if (bg) gap = newStyle().background(bg).render(gap);
  return renderSpans(left, t.fgBase, ink, bg) + gap + renderSpans(right, t.fgMostSubtle, ink, bg);
}

/**
 * listRow is a main-pane list row, exactly width cells, Padding(0,1): left
 * spans (default FgBase) and right spans (an info column, default
 * FgMostSubtle) flush right. Selected in the focused area: the full width on
 * Primary with OnPrimary ink; selected while blurred: BgLess with FgSubtle.
 */
export function listRow(t: Theme, left: readonly Span[], right: readonly Span[], focus: Focus, w: number): string {
  if (w <= 0) return "";
  let ink: Color | undefined;
  let bg: Color | undefined;
  switch (focus) {
    case Focus.SelectedFocused:
      [ink, bg] = [t.onPrimary, t.primary];
      break;
    case Focus.SelectedBlurred:
      [ink, bg] = [t.fgSubtle, t.bgLess];
      break;
  }
  if (w < 3) return fit(renderSpans(truncateSpans(left, w), t.fgBase, ink, bg), w);
  const pad = bg ? newStyle().background(bg).render(" ") : " ";
  return pad + spread(t, left, right, w - 2, ink, bg) + pad;
}

/** tick is a tick-list box: ◉ ticked (Primary), ○ not (FgMostSubtle). */
export function tick(t: Theme, ticked: boolean): Span {
  return ticked ? s(GlyphTicked, t.primary) : s(GlyphUnticked, t.fgMostSubtle);
}

/** fold is a tree group's fold mark: ▾ open, ▸ shut (FgMoreSubtle). */
export function fold(t: Theme, open: boolean): Span {
  return s(open ? GlyphFoldOpen : GlyphFoldShut, t.fgMoreSubtle);
}

/** Status is what a status glyph says. */
export enum Status {
  OK = 0, // ✓ Success
  Done = 1, // ✓ SuccessSubtle (a finished run)
  Pending = 2, // ● Warning: something to do
  Attention = 3, // ● Attention
  Failed = 4, // × Error
  Interrupted = 5, // × Attention
  Running = 6, // ⟳ Busy
  Idle = 7, // ○ FgMostSubtle
}

/** statusGlyph is the one-cell glyph for st. */
export function statusGlyph(t: Theme, st: Status): Span {
  switch (st) {
    case Status.OK:
      return s(GlyphCheck, t.success);
    case Status.Done:
      return s(GlyphCheck, t.successSubtle);
    case Status.Pending:
      return s(GlyphDot, t.warning);
    case Status.Attention:
      return s(GlyphDot, t.attention);
    case Status.Failed:
      return s(GlyphCross, t.error);
    case Status.Interrupted:
      return s(GlyphCross, t.attention);
    case Status.Running:
      return s(GlyphRunning, t.busy);
  }
  return s(GlyphUnticked, t.fgMostSubtle);
}

/** renderSpan is a lone span styled (no fg = FgBase): Go's Span.Render. */
export function renderSpan(t: Theme, sp: Span): string {
  return renderSpans([sp], t.fgBase, undefined, undefined);
}

/**
 * scrollbar is a height-cell column for a list of total rows showing
 * visible of them from offset: thumb `┃` in Secondary over a `│` track in
 * Separator. Everything fits: blank cells.
 */
export function scrollbar(t: Theme, height: number, total: number, visible: number, offset: number): string[] {
  const out = new Array<string>(Math.max(height, 0)).fill("");
  if (height <= 0) return out;
  if (total <= visible || visible <= 0) return out.fill(" ");
  const thumb = Math.max(Math.trunc((height * visible) / total), 1);
  const maxOffset = total - visible;
  offset = Math.min(Math.max(offset, 0), maxOffset);
  let start = 0;
  if (maxOffset > 0) {
    start = Math.trunc(((height - thumb) * offset) / maxOffset);
    if (offset > 0 && start === 0) start = Math.min(1, height - thumb); // moved at all: show it moved
  }
  const thumbCell = fg(t.secondary, GlyphThumb);
  const trackCell = fg(t.separator, GlyphTrack);
  return out.map((_, i) => (i >= start && i < start + thumb ? thumbCell : trackCell));
}

export function boldFg(c: Color, str: string): string {
  return renderSpans([{ text: str, fg: c, bold: true }], undefined, undefined, undefined);
}
