// The exec module runs shell commands: every process loadout starts goes
// through ProcessRunner, so tests script them (fakeexec).

import { Refusal } from "../../model/index.ts";

/** ExecResult is a finished command's exit code and output. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** success says whether the command exited 0. */
export function success(r: ExecResult): boolean {
  return r.exitCode === 0;
}

/**
 * ShellCommand is one shell command line and the frame it runs in: cwd
 * ("" = the caller's) and env, added to the inherited environment
 * (undefined: the environment as it is).
 */
export interface ShellCommand {
  line: string;
  cwd: string;
  env?: Record<string, string>;
}

/**
 * line is a plain command line run in workDir ("" = the caller's): git,
 * probes, self-version. Manifest commands get theirs from a CommandFrame.
 */
export function line(line: string, workDir = ""): ShellCommand {
  return { line, cwd: workDir };
}

/**
 * ProcessRunner runs shell commands. All commands go through `sh -c`, so
 * pipes, redirects and env-var references work as they would in a terminal.
 * The only rejection is InterruptedByUser: Ctrl-C in a home-screen run's child loadout.
 */
export interface ProcessRunner {
  /** capture runs command capturing stdout/stderr (version checks, probes, git plumbing). */
  capture(command: ShellCommand): Promise<ExecResult>;
  /**
   * inherit runs command with stdio inherited from the parent terminal, so
   * interactive prompts (sudo) and progress bars work. Resolves to the exit code.
   */
  inherit(command: ShellCommand): Promise<number>;
}

/** InterruptedByUser is Ctrl-C stopping a command the home screen handed the terminal to. */
export class InterruptedByUser extends Refusal {
  constructor() {
    super("interrupted");
  }
}
