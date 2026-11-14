import { readSync, writeSync } from "node:fs";
import { isStdoutTty } from "../core/platform/platform.ts";

/** brokenPipeStatus is 128 + SIGPIPE: how a shell reports a process a closed pipe ended. */
export const brokenPipeStatus = 141;

/** Writer is where commands write: a file descriptor, or a test's buffer. */
export interface Writer {
  write(text: string): void;
}

/**
 * fdWriter writes synchronously to fd, so nothing is lost when loadout
 * exits right after (process.exit doesn't wait for queued writes). When the
 * reader has gone (`loadout status | head -1`), loadout stops quietly with
 * 141, the status of a process a broken pipe ends.
 */
export function fdWriter(fd: number): Writer {
  return {
    write(text: string): void {
      let bytes = Buffer.from(text, "utf8");
      while (bytes.length > 0) {
        try {
          bytes = bytes.subarray(writeSync(fd, bytes));
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          // Nobody reads any more: nothing left to say.
          if (code === "EPIPE") process.exit(brokenPipeStatus);
          // A non-blocking pipe that's full: try again.
          if (code !== "EAGAIN") throw e;
        }
      }
    },
  };
}

/**
 * Where commands write; tests swap them. Every write goes through echo,
 * echoNoNewline or echoErr: JS runs one write at a time, so the spinner's
 * frames never land inside a line.
 */
export const streams: { stdout: Writer; stderr: Writer } = {
  stdout: fdWriter(1),
  stderr: fdWriter(2),
};

/** echo prints text and a newline on stdout. */
export function echo(text: string): void {
  streams.stdout.write(text + "\n");
}

/** echoNoNewline prints text on stdout without a newline (a prompt). */
export function echoNoNewline(text: string): void {
  streams.stdout.write(text);
}

/** echoErr prints text and a newline on stderr. */
export function echoErr(text: string): void {
  streams.stderr.write(text + "\n");
}

/** stdin's bytes read past the last line readLine returned. */
let pending = Buffer.alloc(0);

/** readLine is one line from stdin, trimmed; undefined at end of input. */
export function readLine(): string | undefined {
  const chunk = Buffer.alloc(4096);
  for (;;) {
    const nl = pending.indexOf(0x0a);
    if (nl >= 0) {
      const line = pending.subarray(0, nl).toString("utf8");
      pending = pending.subarray(nl + 1);
      return line.trim();
    }
    let n: number;
    try {
      n = readSync(0, chunk, 0, chunk.length, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue;
      // Any other error ends the input, as bufio's ReadString does.
      n = 0;
    }
    if (n === 0) {
      if (pending.length === 0) return undefined;
      const line = pending.toString("utf8");
      pending = Buffer.alloc(0);
      return line.trim();
    }
    pending = Buffer.concat([pending, chunk.subarray(0, n)]);
  }
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * spinning runs work under a braille spinner line (TTY only — piped output
 * sees nothing), clearing the line when done. Wrap every step slow enough
 * to look like a hang (checks, state writes, git) in this. The frames are
 * drawn from a timer, so work must be async (a process, a file read)
 * for them to move.
 */
export async function spinning<T>(message: string, work: () => Promise<T>): Promise<T> {
  const tty = isStdoutTty();
  let timer: ReturnType<typeof setInterval> | undefined;
  if (tty) {
    let frame = 0;
    const draw = () => {
      echoNoNewline("\r" + spinnerFrames[frame % spinnerFrames.length]! + " " + message);
      frame++;
    };
    draw();
    timer = setInterval(draw, 120);
  }
  try {
    return await work();
  } finally {
    if (timer !== undefined) clearInterval(timer);
    // The erase is its own write: a shorter line printed next would keep the
    // spinner line's tail.
    if (tty) echoNoNewline("\r\x1b[K");
  }
}

/** spin is spinning for work with no result. */
export function spin(message: string, work: () => Promise<void>): Promise<void> {
  return spinning(message, work);
}
