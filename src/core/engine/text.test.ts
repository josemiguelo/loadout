import { expect, test } from "bun:test";
import { fields, compileRegex, group1, indexSpace, lastNonEmptyTrimmed, lines } from "./text.ts";
import { forEach } from "./versionchecker.ts";

test("manifest regexes compile with their flags, \\A and \\z", () => {
  expect(group1("(?i)version ([0-9.]+)", "VERSION 1.2")).toBe("1.2");
  expect(group1(String.raw`\A([0-9.]+)\z`, "1.2")).toBe("1.2");
  expect(group1(String.raw`\A([0-9.]+)\z`, "x 1.2")).toBeUndefined();
  expect(group1("(a)?b", "b")).toBe(""); // an unmatched group is ""
  expect(group1("([", "x")).toBeUndefined(); // doesn't compile: no answer
  expect(compileRegex("(?s)a.b")?.test("a\nb")).toBe(true);
});

test("lines, fields and spaces split on every line ending and white space", () => {
  expect(lines("a\r\nb\rc\n")).toEqual(["a", "b", "c", ""]);
  expect(lastNonEmptyTrimmed("x\n  y  \n\n")).toBe("y");
  expect(lastNonEmptyTrimmed(" \n")).toBeUndefined();
  expect(fields("  a b\tc  ")).toEqual(["a", "b", "c"]);
  expect(indexSpace("ab c")).toBe(2);
  expect(indexSpace("abc")).toBe(-1);
});

test("forEach keeps order, bounds concurrency and waits for every call before failing", async () => {
  let running = 0;
  let most = 0;
  const finished: number[] = [];
  const out = await forEach(20, 3, async (i) => {
    running++;
    most = Math.max(most, running);
    await Bun.sleep(1);
    running--;
    return i * 2;
  });
  expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
  expect(most).toBe(3);

  const failing = forEach(4, 0, async (i) => {
    await Bun.sleep(i);
    finished.push(i);
    if (i === 1 || i === 2) throw new Error("call " + i);
    return i;
  });
  await expect(failing).rejects.toThrow("call 1");
  expect(finished.length).toBe(4);
});
