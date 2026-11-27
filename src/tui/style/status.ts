import type { Binding } from "../key.ts";
import { tick, type Cmd, type Msg } from "../messages.ts";
import { strip } from "./ansi.ts";
import { joinHorizontal, newStyle, width as blockWidth, type Color, type Style } from "./style.ts";
import { fg, fit, GlyphBullet, truncate, width } from "./text.ts";
import type { Theme } from "./theme.ts";

/** HelpStyles are bubbles/help's styles. */
export interface HelpStyles {
  ellipsis: Style;
  shortKey: Style;
  shortDesc: Style;
  shortSeparator: Style;
  fullKey: Style;
  fullDesc: Style;
  fullSeparator: Style;
}

/**
 * helpStyles are bubbles/help's styles in t: keys FgMoreSubtle (Squid),
 * descriptions FgMostSubtle (Oyster), separators Separator (Char).
 */
export function helpStyles(t: Theme): HelpStyles {
  const key = newStyle().foreground(t.fgMoreSubtle);
  const desc = newStyle().foreground(t.fgMostSubtle);
  const sep = newStyle().foreground(t.separator);
  return { ellipsis: sep, shortKey: key, shortDesc: desc, shortSeparator: sep, fullKey: key, fullDesc: desc, fullSeparator: sep };
}

/** Help is bubbles/help's model: short and full views of bindings, cut to width with an ellipsis. */
export class Help {
  shortSeparator = " • ";
  fullSeparator = "    ";
  ellipsis = "…";
  constructor(
    public styles: HelpStyles,
    public width = 0,
  ) {}

  /** shortHelpView is the bindings on one line: `key desc • key desc`. */
  shortHelpView(bindings: readonly Binding[]): string {
    if (bindings.length === 0) return "";
    let b = "";
    let total = 0;
    const separator = this.styles.shortSeparator.inline(true).render(this.shortSeparator);
    for (const kb of bindings) {
      if (!kb.enabled()) continue;
      const sep = total > 0 ? separator : "";
      const str = sep + this.styles.shortKey.inline(true).render(kb.help.key) + " " + this.styles.shortDesc.inline(true).render(kb.help.desc);
      const w = blockWidth(str);
      const [tail, ok] = this.shouldAddItem(total, w);
      if (!ok) {
        b += tail;
        break;
      }
      total += w;
      b += str;
    }
    return b;
  }

  /** fullHelpView is one column per group of bindings. */
  fullHelpView(groups: readonly (readonly Binding[] | null)[]): string {
    if (groups.length === 0) return "";
    const out: string[] = [];
    let total = 0;
    const separator = this.styles.fullSeparator.inline(true).render(this.fullSeparator);
    for (const group of groups) {
      if (!group || !group.some((b) => b.enabled())) continue;
      const sep = total > 0 ? separator : "";
      const keys: string[] = [];
      const descs: string[] = [];
      for (const kb of group) {
        if (!kb.enabled()) continue;
        keys.push(kb.help.key);
        descs.push(kb.help.desc);
      }
      const col = joinHorizontal(sep, this.styles.fullKey.render(keys.join("\n")), " ", this.styles.fullDesc.render(descs.join("\n")));
      const w = blockWidth(col);
      const [tail, ok] = this.shouldAddItem(total, w);
      if (!ok) {
        if (tail !== "") out.push(tail);
        break;
      }
      total += w;
      out.push(col);
    }
    return joinHorizontal(...out);
  }

  private shouldAddItem(total: number, w: number): [string, boolean] {
    if (this.width > 0 && total + w > this.width) {
      const tail = " " + this.styles.ellipsis.inline(true).render(this.ellipsis);
      if (total + blockWidth(tail) < this.width) return [tail, false];
    }
    return ["", true];
  }
}

/** newHelp is a bubbles/help model styled in t, `•` between short items. */
export function newHelp(t: Theme, w: number): Help {
  const h = new Help(helpStyles(t), w);
  h.shortSeparator = " " + GlyphBullet + " ";
  return h;
}

/**
 * helpLine is the status bar's short help: `key desc • key desc`, cut with
 * `…` to width (one cell of left padding).
 */
export function helpLine(t: Theme, bindings: readonly Binding[], w: number): string {
  if (w <= 1) return "";
  return " " + newHelp(t, w - 1).shortHelpView(bindings);
}

/** fullHelp is help's full view: one column per group, as wide as width. */
export function fullHelp(t: Theme, groups: readonly (readonly Binding[])[], w: number): string {
  return newHelp(t, w).fullHelpView(groups);
}

