// Display widths, truncation and stripping of styled strings: escape-aware,
// counting a grapheme's terminal cells (a wide East Asian character or an
// emoji is two cells, a combining mark none).

/** ResetStyle is the SGR sequence that resets every attribute. */
export const ResetStyle = "\x1b[m";

type Token =
  | { kind: "esc"; text: string }
  | { kind: "ctl"; text: string }
  | { kind: "g"; text: string; width: number };

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** graphemeWidth is one grapheme cluster's width in cells. */
export function graphemeWidth(g: string): number {
  const c = g.charCodeAt(0);
  if (g.length === 1 && c >= 0x20 && c < 0x7f) return 1;
  return Bun.stringWidth(g, { countAnsiEscapeCodes: true, ambiguousIsNarrow: true });
}

/** escapeEnd is the index just past the escape sequence starting at i (s[i] is ESC). */
function escapeEnd(s: string, i: number): number {
  const next = s[i + 1];
  if (next === undefined) return i + 1;
  if (next === "[") {
    let j = i + 2;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      j++;
      if (c >= 0x40 && c <= 0x7e) break;
    }
    return j;
  }
  if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
    let j = i + 2;
    while (j < s.length) {
      if (s[j] === "\x07") return j + 1;
      if (s[j] === "\x1b" && s[j + 1] === "\\") return j + 2;
      j++;
    }
    return j;
  }
  return i + 2;
}

function isControl(c: number): boolean {
  return c < 0x20 || c === 0x7f;
}

function tokens(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      const end = escapeEnd(s, i);
      out.push({ kind: "esc", text: s.slice(i, end) });
      i = end;
      continue;
    }
    if (isControl(c)) {
      out.push({ kind: "ctl", text: s[i]! });
      i++;
      continue;
    }
    let j = i;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if (d === 0x1b || isControl(d)) break;
      j++;
    }
    for (const { segment } of segmenter.segment(s.slice(i, j))) {
      out.push({ kind: "g", text: segment, width: graphemeWidth(segment) });
    }
    i = j;
  }
  return out;
}

const csiSequence = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const asciiPrintable = /^[\x20-\x7e]*$/;
const simpleSymbols = /^(?:[\x20-\x7e\u00a0-\u02ff\u0370-\u1fff\u2010-\u2027\u2030-\u205f\u2070-\u2bff])*$/;

/** stringWidth is s's width in cells, escape sequences ignored. */
export function stringWidth(s: string): number {
  let w = 0;
  let plain = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c >= 0x7f) {
      plain = false;
      break;
    }
  }
  if (plain) return s.length;
  // Styled ASCII (most of a frame): its SGR sequences cost nothing, its
  // characters a cell each; no need to segment it.
  const bare = s.includes("\x1b") ? s.replace(csiSequence, "") : s;
  if (asciiPrintable.test(bare)) return bare.length;
  // Symbols short of CJK (box drawing, arrows, braille, the status glyphs),
  // with nothing that joins or combines: every code point is its own
  // grapheme, and Bun's width per code point is graphemeWidth's.
  if (simpleSymbols.test(bare)) return Bun.stringWidth(bare, { ambiguousIsNarrow: true });
  for (const t of tokens(s)) if (t.kind === "g") w += t.width;
  return w;
}

/** strip is s without escape sequences (control characters stay). */
export function strip(s: string): string {
  if (!s.includes("\x1b")) return s;
  // Only CSI sequences (a frame's SGR): a regex is enough.
  const bare = s.replace(csiSequence, "");
  if (!bare.includes("\x1b")) return bare;
  let out = "";
  for (const t of tokens(s)) if (t.kind !== "esc") out += t.text;
  return out;
}

/**
 * truncate cuts s to at most length cells, ending in tail when it cut;
 * escape sequences past the cut are kept, so styles still reset.
 */
export function truncate(s: string, length: number, tail: string): string {
  if (stringWidth(s) <= length) return s;
  length -= stringWidth(tail);
  if (length < 0) return "";
  let out = "";
  let cur = 0;
  let ignoring = false;
  for (const t of tokens(s)) {
    if (t.kind === "esc") {
      out += t.text;
      continue;
    }
    if (t.kind === "ctl") {
      if (!ignoring) out += t.text;
      continue;
    }
    if (ignoring) continue;
    cur += t.width;
    if (cur > length) {
      ignoring = true;
      out += tail;
      continue;
    }
    out += t.text;
  }
  return out;
}

/**
 * truncateLeft drops s's first n cells, starting with prefix when it cut;
 * escape sequences before the cut are kept. A wide grapheme straddling the
 * edge comes back whole.
 */
export function truncateLeft(s: string, n: number, prefix: string): string {
  if (n <= 0) return s;
  let out = "";
  let cur = 0;
  let ignoring = true;
  for (const t of tokens(s)) {
    if (!ignoring || t.kind === "esc") {
      out += t.text;
      continue;
    }
    if (t.kind === "ctl") continue;
    cur += t.width;
    if (cur > n) {
      ignoring = false;
      out += prefix + t.text;
    }
  }
  return out;
}
