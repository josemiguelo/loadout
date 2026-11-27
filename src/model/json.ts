// JSON as loadout writes it, and read back without losing what JSON.parse
// loses: key order (JSON.parse moves integer-like keys first) and numbers as
// written ("0.85", "3", "1e5"). The lock, the state files and the chezmoi
// data are written through PrettyJSON; their bytes must not change.

/**
 * JSONNumber is a JSON number as its literal ("0.85", "3"): read back
 * and written out unchanged.
 */
export class JSONNumber {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

/**
 * JSONObject is a JSON object with its keys in order: the per-machine data tables, and the tree the lock
 * is written through.
 */
export type JSONObject = Map<string, JSONValue>;

/**
 * A JSON value is one of: null, boolean, string, JSONNumber (the literal as
 * written), an array, a JSONObject. The writer also takes a JS number, which
 * must be an integer (the lock's format, a state's exit code); a float is
 * floatNumber(f), so a `number` default of 1 reads "1.0", as locks and data
 * from earlier loadouts have it. ParseJSON never gives a JS number.
 */
export type JSONValue = null | boolean | string | number | JSONNumber | JSONValue[] | JSONObject;

/** isJSONObject says whether v is an object (a Map). */
export function isJSONObject(v: unknown): v is JSONObject {
  return v instanceof Map;
}

/** floatNumber is f written as loadout writes floats: always a fraction or an exponent, "0.85", "1.0", "1.0E7", "1.0E-4". */
export function floatNumber(f: number): JSONNumber {
  if (Number.isNaN(f)) return new JSONNumber("NaN");
  if (f === Infinity) return new JSONNumber("Infinity");
  if (f === -Infinity) return new JSONNumber("-Infinity");
  if (f === 0) return new JSONNumber(Object.is(f, -0) ? "-0.0" : "0.0");
  const a = Math.abs(f);
  if (a >= 1e-3 && a < 1e7) {
    // Shortest round-trip digits, fixed notation in this range.
    let s = String(f);
    if (!s.includes(".")) s += ".0";
    return new JSONNumber(s);
  }
  const [mantissa0, exp] = f.toExponential().split("e") as [string, string]; // "1.5e+7"
  const mantissa = mantissa0.includes(".") ? mantissa0 : mantissa0 + ".0";
  return new JSONNumber(mantissa + "E" + String(Number.parseInt(exp, 10)));
}

/**
 * primitive is a JSON primitive's content and whether it's a string;
 * undefined for arrays and objects.
 */
export function primitive(v: JSONValue | undefined): { content: string; isString: boolean } | undefined {
  if (v === null || v === undefined) return { content: "null", isString: false };
  switch (typeof v) {
    case "boolean":
      return { content: String(v), isString: false };
    case "string":
      return { content: v, isString: true };
    case "number":
      if (!Number.isInteger(v)) throw new Error(`not a JSON value: the non-integer number ${v} (use floatNumber)`);
      return { content: String(v), isString: false };
  }
  if (v instanceof JSONNumber) return { content: v.text, isString: false };
  return undefined;
}

/**
 * jsonEqual is the equality of JSON elements: primitives by content
 * and string-ness, arrays element by element, objects key by key in any order.
 */
export function jsonEqual(a: JSONValue | undefined, b: JSONValue | undefined): boolean {
  if (isJSONObject(a)) {
    if (!isJSONObject(b) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !jsonEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isJSONObject(b) || Array.isArray(b)) return false;
  const pa = primitive(a);
  const pb = primitive(b);
  return pa !== undefined && pb !== undefined && pa.content === pb.content && pa.isString === pb.isString;
}

/** jsonString is v written compact: `{"a":1,"b":["x"]}`. */
export function jsonString(v: JSONValue): string {
  const out: string[] = [];
  writeJSON(out, v, "", 0);
  return out.join("");
}

/**
 * prettyJSON is v pretty-printed with a two-space indent: one entry per
 * line, `"key": value`, `{}` and `[]` when empty. Only what JSON requires is escaped (never <, >, &, or U+2028).
 */
export function prettyJSON(v: JSONValue): string {
  const out: string[] = [];
  writeJSON(out, v, "  ", 0);
  return out.join("");
}

function writeJSON(out: string[], v: JSONValue, indent: string, level: number): void {
  const pretty = indent !== "";
  const newline = (level: number) => {
    if (pretty) out.push("\n" + indent.repeat(level));
  };
  if (isJSONObject(v)) {
    out.push("{");
    let first = true;
    for (const [k, e] of v) {
      if (!first) out.push(",");
      first = false;
      newline(level + 1);
      out.push(quote(k), pretty ? ": " : ":");
      writeJSON(out, e, indent, level + 1);
    }
    if (!first) newline(level);
    out.push("}");
    return;
  }
  if (Array.isArray(v)) {
    out.push("[");
    v.forEach((e, i) => {
      if (i > 0) out.push(",");
      newline(level + 1);
      writeJSON(out, e, indent, level + 1);
    });
    if (v.length > 0) newline(level);
    out.push("]");
    return;
  }
  const p = primitive(v);
  if (p === undefined) throw new Error(`not a JSON value: ${String(v)}`);
  out.push(p.isString ? quote(p.content) : p.content);
}

const hexDigits = "0123456789abcdef";

/**
 * quote is s as a JSON string: only control characters,
 * '"' and '\\' are escaped.
 */
export function quote(s: string): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c !== 0x22 && c !== 0x5c) continue;
    out += s.slice(start, i);
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x0c:
        out += "\\f";
        break;
      default:
        out += "\\u00" + hexDigits[c >> 4] + hexDigits[c & 0xf];
    }
    start = i + 1;
  }
  return out + s.slice(start) + '"';
}