/** ToastKind is a toast's kind: its colour, icon and title. */
export enum ToastKind {
  OK = 0, // ✓ Done, Success
  Warning = 1, // ! Warning, Warning
  Error = 2, // × Error, Destructive
  Hey = 3, // • Note, Info
}

/** ToastTTL is how long a toast's card shows, in ms. */
export const ToastTTL = 4000;

/** ToastExpiredMsg ends the toast with its ID (a later toast keeps showing). */
export class ToastExpiredMsg {
  constructor(readonly id: number) {}
}

let toastIDs = 0;

/**
 * Toasts is the screen's notification: at most one card shows; a new one
 * replaces it and restarts the clock.
 */
export class Toasts {
  private kind = ToastKind.OK;
  private msg = "";
  private id = 0;
  private shown = false;
  /** ttl overrides ToastTTL, in ms (tests). */
  ttl = 0;

  /** show puts message up; the command expires it after the TTL. */
  show(kind: ToastKind, message: string): Cmd {
    this.kind = kind;
    this.msg = message;
    this.shown = true;
    this.id = ++toastIDs;
    const id = this.id;
    return tick(this.ttl > 0 ? this.ttl : ToastTTL, () => new ToastExpiredMsg(id));
  }

  /**
   * update takes a ToastExpiredMsg for the showing toast down; it reports
   * whether msg was a toast message at all.
   */
  update(msg: Msg): boolean {
    if (!(msg instanceof ToastExpiredMsg)) return false;
    if (msg.id === this.id) this.shown = false;
    return true;
  }

  /** active says a toast is showing. */
  active(): boolean {
    return this.shown;
  }

  /** message is the showing toast's kind and text. */
  message(): [ToastKind, string] {
    return [this.kind, this.msg];
  }

  /** card is the showing toast as a floating card, null when none shows: see toastCard. */
  card(t: Theme, maxWidth: number): string[] | null {
    if (!this.shown) return null;
    return toastCard(t, this.kind, this.msg, maxWidth);
  }
}

/** toastMaxWidth is a card's widest text; toastLines its most message lines. */
export const toastMaxWidth = 48;
export const toastLines = 3;

/**
 * toastCard is a notification as a small card, the dialogs' language
 * (user decision): a rounded border in the
 * kind's colour, its icon and title bold in that colour, the message below
 * in FgBase, wrapped, at most toastLines lines. Nothing inside is filled, so
 * a transparent terminal stays transparent. Width fits the text, capped at
 * maxWidth (and toastMaxWidth).
 */
export function toastCard(t: Theme, kind: ToastKind, message: string, maxWidth: number): string[] | null {
  const [hue, title] = toastHue(t, kind);
  message = fields(message).join(" ");
  const inner = Math.min(Math.max(width(title), width(message)), toastMaxWidth, maxWidth - 4);
  if (inner < 4) return null;
  const head = newStyle().bold(true).foreground(hue).render(truncate(title, inner));
  const lines = [fit(head, inner)];
  const wrapped = wrap(message, inner);
  for (let i = 0; i < wrapped.length; i++) {
    if (i === toastLines) {
      lines[lines.length - 1] = fit(truncate(strip(lines[lines.length - 1]!) + " …", inner), inner);
      break;
    }
    lines.push(fit(fg(t.fgBase, wrapped[i]!), inner));
  }
  const border = newStyle().foreground(hue);
  const out = [border.render("╭" + "─".repeat(inner + 2) + "╮")];
  for (const l of lines) out.push(border.render("│") + " " + l + " " + border.render("│"));
  out.push(border.render("╰" + "─".repeat(inner + 2) + "╯"));
  return out;
}

/** fields is s split at runs of white space, empty fields dropped. */
function fields(str: string): string[] {
  return str.split(/[\s\u0085]+/u).filter((f) => f !== "");
}

/**
 * wrap is text broken into lines of at most width cells, at spaces; a word
 * longer than width is cut.
 */
function wrap(text: string, w: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of fields(text)) {
    if (line === "") line = truncate(word, w);
    else if (width(line) + 1 + width(word) <= w) line += " " + word;
    else {
      lines.push(line);
      line = truncate(word, w);
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

export function toastHue(t: Theme, kind: ToastKind): [Color, string] {
  switch (kind) {
    case ToastKind.Warning:
      return [t.warning, "! Warning"];
    case ToastKind.Error:
      return [t.destructive, "× Error"];
    case ToastKind.Hey:
      return [t.info, "• Note"];
  }
  return [t.success, "✓ Done"];
}
