import { expect, test } from "bun:test";
import { Decoder, keyString, MouseButton, MouseClickMsg, MouseWheelMsg } from "./input.ts";
import { KeyPressMsg, PasteMsg } from "./messages.ts";

const keys = (data: string) => new Decoder().feed(data).map((m) => (m instanceof KeyPressMsg ? keyString(m) : m));

test("control bytes are ctrl+keys, and ESC alone in its read is esc", () => {
  expect(keys("\x1d\x10\x07\x03\x04\x15")).toEqual(["ctrl+]", "ctrl+p", "ctrl+g", "ctrl+c", "ctrl+d", "ctrl+u"]);
  expect(keys("\r\t\x7f\x1b")).toEqual(["enter", "tab", "backspace", "esc"]);
  expect(keys(" q")).toEqual(["space", "q"]);
});

test("ESC before a key in the same read is alt+key", () => {
  expect(keys("\x1bq")).toEqual(["alt+q"]);
  expect(keys("\x1b\x1b")).toEqual(["alt+esc"]);
});

test("capitals type themselves and match as shift+letter's text", () => {
  const [k] = new Decoder().feed("G") as KeyPressMsg[];
  expect([k!.code, k!.text, keyString(k!)]).toEqual([0x67, "G", "G"]);
});

test("CSI and SS3 sequences are the special keys, with xterm's modifiers", () => {
  expect(keys("\x1b[A\x1bOB\x1b[1;5C\x1b[Z\x1b[5~\x1b[6~\x1b[H\x1b[4~\x1bOP")).toEqual(["up", "down", "ctrl+right", "shift+tab", "pgup", "pgdown", "home", "end", "f1"]);
});

test("a bracketed paste is one message, even across reads", () => {
  const d = new Decoder();
  expect(d.feed("\x1b[200~hel")).toEqual([]);
  expect(d.feed("lo\x1b[201~x").map((m) => (m instanceof PasteMsg ? m.content : keyString(m as KeyPressMsg)))).toEqual(["hello", "x"]);
});

test("SGR mouse presses and the wheel; releases and motion say nothing", () => {
  const msgs = new Decoder().feed("\x1b[<0;6;3M\x1b[<0;6;3m\x1b[<64;1;1M\x1b[<65;1;1M\x1b[<32;2;2M");
  expect(msgs.length).toBe(3);
  expect((msgs[0] as MouseClickMsg).mouse).toEqual({ x: 5, y: 2, button: MouseButton.Left });
  expect((msgs[1] as MouseWheelMsg).mouse.button).toBe(MouseButton.WheelUp);
  expect((msgs[2] as MouseWheelMsg).mouse.button).toBe(MouseButton.WheelDown);
});

test("a late terminal reply is skipped, not typed", () => {
  expect(keys("\x1b]11;rgb:0000/0000/0000\x1b\\q")).toEqual(["q"]);
});
