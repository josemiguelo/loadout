// The terminal's input as Bubble Tea v2 reads it: raw bytes from the tty
// turned into key presses, pastes and mouse events. Ink's own input loses
// what the screen relies on (ctrl+], alt+key, bracketed paste as one
// message, SGR mouse), so the screen reads the tty itself and Ink only
// draws.
//
// Legacy encodings, as ultraviolet decodes them: a control byte is ctrl+key
// (0x1d is ctrl+]), ESC before a key is alt+key (ESC alone in its read is
// esc), CSI and SS3 sequences are the special keys with xterm's modifier
// parameter, CSI u is a kitty key, `CSI 200~ … CSI 201~` a paste and
// `CSI < b;x;y M/m` an SGR mouse event.

import {
  KeyBackspace,
  KeyDelete,
  KeyDown,
  KeyEnd,
  KeyEnter,
  KeyEscape,
  KeyF1,
  KeyHome,
  KeyInsert,
  KeyLeft,
  KeyPgDown,
  KeyPgUp,
  KeyPressMsg,
  KeyRight,
  KeySpace,
  KeyTab,
  KeyUp,
  ModAlt,
  ModCtrl,
  ModMeta,
  ModShift,
  type Msg,
  PasteMsg,
} from "./tea.ts";

/** MouseButton is a mouse event's button, as Bubble Tea numbers them. */
export enum MouseButton {
  None = 0,
  Left = 1,
  Middle = 2,
  Right = 3,
  WheelUp = 4,
  WheelDown = 5,
  WheelLeft = 6,
  WheelRight = 7,
}

/** Mouse is where a mouse event happened (cells, from 0) and with what. */
export interface Mouse {
  x: number;
  y: number;
  button: MouseButton;
}

/** MouseClickMsg is a mouse button pressed. */
export class MouseClickMsg {
  constructor(readonly mouse: Mouse) {}
}

/** MouseWheelMsg is the wheel turned. */
export class MouseWheelMsg {
  constructor(readonly mouse: Mouse) {}
}

const keyNames = new Map<number, string>([
  [KeyEnter, "enter"],
  [KeyTab, "tab"],
  [KeyBackspace, "backspace"],
  [KeyEscape, "esc"],
  [KeySpace, "space"],
  [KeyUp, "up"],
  [KeyDown, "down"],
  [KeyRight, "right"],
  [KeyLeft, "left"],
  [KeyInsert, "insert"],
  [KeyDelete, "delete"],
  [KeyPgUp, "pgup"],
  [KeyPgDown, "pgdown"],
  [KeyHome, "home"],
  [KeyEnd, "end"],
]);
for (let i = 0; i < 12; i++) keyNames.set(KeyF1 + i, "f" + (i + 1));

/**
 * keyString is a key press as Bubble Tea's Key.String says it, the string
 * key bindings match: its text when it types something other than a space
 * ("K", "q"), else its keystroke ("ctrl+]", "shift+tab", "alt+x", "space").
 */
export function keyString(k: KeyPressMsg): string {
  if (k.text !== "" && k.text !== " ") return k.text;
  let s = "";
  if (k.mod & ModCtrl) s += "ctrl+";
  if (k.mod & ModAlt) s += "alt+";
  if (k.mod & ModShift) s += "shift+";
  if (k.mod & ModMeta) s += "meta+";
  const name = keyNames.get(k.code);
  return s + (name ?? String.fromCodePoint(k.code));
}

const tildeKeys = new Map<number, number>([
  [1, KeyHome],
  [2, KeyInsert],
  [3, KeyDelete],
  [4, KeyEnd],
  [5, KeyPgUp],
  [6, KeyPgDown],
  [7, KeyHome],
  [8, KeyEnd],
  [11, KeyF1],
  [12, KeyF1 + 1],
  [13, KeyF1 + 2],
  [14, KeyF1 + 3],
  [15, KeyF1 + 4],
  [17, KeyF1 + 5],
  [18, KeyF1 + 6],
  [19, KeyF1 + 7],
  [20, KeyF1 + 8],
  [21, KeyF1 + 9],
  [23, KeyF1 + 10],
  [24, KeyF1 + 11],
]);

const letterKeys = new Map<string, number>([
  ["A", KeyUp],
  ["B", KeyDown],
  ["C", KeyRight],
  ["D", KeyLeft],
  ["H", KeyHome],
  ["F", KeyEnd],
  ["P", KeyF1],
  ["Q", KeyF1 + 1],
  ["R", KeyF1 + 2],
  ["S", KeyF1 + 3],
]);