// ─── reading ────────────────────────────────────────────────────────────

/**
 * JSONSyntaxError is text that isn't JSON, worded as jsonerrors.golden.json
 * pins it: the lock's "is not valid JSON (…)" message carries it.
 */
export class JSONSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JSONSyntaxError";
  }
}

/** quoteChar is a character in a message, quoted: 'x', '\n', '\''. */
function quoteChar(c: string): string {
  if (c === "'") return "'\\''";
  if (c === '"') return "'\"'";
  const cp = c.codePointAt(0)!;
  const named: Record<number, string> = { 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r", 92: "\\\\" };
  if (named[cp] !== undefined) return "'" + named[cp] + "'";
  if (cp < 0x20 || cp === 0x7f) return "'\\x" + cp.toString(16).padStart(2, "0") + "'";
  return "'" + c + "'";
}

/**
 * parseJSON reads one JSON value, keys in order and numbers as written. A
 * repeated key keeps its first place and its last value. Throws a
 * JSONSyntaxError ("unexpected EOF", "invalid
 * character 'x' looking for beginning of value").
 */
export function parseJSON(text: string): JSONValue {
  const p = new Parser(text);
  const v = p.value();
  p.skipSpace();
  if (p.i < text.length) {
    const c = text[p.i]!;
    // The offset is past the next token: a container's opening delimiter,
    // or a whole scalar.
    if (c === "{" || c === "[") throw new JSONSyntaxError(`unexpected trailing content at offset ${p.i + 1}`);
    if (startsValue(c)) {
      p.value();
      throw new JSONSyntaxError(`unexpected trailing content at offset ${p.i}`);
    }
    throw p.invalid("looking for beginning of value");
  }
  return v;
}

/** startsValue says whether c can begin a JSON value. */
function startsValue(c: string): boolean {
  return "{[\"-0123456789tfn".includes(c);
}

/** The two words for running out: inside a token or before a value, and between a container's tokens. */
const unexpectedEOF = "unexpected EOF";
const endOfInput = "unexpected end of JSON input";

class Parser {
  i = 0;
  constructor(readonly text: string) {}

  skipSpace(): void {
    const t = this.text;
    while (this.i < t.length) {
      const c = t[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else break;
    }
  }

  /** peek is the next non-space character, or throws eofMessage at the end. */
  peek(eofMessage: string): string {
    this.skipSpace();
    if (this.i >= this.text.length) throw new JSONSyntaxError(eofMessage);
    return this.text[this.i]!;
  }

  invalid(context: string, at = this.i): JSONSyntaxError {
    const c = String.fromCodePoint(this.text.codePointAt(at)!);
    return new JSONSyntaxError(`invalid character ${quoteChar(c)} ${context}`);
  }

  /** value reads one value at the current position. */
  value(): JSONValue {
    const c = this.peek(unexpectedEOF);
    switch (c) {
      case "{":
        return this.object();
      case "[":
        return this.array();
      case '"':
        return this.string();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
    }
    if (c === "-" || (c >= "0" && c <= "9")) return this.number();
    throw this.invalid("looking for beginning of value");
  }

  object(): JSONObject {
    const obj: JSONObject = new Map();
    this.i++; // {
    let afterComma = -1;
    for (;;) {
      // A key, or (first) the end.
      const c = this.peek(endOfInput);
      if (c === "}" || c === "]") {
        if (afterComma >= 0) throw this.invalid("looking for beginning of value", afterComma);
        if (c === "]") throw this.invalid("looking for beginning of value");
        this.i++;
        return obj;
      }
      if (c !== '"') {
        if (c !== "," && startsValue(c)) throw new JSONSyntaxError("object member name must be a string");
        throw this.invalid("looking for beginning of value");
      }
      const key = this.string();
      if (this.peek(unexpectedEOF) !== ":") throw this.invalid("after object key");
      this.i++;
      const v = this.peek(unexpectedEOF);
      if (v === "}") throw new JSONSyntaxError("missing value after object key");
      if (v === "]") throw this.invalid("after object key:value pair");
      obj.set(key, this.value());
      const next = this.peek(endOfInput);
      if (next === "}") {
        this.i++;
        return obj;
      }
      if (next !== ",") throw this.invalid("after object key:value pair");
      afterComma = this.i;
      this.i++;
    }
  }

  array(): JSONValue[] {
    const arr: JSONValue[] = [];
    this.i++; // [
    let afterComma = -1;
    for (;;) {
      const c = this.peek(endOfInput);
      if (c === "]" || c === "}") {
        if (afterComma >= 0) throw this.invalid("looking for beginning of value", afterComma);
        if (c === "}") throw this.invalid("looking for beginning of value");
        this.i++;
        return arr;
      }
      arr.push(this.value());
      const next = this.peek(endOfInput);
      if (next === "]") {
        this.i++;
        return arr;
      }
      if (next !== ",") throw this.invalid("after array element");
      afterComma = this.i;
      this.i++;
    }
  }

  literal<T>(word: string, value: T): T {
    for (let k = 0; k < word.length; k++) {
      if (this.i >= this.text.length) throw new JSONSyntaxError(unexpectedEOF);
      if (this.text[this.i] !== word[k]) throw this.invalid(`in literal ${word} (expecting ${quoteChar(word[k]!)})`);
      this.i++;
    }
    return value;
  }

  number(): JSONNumber {
    const t = this.text;
    const start = this.i;
    const digit = () => this.i < t.length && t[this.i]! >= "0" && t[this.i]! <= "9";
    const need = () => {
      if (this.i >= t.length) throw new JSONSyntaxError(unexpectedEOF);
      if (!digit()) throw this.invalid("in numeric literal");
    };
    if (t[this.i] === "-") {
      this.i++;
      need();
    }
    if (t[this.i] === "0") this.i++;
    else while (digit()) this.i++;
    if (t[this.i] === ".") {
      this.i++;
      need();
      while (digit()) this.i++;
    }
    if (t[this.i] === "e" || t[this.i] === "E") {
      this.i++;
      if (t[this.i] === "+" || t[this.i] === "-") this.i++;
      need();
      while (digit()) this.i++;
    }
    return new JSONNumber(t.slice(start, this.i));
  }

  string(): string {
    const t = this.text;
    this.i++; // "
    let out = "";
    let start = this.i;
    const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    for (;;) {
      if (this.i >= t.length) throw new JSONSyntaxError(unexpectedEOF);
      const c = t.charCodeAt(this.i);
      if (c === 0x22) {
        out += t.slice(start, this.i);
        this.i++;
        return out;
      }
      if (c < 0x20) throw this.invalid("in string");
      if (c !== 0x5c) {
        this.i++;
        continue;
      }
      out += t.slice(start, this.i);
      const escape = this.i;
      this.i++;
      if (this.i >= t.length) throw new JSONSyntaxError(unexpectedEOF);
      const e = t[this.i]!;
      if (simple[e] !== undefined) {
        out += simple[e];
        this.i++;
      } else if (e === "u") {
        this.i++;
        let unit = this.hex4(escape);
        if (unit >= 0xd800 && unit < 0xdc00) {
          // A high surrogate pairs with a following \u low one; alone it's U+FFFD.
          if (t.startsWith("\\u", this.i)) {
            const save = this.i;
            this.i += 2;
            const low = this.hex4(save);
            if (low >= 0xdc00 && low < 0xe000) {
              out += String.fromCharCode(unit, low);
              start = this.i;
              continue;
            }
            this.i = save;
          }
          unit = 0xfffd;
        } else if (unit >= 0xdc00 && unit < 0xe000) {
          unit = 0xfffd;
        }
        out += String.fromCharCode(unit);
      } else {
        throw new JSONSyntaxError(`invalid escape sequence \`${t.slice(escape, this.i + 1)}\` in string`);
      }
      start = this.i;
    }
  }

  /** hex4 reads \u's four hex digits; escape is where its backslash is. */
  hex4(escape: number): number {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      if (this.i >= this.text.length) throw new JSONSyntaxError(unexpectedEOF);
      const d = Number.parseInt(this.text[this.i]!, 16);
      if (Number.isNaN(d)) throw new JSONSyntaxError(`invalid escape sequence \`${this.text.slice(escape, escape + 6)}\` in string`);
      n = n * 16 + d;
      this.i++;
    }
    return n;
  }
}
