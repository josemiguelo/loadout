// The styling the screen renders with: a Style's attributes in a fixed
// order (bold, underline, foreground, background, underline style) as one
// SGR sequence, reset with ESC[m; underlined text styles its spaces apart;
// horizontal padding in the background colour; multi-line blocks padded to
// their widest line. Also blend1D (a CIE L*a*b* blend) and joinHorizontal.
// The golden tests pin every byte.

import { ResetStyle, stringWidth } from "./ansi.ts";

/** Color is one 24-bit colour (theme.Rgb satisfies it). */
export interface Color {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** rgb is a Color. */
export function rgb(r: number, g: number, b: number): Color {
  return { r, g, b };
}

/** sgr is an attribute list as ansi.Style.Styled writes it around str; empty: str as is. */
function styled(attrs: string[], str: string): string {
  if (attrs.length === 0) return str;
  return `\x1b[${attrs.join(";")}m${str}${ResetStyle}`;
}

const fgAttr = (c: Color) => `38;2;${c.r};${c.g};${c.b}`;
const bgAttr = (c: Color) => `48;2;${c.r};${c.g};${c.b}`;

const isSpace = (ch: string) => /^\s$/u.test(ch) || ch === "\u0085";

/** Style is an immutable style: each setter returns a new one. */
export class Style {
  private constructor(
    private readonly fg: Color | undefined,
    private readonly bg: Color | undefined,
    private readonly isBold: boolean,
    private readonly isUnderline: boolean,
    private readonly padLeft: number,
    private readonly padRight: number,
    private readonly isInline: boolean,
    private readonly props: number,
  ) {}

  /** newStyle is a style without attributes: it renders text as is. */
  static new(): Style {
    return new Style(undefined, undefined, false, false, 0, 0, false, 0);
  }

  private with(o: Partial<{ fg: Color; bg: Color; bold: boolean; underline: boolean; padLeft: number; padRight: number; inline: boolean }>): Style {
    return new Style(
      o.fg ?? this.fg,
      o.bg ?? this.bg,
      o.bold ?? this.isBold,
      o.underline ?? this.isUnderline,
      o.padLeft ?? this.padLeft,
      o.padRight ?? this.padRight,
      o.inline ?? this.isInline,
      this.props + 1,
    );
  }

  foreground(c: Color): Style {
    return this.with({ fg: c });
  }
  background(c: Color): Style {
    return this.with({ bg: c });
  }
  bold(v = true): Style {
    return this.with({ bold: v });
  }
  underline(v = true): Style {
    return this.with({ underline: v });
  }
  inline(v = true): Style {
    return this.with({ inline: v });
  }
  /** padding is Padding(vertical, horizontal); only the horizontal part is drawn (the screen uses no vertical padding). */
  padding(_vertical: number, horizontal: number): Style {
    return this.with({ padLeft: horizontal, padRight: horizontal });
  }