/** modOf is xterm's modifier parameter (1 + bits) as Bubble Tea's modifiers. */
function modOf(param: number): number {
  if (!(param > 1)) return 0;
  const bits = param - 1;
  let mod = 0;
  if (bits & 1) mod |= ModShift;
  if (bits & 2) mod |= ModAlt;
  if (bits & 4) mod |= ModCtrl;
  if (bits & 8) mod |= ModMeta;
  return mod;
}

/** printable is one typed character as a key press (an upper-case letter is shift+its letter). */
function printable(ch: string, mod = 0): KeyPressMsg {
  const cp = ch.codePointAt(0)!;
  if (mod & (ModAlt | ModCtrl)) return new KeyPressMsg(lower(cp), "", mod | (isUpper(cp) ? ModShift : 0));
  if (isUpper(cp)) return new KeyPressMsg(lower(cp), ch, mod | ModShift);
  return new KeyPressMsg(cp, ch, mod);
}

function isUpper(cp: number): boolean {
  return cp >= 0x41 && cp <= 0x5a;
}

function lower(cp: number): number {
  return isUpper(cp) ? cp + 0x20 : cp;
}

/** control is a C0 control byte (or DEL) as a key press. */
function control(c: number): KeyPressMsg {
  switch (c) {
    case 0x00:
      return new KeyPressMsg(KeySpace, "", ModCtrl);
    case 0x09:
      return new KeyPressMsg(KeyTab);
    case 0x0d:
      return new KeyPressMsg(KeyEnter);
    case 0x1b:
      return new KeyPressMsg(KeyEscape);
    case 0x7f:
      return new KeyPressMsg(KeyBackspace);
  }
  if (c >= 0x01 && c <= 0x1a) return new KeyPressMsg(0x60 + c, "", ModCtrl); // ctrl+a … ctrl+z (ctrl+h, ctrl+j included)
  return new KeyPressMsg(0x40 + c, "", ModCtrl); // 0x1c–0x1f: ctrl+\ ctrl+] ctrl+^ ctrl+_
}

/**
 * Decoder turns the tty's bytes into messages. A sequence cut by the end of
 * a read waits for the next one; flush gives up on it (a lone ESC is esc).
 */
export class Decoder {
  private buf = "";
  private paste: string | undefined;

  /** pending says a sequence (or a paste) is cut and waits for more input. */
  pending(): boolean {
    return this.buf !== "" || this.paste !== undefined;
  }

  /** feed is data's messages, in order. */
  feed(data: string): Msg[] {
    this.buf += data;
    return this.drain(false);
  }

  /** flush is what is left, as keys: an incomplete sequence is taken as typed. */
  flush(): Msg[] {
    if (this.paste !== undefined) {
      const content = this.paste + this.buf;
      this.paste = undefined;
      this.buf = "";
      return [new PasteMsg(content)];
    }
    return this.drain(true);
  }

  private drain(final: boolean): Msg[] {
    const out: Msg[] = [];
    let s = this.buf;
    let i = 0;
    while (i < s.length) {
      if (this.paste !== undefined) {
        const end = s.indexOf("\x1b[201~", i);
        if (end < 0) {
          // Keep a possible start of the end marker for the next read.
          const keep = Math.max(i, s.length - 5);
          this.paste += s.slice(i, keep);
          i = keep;
          break;
        }
        out.push(new PasteMsg(this.paste + s.slice(i, end)));
        this.paste = undefined;
        i = end + 6;
        continue;
      }
      const [msg, n] = this.next(s, i, final);
      if (n === 0) break; // cut: wait for more
      if (msg !== undefined) out.push(msg);
      i += n;
    }
    this.buf = s.slice(i);
    if (final && this.buf !== "") {
      s = this.buf;
      this.buf = "";
      for (const ch of s) out.push(ch.charCodeAt(0) < 0x20 || ch === "\x7f" ? control(ch.charCodeAt(0)) : printable(ch));
    }
    return out;
  }

