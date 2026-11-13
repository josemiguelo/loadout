import { selfExecutable } from "../core/platform/platform.ts";
import { Refusal } from "../model/index.ts";
import type { AppContext } from "./context.ts";
import { type Closed, closedCommand } from "./screen.ts";

/**
 * ChildCommand is a command run without a shell: argv, its folder
 * (undefined = the current directory) and its environment (undefined = this
 * process's). Go's exec.Cmd as runCommand builds it; tui/term's TermCommand
 * takes it as it is.
 */
export interface ChildCommand {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * runCommand is the child loadout running closed's command in the home
 * screen's run panel (a pseudo-terminal it reads through src/tui/term):
 * this same binary, with the global options as given (selfArgv), from the
 * current directory. Its env is this process's plus LOADOUT_HANDOFF=1 (it
 * traps Ctrl-C and exits 130, read as "interrupted") and PAGER=cat,
 * GIT_PAGER=cat: a pager would work in the panel, but its screen would leave
 * nothing in the run's log, which is what stays once the run ends. The
 * terminal sets TERM. undefined means there is nothing to run; throws a
 * HandoffException when loadout can't find its own binary.
 */
export function runCommand(a: AppContext, closed: Closed): ChildCommand | undefined {
  const command = closedCommand(closed);
  if (command === undefined) return undefined;
  const self = selfExecutable();
  if (self === "") throw new HandoffException("can't find loadout's own binary to run the command");
  return childCommand(a, self, command.name, command.args);
}

/** childCommand is runCommand's command for self running name with args. */
export function childCommand(a: AppContext, self: string, name: string, args: readonly string[]): ChildCommand {
  const argv = selfArgv(a, self, name, ...args);
  return { argv, env: { ...process.env, LOADOUT_HANDOFF: "1", PAGER: "cat", GIT_PAGER: "cat" } };
}

/**
 * selfArgv is the argv that runs this same loadout on this repo as this
 * machine (the global options as given), then args: a run's child, or the
 * sync an upgrade starts. self is the binary to run.
 */
export function selfArgv(a: Pick<AppContext, "repoRoot" | "machineOverride" | "verbose">, self: string, ...args: string[]): string[] {
  const argv = [self, "--repo", a.repoRoot];
  if (a.machineOverride !== "") argv.push("--machine", a.machineOverride);
  if (a.verbose) argv.push("-v");
  return [...argv, ...args];
}

/** HandoffException is a run that couldn't start. */
export class HandoffException extends Refusal {}

/** shQuote is s single-quoted for sh. */
export function shQuote(s: string): string {
  return "'" + s.replaceAll("'", `'\\''`) + "'";
}
