import { done, failed, type ScriptState } from "../coremodel/coremodel.ts";
import { type CommandFrame, type ProcessRunner, success } from "../exec/index.ts";
import { nowIso } from "../platform/platform.ts";
import { installFilePrefix, type ScriptStep, shellLine } from "../../model/index.ts";
import { commandNeedsSudo } from "./sudo.ts";

/** ScriptOutcome is what run did: alreadyDone (its check exited 0), or ran with state. */
export interface ScriptOutcome {
  alreadyDone: boolean;
  /** state is the run's result; undefined when alreadyDone. */
  state?: ScriptState;
}

/** ScriptRunner runs scripts and asks their checks. */
export class ScriptRunner {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly frame: CommandFrame,
  ) {}

  /** needsSudo says whether running step needs sudo's password: it says so, or its command runs sudo. */
  needsSudo(step: ScriptStep, args: string): boolean {
    return step.sudo || commandNeedsSudo(commandFor(step, args));
  }

  /**
   * pending says whether run would execute step: its `check` doesn't pass
   * (or force). Asks the check, as run will again.
   */
  async pending(step: ScriptStep, force: boolean, args: string): Promise<boolean> {
    if (force || step.check === undefined) return true;
    const result = await this.runner.capture(this.frame.command(withArgs(step.check, args, step.path), step.origin));
    return !success(result);
  }

  /**
   * run runs step unless its `check` already passes (or force). args is the
   * machine's argument string; it reaches both the `check` (as positional
   * parameters) and a `file` script's argv. Output goes straight to the terminal.
   */
  async run(step: ScriptStep, force: boolean, args: string): Promise<ScriptOutcome> {
    if (!force && step.check !== undefined) {
      const result = await this.runner.capture(this.frame.command(withArgs(step.check, args, step.path), step.origin));
      if (success(result)) return { alreadyDone: true };
    }
    // Validation guarantees exactly one of file/run is set, and that args
    // are only used with file scripts.
    const exit = await this.runner.inherit(this.frame.command(commandFor(step, args), step.origin));
    return { alreadyDone: false, state: { status: exit === 0 ? done : failed, lastRun: nowIso(), exitCode: exit } };
  }
}

/** newScriptRunner is a runner running scripts in frame. */
export function newScriptRunner(runner: ProcessRunner, frame: CommandFrame): ScriptRunner {
  return new ScriptRunner(runner, frame);
}

/**
 * withArgs gives command (a check, `file:` prefix allowed) the machine's
 * script arguments as positional parameters, with path first on PATH.
 */
export function withArgs(command: string, args: string, path: readonly string[]): string {
  const expanded = shellLine(command, path);
  if (args === "") return expanded;
  return "set -- " + args + "; " + expanded;
}

/** commandFor is the shell command that executes step itself (not its check). */
export function commandFor(step: ScriptStep, args: string): string {
  if (step.file !== undefined) return shellLine(installFilePrefix + step.file + argsSuffix(args), step.path);
  return shellLine(step.run ?? "", step.path);
}

function argsSuffix(args: string): string {
  return args === "" ? "" : " " + args;
}
