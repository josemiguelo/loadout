// The termios calls the OSC 11 query needs (tcgetattr, cfmakeraw,
// tcsetattr), from libc through bun:ffi: Bun has no termios API of its own,
// and the query must read with a deadline the terminal enforces (VMIN 0 +
// VTIME), not poll() (see terminalBackgroundLuma). Linux (glibc) and macOS
// lay struct termios out differently, which is all this file knows about
// them: where c_cc starts and which slots VMIN and VTIME are.

import { dlopen, FFIType, ptr } from "bun:ffi";

/** layout is struct termios on this platform: its size (rounded up), c_cc's offset and the VMIN/VTIME slots. */
interface Layout {
  readonly lib: string;
  readonly size: number;
  readonly cc: number;
  readonly vmin: number;
  readonly vtime: number;
}

function layout(): Layout | undefined {
  switch (process.platform) {
    // glibc: four uint32 flags, c_line, c_cc[32], two speeds (60 bytes).
    case "linux":
      return { lib: "libc.so.6", size: 64, cc: 17, vmin: 6, vtime: 5 };
    // Darwin: four unsigned long flags, c_cc[20], two unsigned long speeds (72 bytes).
    case "darwin":
      return { lib: "/usr/lib/libSystem.B.dylib", size: 72, cc: 32, vmin: 16, vtime: 17 };
  }
  return undefined;
}

/** Termios is one terminal's modes, as raw bytes. */
export class Termios {
  constructor(
    readonly bytes: Uint8Array,
    private readonly l: Layout,
  ) {}
  setVmin(v: number): void {
    this.bytes[this.l.cc + this.l.vmin] = v;
  }
  setVtime(v: number): void {
    this.bytes[this.l.cc + this.l.vtime] = v;
  }
}

/** TermiosApi gets and sets a tty's modes. */
export interface TermiosApi {
  /** get is fd's modes, undefined when fd isn't a terminal. */
  get(fd: number): Termios | undefined;
  /** raw is t made raw (cfmakeraw: no line buffering, no echo, Ctrl-C a byte; VMIN 1, VTIME 0). */
  raw(t: Termios): Termios;
  /** set applies t to fd at once (TCSANOW). */
  set(fd: number, t: Termios): void;
}

let api: TermiosApi | null | undefined;

/** termiosOf is libc's termios calls, undefined where they can't be loaded. */
export function termiosOf(): TermiosApi | undefined {
  if (api !== undefined) return api ?? undefined;
  api = null;
  const l = layout();
  if (!l) return undefined;
  try {
    const { symbols } = dlopen(l.lib, {
      tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      tcsetattr: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      cfmakeraw: { args: [FFIType.ptr], returns: FFIType.void },
    });
    const TCSANOW = 0;
    api = {
      get(fd) {
        const b = new Uint8Array(l.size);
        return symbols.tcgetattr(fd, ptr(b)) === 0 ? new Termios(b, l) : undefined;
      },
      raw(t) {
        const b = new Uint8Array(t.bytes);
        symbols.cfmakeraw(ptr(b));
        return new Termios(b, l);
      },
      set(fd, t) {
        symbols.tcsetattr(fd, TCSANOW, ptr(t.bytes));
      },
    };
  } catch {
    api = null;
  }
  return api ?? undefined;
}
