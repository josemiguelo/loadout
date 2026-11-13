import { expect, test } from "bun:test";
import { cleanPath, compareStrings, joinPath, trimSpace } from "./gostd.ts";

// Go's path.Clean cases (from its own tests) and the string rules the port keeps.

test("cleanPath is Go's path.Clean", () => {
  const cases: [string, string][] = [
    ["", "."],
    ["abc", "abc"],
    ["abc/def", "abc/def"],
    [".", "."],
    ["..", ".."],
    ["../..", "../.."],
    ["../../abc", "../../abc"],
    ["/abc", "/abc"],
    ["/", "/"],
    ["abc/", "abc"],
    ["abc/def/", "abc/def"],
    ["/abc/", "/abc"],
    ["abc//def//ghi", "abc/def/ghi"],
    ["//abc", "/abc"],
    ["abc/./def", "abc/def"],
    ["/./abc/def", "/abc/def"],
    ["abc/.", "abc"],
    ["abc/def/ghi/../jkl", "abc/def/jkl"],
    ["abc/def/../ghi/../jkl", "abc/jkl"],
    ["abc/def/..", "abc"],
    ["abc/def/../..", "."],
    ["/abc/def/../..", "/"],
    ["abc/def/../../..", ".."],
    ["/abc/def/../../..", "/"],
    ["abc/def/../../../ghi/jkl/../../../mno", "../../mno"],
    ["abc/./../def", "def"],
    ["abc//./../def", "def"],
    ["abc/../../././../def", "../../def"],
    ["a/b/../lib/helper.sh", "a/lib/helper.sh"],
  ];
  for (const [path, want] of cases) expect([path, cleanPath(path)]).toEqual([path, want]);
  expect(joinPath("a", "", "b/../c")).toBe("a/c");
  expect(joinPath("", "")).toBe("");
});

test("strings sort by code point and trim Go's whitespace", () => {
  expect(compareStrings("￿", "\u{10000}")).toBe(-1);
  expect(compareStrings("a", "ab")).toBe(-1);
  expect(trimSpace("\u0085 x ")).toBe("x");
  expect(trimSpace("﻿x")).toBe("﻿x");
});
