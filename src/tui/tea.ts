// The slice of Bubble Tea's model the screen's parts keep (style's Busy and
// Toasts, term's Model): a message is any value, a command is a function
// that resolves to the next message, run by whoever drives the screen, and
// fed back to the parts' update methods. It keeps the shape of the Go
// packages the home screen was ported from, so its reducers read as they did.

/** Msg is anything a command delivers. */
export type Msg = unknown;

/** Cmd produces one message, later; null is no command. */
export type Cmd = () => Promise<Msg>;

/** tick is a command that delivers fn's message after ms milliseconds, once. */
export function tick(ms: number, fn: (t: Date) => Msg): Cmd {
  return () => new Promise((resolve) => setTimeout(() => resolve(fn(new Date())), ms));
}

// ─── keys ───────────────────────────────────────────────────────────────

/** Key modifiers, as Bubble Tea v2 (ultraviolet) numbers them. */
export const ModShift = 1 << 0;
export const ModAlt = 1 << 1;
export const ModCtrl = 1 << 2;
export const ModMeta = 1 << 3;

/** keyExtended is the first code past Unicode: special keys. */
const keyExtended = 0x10ffff + 1;

/** Key codes: a printable key's code is its code point. */
export const KeyBackspace = 0x7f;
export const KeyTab = 0x09;
export const KeyEnter = 0x0d;
export const KeyEscape = 0x1b;
export const KeySpace = 0x20;
export const KeyUp = keyExtended + 1;
export const KeyDown = keyExtended + 2;
export const KeyRight = keyExtended + 3;
export const KeyLeft = keyExtended + 4;
export const KeyBegin = keyExtended + 5;
export const KeyFind = keyExtended + 6;
export const KeyInsert = keyExtended + 7;
export const KeyDelete = keyExtended + 8;
export const KeySelect = keyExtended + 9;
export const KeyPgUp = keyExtended + 10;
export const KeyPgDown = keyExtended + 11;
export const KeyHome = keyExtended + 12;
export const KeyEnd = keyExtended + 13;
export const KeyKpEnter = keyExtended + 14;
export const KeyKpEqual = keyExtended + 15;
export const KeyKpMultiply = keyExtended + 16;
export const KeyKpPlus = keyExtended + 17;
export const KeyKpComma = keyExtended + 18;
export const KeyKpMinus = keyExtended + 19;
export const KeyKpDecimal = keyExtended + 20;
export const KeyKpDivide = keyExtended + 21;
/** KeyKp0 … Kp9 are KeyKp0 + 0 … 9. */
export const KeyKp0 = keyExtended + 22;
/** KeyF1 … F12 are KeyF1 + 0 … 11 (the codes ultraviolet gives them). */
export const KeyF1 = keyExtended + 44;

/** KeyPressMsg is a key press: its code, the text it types (if any) and its modifiers. */
export class KeyPressMsg {
  constructor(
    readonly code: number,
    readonly text: string = "",
    readonly mod: number = 0,
  ) {}
}

/** PasteMsg is a bracketed paste's content. */
export class PasteMsg {
  constructor(readonly content: string) {}
}