  /** next is the message at s[i] and how many code units it took (0: cut, wait for more). */
  private next(s: string, i: number, final: boolean): [Msg | undefined, number] {
    const c = s.charCodeAt(i);
    if (c !== 0x1b) {
      if (c < 0x20 || c === 0x7f) return [control(c), 1];
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      return [printable(ch), ch.length];
    }
    // ESC: alone in the read, it's esc.
    if (i + 1 >= s.length) return [new KeyPressMsg(KeyEscape), 1];
    const n = s[i + 1]!;
    if (n === "[") return this.csi(s, i, final);
    if (n === "O") {
      if (i + 2 >= s.length) return final ? [printable("O", ModAlt), 2] : [undefined, 0];
      const k = letterKeys.get(s[i + 2]!);
      if (k !== undefined) return [new KeyPressMsg(k), 3];
      return [printable("O", ModAlt), 2];
    }
    if (n === "]" || n === "P" || n === "_" || n === "^" || n === "X") {
      // A string sequence (a late OSC reply): skipped to BEL or ST.
      for (let j = i + 2; j < s.length; j++) {
        if (s[j] === "\x07") return [undefined, j + 1 - i];
        if (s[j] === "\x1b" && s[j + 1] === "\\") return [undefined, j + 2 - i];
      }
      return final ? [undefined, s.length - i] : [undefined, 0];
    }
    // ESC before a key: alt+that key.
    const [inner, len] = this.next(s, i + 1, true);
    if (inner instanceof KeyPressMsg) {
      if (inner.code === KeyEscape && inner.mod === 0) return [new KeyPressMsg(KeyEscape, "", ModAlt), 1 + len];
      const cp = inner.code;
      return [new KeyPressMsg(cp, "", inner.mod | ModAlt), 1 + len];
    }
    return [inner, 1 + len];
  }

  private csi(s: string, i: number, final: boolean): [Msg | undefined, number] {
    let j = i + 2;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) break;
      j++;
    }
    if (j >= s.length) return final ? [printable("[", ModAlt), 2] : [undefined, 0];
    const final_ = s[j]!;
    const body = s.slice(i + 2, j);
    const len = j + 1 - i;
    if (body.startsWith("<") && (final_ === "M" || final_ === "m")) return [mouse(body.slice(1), final_ === "M"), len];
    const params = body.split(";").map((p) => Number.parseInt(p.split(":")[0]!, 10));
    if (final_ === "~") {
      if (params[0] === 200) {
        this.paste = "";
        return [undefined, len];
      }
      const k = tildeKeys.get(params[0]!);
      if (k === undefined) return [undefined, len];
      return [new KeyPressMsg(k, "", modOf(params[1]!)), len];
    }
    if (final_ === "Z") return [new KeyPressMsg(KeyTab, "", ModShift | modOf(params[1]!)), len];
    if (final_ === "u") {
      // kitty: CSI code ; mods u
      const code = params[0]!;
      const mod = modOf(params[1]!);
      if (!(code > 0)) return [undefined, len];
      const special = new Map<number, number>([
        [13, KeyEnter],
        [9, KeyTab],
        [27, KeyEscape],
        [127, KeyBackspace],
      ]).get(code);
      if (special !== undefined) return [new KeyPressMsg(special, "", mod), len];
      if ((mod & ~ModShift) === 0 && code >= 0x20) {
        const ch = String.fromCodePoint(code);
        return [new KeyPressMsg(code, mod & ModShift ? ch.toUpperCase() : ch, mod), len];
      }
      return [new KeyPressMsg(code, "", mod), len];
    }
    const k = letterKeys.get(final_);
    if (k !== undefined && /^[\d;]*$/.test(body)) return [new KeyPressMsg(k, "", modOf(params[1]!)), len];
    // Focus reports, replies and keys the screen has no use for.
    return [undefined, len];
  }
}

/** mouse is an SGR mouse report's message (a press or the wheel; releases and motion: none). */
function mouse(body: string, press: boolean): Msg | undefined {
  const [b, x, y] = body.split(";").map((p) => Number.parseInt(p, 10));
  if (b === undefined || x === undefined || y === undefined || !press) return undefined;
  if (b & 32) return undefined; // motion
  const at = { x: x - 1, y: y - 1 };
  if (b & 64) {
    const wheel = [MouseButton.WheelUp, MouseButton.WheelDown, MouseButton.WheelLeft, MouseButton.WheelRight][b & 3]!;
    return new MouseWheelMsg({ ...at, button: wheel });
  }
  const button = [MouseButton.Left, MouseButton.Middle, MouseButton.Right, MouseButton.None][b & 3]!;
  return new MouseClickMsg({ ...at, button });
}
