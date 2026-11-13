// Package platform is the posix surface the binary needs: the host, the
// clock, the terminal and Ctrl-C.

import { closeSync, openSync, readlinkSync, readSync, writeSync } from "node:fs";
import os from "node:os";
import { isatty } from "node:tty";
import { termiosOf, type Termios } from "./termios.ts";

/**
 * hostname is the machine's hostname (its first label), the default machine
 * name for state files; "unknown" when it can't be read.
 */
export function hostname(): string {
  try {
    return os.hostname().split(".")[0]!;
  } catch {
    return "unknown";
  }
}

/** isStdoutTty says whether stdout is attached to a terminal (gates the TUI). */
export function isStdoutTty(): boolean {
  return isatty(1);
}

/** UnameInfo is the kernel name ("Linux", "Darwin") and hardware name ("x86_64", "arm64"). */
export interface UnameInfo {
  readonly sysname: string;
  readonly machine: string;
}

/** uname is this kernel's UnameInfo; "unknown" for both when it can't be read. */
export function uname(): UnameInfo {
  try {
    return { sysname: os.type(), machine: os.machine() };
  } catch {
    return { sysname: "unknown", machine: "unknown" };
  }
}

/**
 * nowIso is the current UTC time as ISO-8601, as Kotlin's Instant writes it:
 * "2026-08-14T12:00:00Z", with a fraction of 3, 6 or 9 digits when there is
 * one. The clock reads to the microsecond (performance's high-resolution
 * wall time), not the millisecond a Date holds.
 */
export function nowIso(): string {
  const micros = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000));
  return isoOf(micros * 1000n);
}

/**
 * isoOf is t as nowIso writes it: a Date, or nanoseconds since the epoch
 * (a bigint) for the precision a Date lacks.
 */
export function isoOf(t: Date | bigint): string {
  const epochNanos = typeof t === "bigint" ? t : BigInt(t.getTime()) * 1_000_000n;
  let seconds = epochNanos / 1_000_000_000n;
  let nanos = Number(epochNanos % 1_000_000_000n);
  if (nanos < 0) {
    nanos += 1_000_000_000;
    seconds -= 1n;
  }
  const base = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  if (nanos === 0) return base + "Z";
  if (nanos % 1_000_000 === 0) return `${base}.${String(nanos / 1_000_000).padStart(3, "0")}Z`;
  if (nanos % 1_000 === 0) return `${base}.${String(nanos / 1_000).padStart(6, "0")}Z`;
  return `${base}.${String(nanos).padStart(9, "0")}Z`;
}

/** envVar is the environment variable name's value, undefined when unset (Go's (value, ok)). */
export function envVar(name: string): string | undefined {
  return process.env[name];
}

/**
 * selfExecutable is this binary's own path, or "" when unreadable. Linux
 * reads /proc/self/exe, which names a binary replaced since it started
 * "<path> (deleted)"; that suffix is dropped, as Go's os.Executable does, so
 * the path is the new binary's: read it BEFORE an install replaces it when
 * the old one is meant (sync). macOS: the path the kernel started the
 * binary from.
 */
export function selfExecutable(): string {
  if (process.platform === "linux") {
    try {
      return readlinkSync("/proc/self/exe").replace(/ \(deleted\)$/, "");
    } catch {
      // fall through
    }
  }
  return process.execPath ?? "";
}

// ─── Ctrl-C ─────────────────────────────────────────────────────────────

/**
 * interrupted holds a Ctrl-C that arrived while trapped, until taken. A
 * caught signal resets to default in a child at exec (an ignored one would
 * stay ignored), so the command's processes still stop.
 */
let interrupted = false;
let waiters: (() => void)[] = [];

function onInterrupt(): void {
  interrupted = true;
  const ws = waiters;
  waiters = [];
  for (const w of ws) w();
}

/**
 * trapInterrupts on: Ctrl-C stops the running command's processes but not
 * loadout, and is recorded for takeInterrupt. Off restores the default.
 * A home-screen run's child loadout (LOADOUT_HANDOFF) only.
 */
export function trapInterrupts(on: boolean): void {
  process.off("SIGINT", onInterrupt);
  if (on) process.on("SIGINT", onInterrupt);
}

/** takeInterrupt says whether Ctrl-C arrived since the last call; resets it. */
export function takeInterrupt(): boolean {
  const was = interrupted;
  interrupted = false;
  return was;
}

