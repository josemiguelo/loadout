import { expect, test } from "bun:test";
import { isoOf, nowIso, takeInterrupt, takeInterruptWithin, trapInterrupts } from "./platform.ts";

test("timestamps are ISO-8601 UTC with 0, 3, 6 or 9 fraction digits", () => {
  const at = (nanos: bigint) => isoOf(BigInt(Date.UTC(2026, 7, 14, 12, 0, 0)) * 1_000_000n + nanos);
  expect(at(0n)).toBe("2026-08-14T12:00:00Z");
  expect(at(650_000_000n)).toBe("2026-08-14T12:00:00.650Z");
  expect(at(651_749_000n)).toBe("2026-08-14T12:00:00.651749Z");
  expect(at(651_749_402n)).toBe("2026-08-14T12:00:00.651749402Z");
  expect(isoOf(new Date(Date.UTC(2026, 7, 14, 12, 0, 0, 650)))).toBe("2026-08-14T12:00:00.650Z");
});

test("an interrupt is taken once", async () => {
  trapInterrupts(true);
  try {
    takeInterrupt();
    process.emit("SIGINT");
    expect(takeInterrupt()).toBe(true);
    expect(takeInterrupt()).toBe(false);
    setTimeout(() => process.emit("SIGINT"), 5);
    expect(await takeInterruptWithin(1000)).toBe(true);
    expect(await takeInterruptWithin(10)).toBe(false);
  } finally {
    trapInterrupts(false);
  }
});

test("the clock reads to the nanosecond on Linux, the microsecond on macOS", () => {
  // All the digits the clock has, unless they happen to end in 000 (1 in 1000).
  const digits = process.platform === "darwin" ? 6 : 9;
  const stamps = Array.from({ length: 5 }, () => nowIso());
  const full = new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{${digits}}Z$`);
  expect(stamps.some((s) => full.test(s))).toBe(true);
  const at = Date.parse(stamps[0]!);
  expect(Math.abs(at - Date.now())).toBeLessThan(5000);
});
