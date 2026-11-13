import { expect, test } from "bun:test";
import { isoOf, takeInterrupt, takeInterruptWithin, trapInterrupts } from "./platform.ts";

test("timestamps read as Kotlin's Instant writes them", () => {
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