/**
 * takeInterruptWithin is takeInterrupt, waiting up to ms for a Ctrl-C the
 * runtime hasn't delivered yet (a child it killed may exit first).
 */
export function takeInterruptWithin(ms: number): Promise<boolean> {
  if (interrupted) return Promise.resolve(takeInterrupt());
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve(takeInterrupt());
    };
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== done);
      resolve(takeInterrupt());
    }, ms);
    waiters.push(done);
  });
}

// ─── the terminal ───────────────────────────────────────────────────────

function windowSize(): [cols: number, rows: number] {
  const out = process.stdout as { isTTY?: boolean; columns?: number; rows?: number; getWindowSize?: () => [number, number] };
  if (!out.isTTY) return [0, 0];
  try {
    if (typeof out.getWindowSize === "function") return out.getWindowSize();
  } catch {
    // fall through
  }
  return [out.columns ?? 0, out.rows ?? 0];
}

/** terminalRows is the terminal height in rows (stdout's window size), or 0 when unknown. */
export function terminalRows(): number {
  return windowSize()[1];
}

/** terminalColumns is the terminal width in columns (stdout's window size), or 0 when not a tty. */
export function terminalColumns(): number {
  return windowSize()[0];
}

/** replyTimeoutDeciseconds is VTIME, in tenths of a second: how long a silent terminal costs us. */
const replyTimeoutDeciseconds = 2;

/** maxReplyReads caps a drip-feeding terminal at a few timeouts instead of 120 of them. */
const maxReplyReads = 3;

/**
 * withRawTty runs f on /dev/tty in raw mode (cfmakeraw, then tweak),
 * restoring its modes after; false when there is no terminal.
 */
function withRawTty(tweak: (t: Termios) => void, f: (fd: number) => void): boolean {
  const termios = termiosOf();
  if (!termios) return false;
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return false;
  }
  try {
    const saved = termios.get(fd);
    if (!saved) return false;
    const raw = termios.raw(saved);
    tweak(raw);
    termios.set(fd, raw);
    try {
      f(fd);
    } finally {
      termios.set(fd, saved);
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

const rgbReply = /rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})/;

/**
 * terminalBackgroundLuma is the perceptual luminance (0 = black, 1 = white)
 * of the terminal background, queried via OSC 11, and undefined if the
 * terminal doesn't answer. Must be called BEFORE any TUI takes the terminal
 * over (briefly switches the tty to raw mode to read the reply).
 */
export function terminalBackgroundLuma(): number | undefined {
  let reply = "";
  // The deadline MUST come from the terminal itself, never from poll():
  // on Darwin poll() answers /dev/tty with POLLNVAL instead of readiness,
  // so a poll guard waves through a read that then blocks FOREVER whenever
  // nothing replies — which is every terminal that swallows the query, a
  // nested tmux (a tmux popup running its own client) being the one people
  // actually hit. Raw mode leaves VMIN=1, i.e. "block until a byte
  // arrives"; VMIN=0 + VTIME makes read() return 0 when the reply doesn't
  // come, so detection stays fail-soft.
  const ok = withRawTty(
    (t) => {
      t.setVmin(0);
      t.setVtime(replyTimeoutDeciseconds);
    },
    (fd) => {
      try {
        writeSync(fd, "\x1b]11;?\x1b\\");
      } catch {
        return;
      }
      // Reply: ESC ] 11 ; rgb:RRRR/GGGG/BBBB (ST or BEL terminated).
      const buf = Buffer.alloc(128);
      let total = 0;
      for (let reads = 0; total < 120 && reads < maxReplyReads; reads++) {
        let n: number;
        try {
          n = readSync(fd, buf, total, 120 - total, null);
        } catch {
          break;
        }
        if (n <= 0) break;
        total += n;
        const got = buf.subarray(0, total).toString("latin1");
        if (got.includes("\\") || got.includes("\x07")) break;
      }
      reply = buf.subarray(0, total).toString("latin1");
    },
  );
  if (!ok) return undefined;
  const rgb = rgbReply.exec(reply);
  if (!rgb) return undefined;
  const channel = (hex: string) => parseInt(hex.slice(0, 2), 16) / 255.0;
  return 0.2126 * channel(rgb[1]!) + 0.7152 * channel(rgb[2]!) + 0.0722 * channel(rgb[3]!);
}
