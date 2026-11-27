import { statSync } from "node:fs";
import { fileError } from "../../model/index.ts";
import { takeInterrupt, takeInterruptWithin } from "../platform/platform.ts";
import { type ExecResult, InterruptedByUser, type ProcessRunner, type ShellCommand } from "./exec.ts";

/** killed is the exit code reported for a child killed by a signal, which has none. */
const killed = -1;

/** ShellRunner is the real ProcessRunner: `sh -c <line>`. */
export class ShellRunner implements ProcessRunner {
  /** capture implements ProcessRunner. Stdin is empty: a check never waits on the keyboard. */
  async capture(c: ShellCommand): Promise<ExecResult> {
    let child;
    try {
      child = Bun.spawn(["sh", "-c", c.line], { ...options(c), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      // sh never started (its cwd is gone): a failure, not a crash.
      return { exitCode: killed, stdout: "", stderr: startError(e, c.cwd) };
    }
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const exit = exitOf(child);
    await stopIfInterrupted(child);
    return { exitCode: exit, stdout, stderr };
  }

  /** inherit implements ProcessRunner. */
  async inherit(c: ShellCommand): Promise<number> {
    let child;
    try {
      child = Bun.spawn(["sh", "-c", c.line], { ...options(c), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    } catch (e) {
      process.stderr.write(`sh: ${startError(e, c.cwd)}\n`);
      return killed;
    }
    await child.exited;
    const exit = exitOf(child);
    await stopIfInterrupted(child);
    return exit;
  }
}

/** newShellRunner is the runner the binary uses. */
export function newShellRunner(): ShellRunner {
  return new ShellRunner();
}

/**
 * options is c's directory and environment: c.env over the inherited one
 * (a key in both takes c.env's value).
 */
function options(c: ShellCommand): { cwd?: string; env?: Record<string, string | undefined> } {
  const env = c.env !== undefined && Object.keys(c.env).length > 0 ? { ...process.env, ...c.env } : undefined;
  return { cwd: c.cwd === "" ? undefined : c.cwd, env };
}

/**
 * startError is why sh didn't start, in words: a working
 * directory that isn't there fails the child's chdir ("chdir /x: no such
 * file or directory"); bun reports it as sh's own spawn failing.
 */
function startError(e: unknown, cwd: string): string {
  if (cwd !== "") {
    try {
      if (!statSync(cwd).isDirectory()) return `chdir ${cwd}: not a directory`;
    } catch (err) {
      return fileError(err, "chdir", cwd).message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * exitOf is the child's exit code: a child killed by a signal (Ctrl-C, the
 * OOM killer) has none and reports killed (bun's exited says 128+signal).
 */
function exitOf(child: { exitCode: number | null; signalCode: unknown }): number {
  if (child.signalCode !== null || child.exitCode === null) return killed;
  return child.exitCode;
}

/**
 * stopIfInterrupted: after a Ctrl-C in a home-screen run's child loadout,
 * stop the command too, not just its child process, so it doesn't go on to
 * its next step. Elsewhere Ctrl-C ends loadout itself (see platform.trapInterrupts).
 */
async function stopIfInterrupted(child: { signalCode: unknown }): Promise<void> {
  let interrupted: boolean;
  if (child.signalCode === "SIGINT" || child.signalCode === 2) {
    // The child died of the Ctrl-C loadout got too; the runtime may not
    // have handed loadout's copy over yet.
    interrupted = await takeInterruptWithin(100);
  } else {
    interrupted = takeInterrupt();
  }
  if (interrupted) throw new InterruptedByUser();
}
