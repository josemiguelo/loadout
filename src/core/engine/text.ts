import { isSpace, trimSpace } from "../../model/index.ts";

/** lines is s split on \n, \r\n or \r. */
export function lines(s: string): string[] {
  return s.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

/** ifBlank is s, or other when s is blank. */
export function ifBlank(s: string, other: string): string {
  return trimSpace(s) === "" ? other : s;
}

/** lastNonEmptyTrimmed is the last line of s with something on it, trimmed; undefined when none. */
export function lastNonEmptyTrimmed(s: string): string | undefined {
  const all = lines(s);
  for (let i = all.length - 1; i >= 0; i--) {
    const t = trimSpace(all[i]!);
    if (t !== "") return t;
  }
  return undefined;
}

/**
 * compileRegex is pattern, a manifest's (RE2 syntax) regex, as a RegExp, or
 * undefined when it doesn't compile. A leading flag group (`(?i)`, `(?s)`,
 * `(?m)`) becomes the RegExp's flags, and `\A`/`\z` become `^`/`$` (outside
 * multi-line mode): what manifests' regexes use of RE2 beyond the syntax both share.
 */
export function compileRegex(pattern: string): RegExp | undefined {
  let flags = "";
  const lead = /^\(\?([imsU]+)\)/.exec(pattern);
  if (lead !== null) {
    if (lead[1]!.includes("U")) return undefined;
    flags = [...new Set(lead[1]!)].join("");
    pattern = pattern.slice(lead[0].length);
  }
  if (!flags.includes("m")) pattern = pattern.replace(/(^|[^\\])((?:\\\\)*)\\A/g, "$1$2^").replace(/(^|[^\\])((?:\\\\)*)\\z/g, "$1$2$");
  try {
    return new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
}

/** group1 is pattern's first capture group in text, or undefined when it doesn't match. */
export function group1(pattern: string, text: string): string | undefined {
  const m = compileRegex(pattern)?.exec(text);
  if (m === null || m === undefined || m.length < 2) return undefined;
  // An unmatched optional group is the empty string.
  return m[1] ?? "";
}

/** shellQuote is s in single quotes, for sh. */
export function shellQuote(s: string): string {
  return "'" + s.replaceAll("'", `'\\''`) + "'";
}

/** fields is s split around runs of white space, without empty fields. */
export function fields(s: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const c of s) {
    if (isSpace(c.codePointAt(0)!)) {
      if (word !== "") out.push(word);
      word = "";
    } else {
      word += c;
    }
  }
  if (word !== "") out.push(word);
  return out;
}

/** indexSpace is the index of s's first whitespace code point (unicode.IsSpace), or -1. */
export function indexSpace(s: string): number {
  let i = 0;
  for (const c of s) {
    if (isSpace(c.codePointAt(0)!)) return i;
    i += c.length;
  }
  return -1;
}

/** take is s's first n characters. */
export function take(s: string, n: number): string {
  const r = Array.from(s);
  if (r.length <= n) return s;
  return r.slice(0, n).join("");
}

/** bullets is lines as "  - line", one per line. */
export function bullets(lines: readonly string[]): string {
  return lines.map((l) => "  - " + l).join("\n");
}
