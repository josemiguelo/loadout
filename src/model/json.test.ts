import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isJSONObject, JSONNumber, type JSONValue, jsonEqual, jsonString, parseJSON, prettyJSON, quote } from "./json.ts";

// The reader and writer beside the lock's golden test (model.test.ts): what
// JSON.parse would lose, and the wording for text that isn't JSON.

test("parsing keeps key order and numbers as written", () => {
  const v = parseJSON('{"b": 1, "2": [0.85, 1e5, -0, 3], "a": {"z": null, "1": true}}');
  expect(isJSONObject(v)).toBe(true);
  const obj = v as Map<string, JSONValue>;
  expect([...obj.keys()]).toEqual(["b", "2", "a"]);
  expect(jsonString(v)).toBe('{"b":1,"2":[0.85,1e5,-0,3],"a":{"z":null,"1":true}}');
  expect((obj.get("b") as JSONNumber).text).toBe("1");
});

test("a repeated key keeps its first place and its last value", () => {
  expect(jsonString(parseJSON('{"a": 1, "b": 2, "a": 3}'))).toBe('{"a":3,"b":2}');
});

test("strings decode escapes and pair surrogates", () => {
  const bs = "\\";
  expect(parseJSON(`"${bs}u00e9${bs}ud83d${bs}ude00${bs}/${bs}n"`)).toBe("\u00e9\u{1F600}/\n");
  expect(parseJSON(`"${bs}ud800x"`)).toBe("\ufffdx");
});

test("pretty JSON is two-space indented, one entry per line", () => {
  const v = parseJSON('{"a": [], "b": {}, "c": [1, {"d": "x"}]}');
  expect(prettyJSON(v)).toBe('{\n  "a": [],\n  "b": {},\n  "c": [\n    1,\n    {\n      "d": "x"\n    }\n  ]\n}');
});

test("only what JSON requires is escaped", () => {
  const bs = "\\";
  expect(quote('<&>\u2028"\\\t\b\n\r\f\x01\x1f')).toBe(
    '"<&>\u2028' + bs + '"' + bs + bs + bs + "t" + bs + "b" + bs + "n" + bs + "r" + bs + "f" + bs + "u0001" + bs + 'u001f"',
  );
});

test("JSON equality compares content, string-ness and keys in any order", () => {
  expect(jsonEqual(parseJSON('{"a": 1, "b": [true]}'), parseJSON('{"b": [true], "a": 1}'))).toBe(true);
  expect(jsonEqual(parseJSON('"1"'), parseJSON("1"))).toBe(false);
  expect(jsonEqual(1, new JSONNumber("1"))).toBe(true);
  expect(jsonEqual(parseJSON("[1]"), parseJSON("[1, 2]"))).toBe(false);
});

/**
 * jsonerrors.golden.json is what parseJSON says of each text, as [text,
 * message] pairs, "" when it parses: the messages a broken lock or state
 * file is refused with, pinned.
 */
const wantErrors = JSON.parse(readFileSync(import.meta.dir + "/jsonerrors.golden.json", "utf8")) as [string, string][];

test("text that isn't JSON is refused in the golden file's words", () => {
  for (const [text, want] of wantErrors) {
    let got = "";
    try {
      parseJSON(text);
    } catch (e) {
      got = (e as Error).message;
    }
    expect([text, got]).toEqual([text, want]);
  }
});