  /** render is str styled (tabs become four spaces). */
  render(str: string): string {
    str = str.replaceAll("\t", "    ");
    if (this.props === 0) return str;
    const te: string[] = [];
    const teSpace: string[] = [];
    const teWhitespace: string[] = [];
    if (this.isBold) te.push("1");
    if (this.isUnderline) te.push("4");
    if (this.fg) {
      te.push(fgAttr(this.fg));
      if (this.isUnderline) teSpace.push(fgAttr(this.fg));
    }
    if (this.bg) {
      te.push(bgAttr(this.bg));
      teWhitespace.push(bgAttr(this.bg));
      if (this.isUnderline) teSpace.push(bgAttr(this.bg));
    }
    if (this.isUnderline) {
      te.push("4");
      teSpace.push("4");
    }
    str = str.replaceAll("\r\n", "\n");
    if (this.isInline) str = str.replaceAll("\n", "");

    str = str
      .split("\n")
      .map((line) => {
        if (!this.isUnderline) return styled(te, line);
        let b = "";
        for (const ch of line) b += isSpace(ch) ? styled(teSpace, ch) : styled(te, ch);
        return b;
      })
      .join("\n");

    if (!this.isInline) {
      if (this.padLeft > 0) {
        const sp = styled(teWhitespace, " ".repeat(this.padLeft));
        str = str
          .split("\n")
          .map((l) => sp + l)
          .join("\n");
      }
      if (this.padRight > 0) {
        const sp = styled(teWhitespace, " ".repeat(this.padRight));
        str = str
          .split("\n")
          .map((l) => l + sp)
          .join("\n");
      }
    }
    if (str.includes("\n")) {
      const [lines, widest] = getLines(str);
      str = lines
        .map((l) => {
          const short = widest - stringWidth(l);
          return short > 0 ? l + styled(teWhitespace, " ".repeat(short)) : l;
        })
        .join("\n");
    }
    return str;
  }
}

/** newStyle is an empty Style. */
export const newStyle = (): Style => Style.new();

/** getLines is str's lines and the widest one's width. */
export function getLines(str: string): [string[], number] {
  const lines = str.split("\n");
  let widest = 0;
  for (const l of lines) widest = Math.max(widest, stringWidth(l));
  return [lines, widest];
}

/** width is the widest line's terminal cell width. */
export function width(str: string): number {
  return getLines(str)[1];
}

/** joinHorizontal is blocks top-aligned: blocks side by side, each padded to its widest line, short ones with blank lines below. */
export function joinHorizontal(...strs: string[]): string {
  if (strs.length === 0) return "";
  if (strs.length === 1) return strs[0]!;
  const blocks: string[][] = [];
  const widths: number[] = [];
  let maxHeight = 0;
  for (const s of strs) {
    const [lines, w] = getLines(s);
    blocks.push(lines);
    widths.push(w);
    maxHeight = Math.max(maxHeight, lines.length);
  }
  for (const b of blocks) while (b.length < maxHeight) b.push("");
  const out: string[] = [];
  for (let i = 0; i < maxHeight; i++) {
    let line = "";
    blocks.forEach((b, j) => {
      line += b[i]! + " ".repeat(widths[j]! - stringWidth(b[i]!));
    });
    out.push(line);
  }
  return out.join("\n");
}

// ─── blend1D: an L*a*b* blend ───────────────────────────────────────────

const D65 = [0.95047, 1.0, 1.08883] as const;

const linearize = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const delinearize = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1.0 / 2.4) - 0.055);
// 216/24389 is (6/29)³ and 108/841 is 3·(6/29)², each written as one
// fraction so it is rounded once: the golden bytes depend on it.
const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((((t / 3.0) * 29.0) / 6.0) * 29.0) / 6.0 + 4.0 / 29.0);
const labFinv = (t: number) => (t > 6.0 / 29.0 ? t * t * t : (108 / 841) * (t - 4.0 / 29.0));

type Lab = [number, number, number];

function toLab(c: Color): Lab {
  // 8-bit → 16-bit → [0,1].
  const r = linearize((c.r * 257) / 65535);
  const g = linearize((c.g * 257) / 65535);
  const b = linearize((c.b * 257) / 65535);
  const x = 0.41239079926595948 * r + 0.35758433938387796 * g + 0.18048078840183429 * b;
  const y = 0.21263900587151036 * r + 0.71516867876775593 * g + 0.072192315360733715 * b;
  const z = 0.019330818715591851 * r + 0.11919477979462599 * g + 0.95053215224966058 * b;
  const fy = labF(y / D65[1]);
  return [1.16 * fy - 0.16, 5.0 * (labF(x / D65[0]) - fy), 2.0 * (fy - labF(z / D65[2]))];
}

function fromLab([l, a, bb]: Lab): Color {
  const l2 = (l + 0.16) / 1.16;
  const x = D65[0] * labFinv(l2 + a / 5.0);
  const y = D65[1] * labFinv(l2);
  const z = D65[2] * labFinv(l2 - bb / 2.0);
  const r = 3.2409699419045214 * x - 1.5373831775700935 * y - 0.49861076029300328 * z;
  const g = -0.96924363628087983 * x + 1.8759675015077207 * y + 0.041555057407175613 * z;
  const b = 0.055630079696993609 * x - 0.20397695888897657 * y + 1.0569715142428786 * z;
  // Clamped, then 16 bits, then the 8 bits a 24-bit SGR takes.
  const to8 = (v: number) => Math.floor(Math.floor(Math.max(0, Math.min(delinearize(v), 1)) * 65535.0 + 0.5) / 256);
  return { r: to8(r), g: to8(g), b: to8(b) };
}

/** blend1D is steps colours blending through stops in L*a*b*. */
export function blend1D(steps: number, ...stops: Color[]): Color[] {
  steps = Math.max(steps, 0);
  if (steps <= stops.length) return stops.slice(0, steps);
  if (stops.length === 1) return Array.from({ length: steps }, () => stops[0]!);
  const labs = stops.map(toLab);
  const segments = labs.length - 1;
  const size = Math.floor(steps / segments);
  const rem = steps % segments;
  const out: Color[] = [];
  for (let i = 0; i < segments; i++) {
    const from = labs[i]!;
    const to = labs[i + 1]!;
    const n = size + (i < rem ? 1 : 0);
    for (let j = 0; j < n; j++) {
      const t = n > 1 ? j / (n - 1) : 0;
      out.push(fromLab([from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1]), from[2] + t * (to[2] - from[2])]));
    }
  }
  return out;
}
