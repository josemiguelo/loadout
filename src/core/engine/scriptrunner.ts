import { done, failed, type ScriptState } from "../coremodel/coremodel.ts";
import { type CommandFrame, type ProcessRunner, success } from "../exec/index.ts";
import { nowIso } from "../platform/platform.ts";
import { modulePrefix, type ScriptStep, shellLine } from "../../model/index.ts";
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
  needsSudo(step: ScriptStep, options: string): boolean {
    return step.sudo || commandNeedsSudo(commandFor(step, options));
  }

  /**
   * pending says whether script run would execute step: its `check` doesn't pass
   * (or force). Asks the check, as run will again.
   */
  async pending(step: ScriptStep, force: boolean, options: string): Promise<boolean> {
    const check = scriptCheck(step, options);
    if (force || check === undefined) return true;
    const result = await this.runner.capture(this.frame.command(check, step.origin));
    return !success(result);
  }

  /** check is whether step's check passes, and what it printed; undefined when it has none. Never runs step. */
  async check(step: ScriptStep, options: string): Promise<{ done: boolean; output: string } | undefined> {
    const check = scriptCheck(step, options);
    if (check === undefined) return undefined;
    const result = await this.runner.capture(this.frame.command(check, step.origin));
    return { done: success(result), output: (result.stdout + result.stderr).trimEnd() };
  }

  /**
   * run runs step unless its check already passes (or force). options is
   * the machine's, as one sh word. Output goes straight to the terminal.
   */
  async run(step: ScriptStep, force: boolean, options: string): Promise<ScriptOutcome> {
    const check = scriptCheck(step, options);
    if (!force && check !== undefined) {
      const result = await this.runner.capture(this.frame.command(check, step.origin));
      if (success(result)) return { alreadyDone: true };
    }
    const exit = await this.runner.inherit(this.frame.command(commandFor(step, options), step.origin));
    return { alreadyDone: false, state: { status: exit === 0 ? done : failed, lastRun: nowIso(), exitCode: exit } };
  }
}

/** newScriptRunner is a runner running scripts in frame. */
export function newScriptRunner(runner: ProcessRunner, frame: CommandFrame): ScriptRunner {
  return new ScriptRunner(runner, frame);
}

/** scriptCheck is the shell command that says whether step is done, undefined when it has none. */
export function scriptCheck(step: ScriptStep, options: string): string | undefined {
  if (step.module !== undefined) return moduleCommand(step, "check", options);
  return step.check === undefined ? undefined : shellLine(step.check, step.path);
}

/** commandFor is the shell command that executes step itself (not its check). */
export function commandFor(step: ScriptStep, options: string): string {
  if (step.module !== undefined) return moduleCommand(step, "install", options);
  return shellLine(step.run ?? "", step.path);
}

/** moduleCommand calls name in step's module, with its rules and options when the machine gives any. */
function moduleCommand(step: ScriptStep, name: string, options: string): string {
  const given = options === "" ? "" : " '" + (step.rules ?? "") + "' " + options;
  return shellLine(modulePrefix + step.module + " " + name + given, step.path);
}
