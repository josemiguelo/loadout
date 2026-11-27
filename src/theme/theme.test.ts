import { expect, test } from "bun:test";
import { isRefusal } from "../model/refusal.ts";
import { Dark, detectDarkTerminal, forcedDark, ThemeException } from "./theme.ts";

test("OSC luma wins over COLORFGBG", () => {
  expect(detectDarkTerminal(0.08, "")).toBe(true); // a dark background is dark
  expect(detectDarkTerminal(0.93, "15;0")).toBe(false); // a light background is light, whatever COLORFGBG says
});

test("COLORFGBG fallback and unknown defaults dark", () => {
  const cases: [string, boolean][] = [
    ["15;0", true],
    ["0;15", false],
    ["0;7", false],
    ["", true],
    ["garbage", true],
    ["12;default;15", false],
  ];
  for (const [fgbg, dark] of cases) expect({ fgbg, dark: detectDarkTerminal(undefined, fgbg) }).toEqual({ fgbg, dark });
});

test("LOADOUT_THEME answers for terminals that cannot be asked", () => {
  const cases: [string, boolean, boolean][] = [
    ["dark", true, true],
    ["light", false, true],
    [" LIGHT ", false, true],
    ["", false, false],
  ];
  for (const [value, dark, forced] of cases) expect({ value, ...forcedDark(value) }).toEqual({ value, dark, forced });
});

test("an unreadable LOADOUT_THEME is refused, not ignored", () => {
  // Ignoring it would look exactly like the bug it was set to fix.
  let err: unknown;
  try {
    forcedDark("lite");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ThemeException);
  expect(isRefusal(err)).toBe(true);
  expect((err as Error).message).toContain("lite");
});

test("hex is the colour as #rrggbb", () => {
  expect(Dark.accent.hex()).toBe("#7aa2f7");
});
