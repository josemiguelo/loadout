import { ResetStyle, truncate as ansiTruncate, truncateLeft } from "./ansi.ts";
import { styledOr, titleRow } from "./elements.ts";
import { newStyle } from "./style.ts";
import { fit, truncate, width } from "./text.ts";
import type { Theme } from "./theme.ts";

// Dialog caps from the spec: 70×20 unless the content needs more; a wide
// dialog (the confirm's step lines) may grow to 100.
export const DialogMaxWidth = 70;
export const DialogMaxHeight = 20;
export const DialogWideMaxWidth = 100;

/**
 * Dialog is a centred overlay's frame and content. Body lines come
 * pre-styled (rows from listRow etc.); the frame cuts what doesn't fit.
 */
export interface Dialog {
  title: string;
  /** info sits at the title row's right. */
  info?: string;
  body?: readonly string[];
  /** buttons are labels; focused is the focused one's index (-1: none). */
  buttons?: readonly string[];
  focused?: number;
  /** help is the bottom hint line (plain: FgMostSubtle). */
  help?: string;
  /** destructive draws the border in Destructive instead of Primary. */
  destructive?: boolean;
  /**
   * width is the inner width wanted (0: fit the content). maxWidth and
   * maxHeight cap the whole frame (0: DialogMaxWidth/DialogMaxHeight).
   */
  width?: number;
  maxWidth?: number;
  maxHeight?: number;
}

/** dialog chrome: border 1 each side + Padding(0,1) inside. */
const dialogHChrome = 4;

/**
 * button is one dialog button: focused OnPrimary on Secondary, bold;
 * blurred FgBase on BgLess. Padding(0,2).
 */
export function button(t: Theme, label: string, focused: boolean): string {
  let st = newStyle().padding(0, 2);
  st = focused ? st.foreground(t.onPrimary).background(t.secondary).bold(true) : st.foreground(t.fgBase).background(t.bgLess);
  return st.render(label);
}

/** buttons are labels side by side, two cells apart. */
export function buttons(t: Theme, labels: readonly string[], focused: number): string {
  return labels.map((l, i) => button(t, l, i === focused)).join("  ");
}

const rounded = { top: "─", bottom: "─", left: "│", right: "│", topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯" };

/**
 * renderDialog is the dialog as lines, for a screen of screenW × screenH
 * cells: rounded border, the title row, a blank line, the body, the buttons
 * (right-aligned) and the help line, each section separated by a blank line.
 * The frame never exceeds the caps or the screen; the body is cut first.
 */
export function renderDialog(d: Dialog, t: Theme, screenW: number, screenH: number): string[] | null {
  let maxW = d.maxWidth ?? 0;
  let maxH = d.maxHeight ?? 0;
  if (maxW <= 0) maxW = DialogMaxWidth;
  if (maxH <= 0) maxH = DialogMaxHeight;
  maxW = Math.min(maxW, screenW);
  maxH = Math.min(maxH, screenH);
  if (maxW < dialogHChrome + 1 || maxH < 3) return null;

  const labels = d.buttons ?? [];
  const body = d.body ?? [];
  const info = d.info ?? "";
  const help = d.help ?? "";
  const btns = buttons(t, labels, d.focused ?? 0);
  let inner = d.width ?? 0;
  if (inner <= 0) {
    inner = width(d.title) + 1 + 8;
    if (info !== "") inner += width(info) + 1;
    for (const l of body) inner = Math.max(inner, width(l));
    inner = Math.max(inner, width(btns), width(help));
  }
  inner = Math.min(inner, maxW - dialogHChrome);

  const rows: string[] = [titleRow(t, d.title, info, inner)];
  const tail: string[] = [];
  if (labels.length > 0) {
    const b = truncate(btns, inner);
    tail.push("", " ".repeat(Math.max(inner - width(b), 0)) + b);
  }
  if (help !== "") tail.push("", styledOr(truncate(help, inner), t.fgMostSubtle));
  const bodyRoom = maxH - 2 - rows.length - tail.length;
  if (body.length > 0 && bodyRoom >= 2) {
    rows.push("");
    for (const l of body.slice(0, Math.min(body.length, bodyRoom - 1))) rows.push(truncate(l, inner));
  }
  if (rows.length + tail.length + 2 <= maxH) rows.push(...tail);

  const bs = newStyle().foreground(d.destructive ? t.destructive : t.primary);
  const rb = rounded;
  const out: string[] = [bs.render(rb.topLeft + rb.top.repeat(inner + 2) + rb.topRight)];
  const side = bs.render(rb.left);
  for (const r of rows) out.push(side + " " + fit(r, inner) + " " + bs.render(rb.right));
  out.push(bs.render(rb.bottomLeft + rb.bottom.repeat(inner + 2) + rb.bottomRight));
  return out;
}

/**
 * overlay draws fg's lines over bg's at column x, row y (cells), keeping
 * bg's cells left and right of each fg line; bg is padded with blank lines
 * and spaces where it's short. No dimming. Lines are styled strings.
 */
export function overlay(bg: readonly string[], fg: readonly string[], x: number, y: number): string[] {
  const out = new Array<string>(Math.max(bg.length, y + fg.length)).fill("");
  bg.forEach((l, i) => {
    if (i < out.length) out[i] = l;
  });
  x = Math.max(x, 0);
  fg.forEach((line, i) => {
    const row = y + i;
    if (row < 0) return;
    const base = out[row]!;
    const fw = width(line);
    let left = ansiTruncate(base, x, "");
    const lw = width(left);
    if (lw < x) left += " ".repeat(x - lw); // short line, or a wide character split
    let right = "";
    if (width(base) > x + fw) {
      right = truncateLeft(base, x + fw, "");
      // a wide character straddling the edge comes back whole: blank its
      // covered half instead
      if (width(right) > width(base) - (x + fw)) right = " " + truncateLeft(base, x + fw + 1, "");
    }
    out[row] = left + ResetStyle + line + ResetStyle + right;
  });
  return out;
}

/** center is fg drawn centred over bg on a width × height screen. */
export function center(bg: readonly string[], fg: readonly string[], w: number, h: number): string[] {
  let fw = 0;
  for (const l of fg) fw = Math.max(fw, width(l));
  return overlay(bg, fg, Math.max(Math.trunc((w - fw) / 2), 0), Math.max(Math.trunc((h - fg.length) / 2), 0));
}
