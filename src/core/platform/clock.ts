// The wall clock to the nanosecond, from libc's clock_gettime(CLOCK_REALTIME)
// through bun:ffi: a Date holds milliseconds and performance's wall time
// microseconds, but state files' timestamps carry 9 fraction digits.

import { dlopen, FFIType, ptr } from "bun:ffi";

/** CLOCK_REALTIME is 0 on Linux and on macOS. */
const clockRealtime = 0;

let clock: (() => bigint) | null | undefined;

/**
 * realtimeNanos is nanoseconds since the epoch, undefined where libc's
 * clock can't be loaded. struct timespec is two 64-bit fields (tv_sec,
 * tv_nsec) on every 64-bit target loadout builds for.
 */
export function realtimeNanos(): bigint | undefined {
  if (clock === undefined) clock = load();
  return clock === null ? undefined : clock();
}

function load(): (() => bigint) | null {
  const lib = process.platform === "linux" ? "libc.so.6" : process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : undefined;
  if (lib === undefined) return null;
  try {
    const { symbols } = dlopen(lib, { clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
    const spec = new BigInt64Array(2);
    return () => {
      if (symbols.clock_gettime(clockRealtime, ptr(spec)) !== 0) throw new Error("clock_gettime failed");
      return spec[0]! * 1_000_000_000n + spec[1]!;
    };
  } catch {
    return null;
  }
}
