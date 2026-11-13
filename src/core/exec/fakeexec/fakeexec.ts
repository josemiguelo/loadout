// Package fakeexec is a scripted exec.ProcessRunner for tests.

import type { ExecResult, ProcessRunner, ShellCommand } from "../exec.ts";

/** Option shapes a registered response. */
export type Option = (r: ExecResult) => void;

/** exit sets the exit code (default 0). */
export function exit(code: number): Option {
  return (r) => {
    r.exitCode = code;
  };
}

/** stdout sets what the command prints. */
export function stdout(s: string): Option {
  return (r) => {
    r.stdout = s;
  };
}

/** stderr sets what the command prints on stderr. */
export function stderr(s: string): Option {
  return (r) => {
    r.stderr = s;
  };
}

/**
 * Runner answers registered command lines; an unregistered one fails with
 * exit 127, like a missing binary would. Engines run checks concurrently;
 * each call records and answers at once, so the record is in call order.
 */
export class Runner implements ProcessRunner {
  private readonly responses = new Map<string, ExecResult>();
  private readonly log: ShellCommand[] = [];

  /** onCommand registers line's response: exit 0 and no output unless options say otherwise. */
  onCommand(line: string, ...options: Option[]): this {
    const result: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
    for (const o of options) o(result);
    this.responses.set(line, result);
    return this;
  }

  /** received is every command with its cwd and env, in execution order. */
  received(): ShellCommand[] {
    return [...this.log];
  }

  /** executed is every command line, in execution order. */
  executed(): string[] {
    return this.log.map((c) => c.line);
  }

  /** answer records command and is its response. */
  private answer(command: ShellCommand): ExecResult {
    this.log.push(command);
    const r = this.responses.get(command.line);
    if (r !== undefined) return { ...r };
    return { exitCode: 127, stdout: "", stderr: "sh: command not found" };
  }

  /** capture implements exec.ProcessRunner. */
  capture(command: ShellCommand): Promise<ExecResult> {
    return Promise.resolve(this.answer(command));
  }

  /** inherit implements exec.ProcessRunner. */
  inherit(command: ShellCommand): Promise<number> {
    return Promise.resolve(this.answer(command).exitCode);
  }
}

/** newRunner is a runner that knows no commands yet (Go's fakeexec.New). */
export function newRunner(): Runner {
  return new Runner();
}
