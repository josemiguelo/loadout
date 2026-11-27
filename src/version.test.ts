import { expect, test } from "bun:test";
import { atLeast } from "./version.ts";

test("version comparison is numeric, not lexicographic", () => {
  const cases: [string, string, boolean][] = [
    ["0.10.0", "0.9.0", true],
    ["1.0", "0.99.99", true],
    ["0.2.0", "0.2", true],
    ["0.2.0", "0.2.1", false],
    ["0.2.0", "0.2.0", true],
  ];
  for (const [current, required, want] of cases) {
    expect([current, required, atLeast(current, required)]).toEqual([current, required, want]);
  }
});
