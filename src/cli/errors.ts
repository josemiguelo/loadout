import type { Command } from "./args.ts";
import { usageLine } from "./help.ts";
import { Style } from "./style.ts";

/**
 * rootCommand is the root of the running invocation, whose usage line a
 * UsageError without a command shows. The root sets it (newRoot).
 */
let rootCommand: Command | undefined;

/** setRoot records the running invocation's root (Go's rootOf). */
export function setRoot(root: Command): void {
  rootCommand = root;
}

/**
 * UsageError is a command line loadout can't run: printed under the
 * command's usage line as `Error: <message>` on stderr, exit 1, as Clikt
 * did. cmd is the command whose usage to show; undefined (a check a command
 * made once running, like "Give at least one program") shows the root's,
 * which is what Clikt printed for those.
 */
export class UsageError extends Error {
  constructor(
    readonly cmd: Command | undefined,
    message: string,
  ) {
    super(message);
  }

  /** render is the error as printed: the usage line, a blank line, the error. */
  render(): string {
    const cmd = this.cmd ?? rootCommand;
    const usage = cmd === undefined ? "" : usageLine(cmd);
    return usage + "\n\n" + Style.helpDanger("Error:") + " " + this.message;
  }
}

/** usageErr is a UsageError found while running: the root's usage line. */
export function usageErr(message: string): UsageError {
  return new UsageError(undefined, message);
}

/**
 * ExitError ends loadout with code, saying nothing more (Clikt's
 * ProgramResult): the command already said why.
 */
export class ExitError extends Error {
  constructor(readonly code: number) {
    super("exit " + code);
  }
}

/** exitWith is an ExitError: throw it. */
export function exitWith(code: number): ExitError {
  return new ExitError(code);
}

const unknownFlag = /^unknown flag: (\S+)/;
const unknownShorthand = /^unknown shorthand flag: '(.)' in /u;
const needsArgLong = /^flag needs an argument: (--\S+)/;
const needsArgShort = /^flag needs an argument: '(.)' in /u;

/** flagError turns pflag's messages into Clikt's. */
export function flagError(cmd: Command, msg: string): UsageError {
  let m = unknownFlag.exec(msg);
  if (m) return noSuchOption(cmd, m[1]!);
  m = unknownShorthand.exec(msg);
  if (m) return noSuchOption(cmd, "-" + m[1]!);
  m = needsArgLong.exec(msg);
  if (m) return new UsageError(cmd, "option " + Style.helpName(m[1]!) + " requires a value");
  m = needsArgShort.exec(msg);
  if (m) return new UsageError(cmd, "option " + Style.helpName("-" + m[1]!) + " requires a value");
  return new UsageError(cmd, msg);
}

function noSuchOption(cmd: Command, name: string): UsageError {
  const names = cmd.opts.map((o) => "--" + o.long);
  return new UsageError(cmd, "no such option " + Style.helpName(name) + suggest(name, names, "options"));
}

/** noSuchSubcommand refuses a command word that names no subcommand of cmd. */
export function noSuchSubcommand(cmd: Command, name: string): UsageError {
  const names = cmd.commands.filter((sub) => !sub.hidden).map((sub) => sub.name);
  return new UsageError(cmd, "no such subcommand " + name + suggest(name, names, "subcommands"));
}

/**
 * suggest is Clikt's "did you mean": the names similar to name (Jaro-Winkler
 * above 0.8), most similar first.
 */
export function suggest(name: string, names: readonly string[], what: string): string {
  const close: { name: string; score: number }[] = [];
  for (const n of names) {
    const score = jaroWinkler(name, n);
    if (score > 0.8) close.push({ name: n, score });
  }
  // Array.prototype.sort is stable, as sort.SliceStable.
  close.sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : 0));
  switch (close.length) {
    case 0:
      return "";
    case 1:
      return ". Did you mean " + close[0]!.name + "?";
  }
  return ". (Possible " + what + ": " + close.map((c) => c.name).join(", ") + ")";
}

/**
 * jaroWinkler is Clikt's similarity: Jaro, plus 0.1 per character of common
 * prefix (uncapped, unlike textbook Jaro-Winkler).
 */
export function jaroWinkler(s1: string, s2: string): number {
  const a = [...s1];
  const b = [...s2];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  const sim = jaro(a, b);
  return sim + prefix * 0.1 * (1 - sim);
}

function jaro(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length === 1 && b.length === 1) return a[0] === b[0] ? 1 : 0;
  // Go's integer division.
  const searchRange = Math.trunc(Math.max(a.length, b.length) / 2) - 1;
  const consumed = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  let transpositions = 0;
  let matchIndex = 0;
  a.forEach((c, i) => {
    for (let j = Math.max(0, i - searchRange); j <= Math.min(b.length - 1, i + searchRange); j++) {
      if (c !== b[j] || consumed[j]) continue;
      consumed[j] = true;
      matches++;
      if (j < matchIndex) transpositions++;
      matchIndex = j;
      break;
    }
  });
  if (matches === 0) return 0;
  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

/** argsAtMost refuses more positional arguments than n, as Clikt did. */
export function argsAtMost(n: number): (cmd: Command, args: string[]) => void {
  return (cmd, args) => {
    if (args.length <= n) return;
    const extra = args.slice(n);
    const word = extra.length > 1 ? "arguments" : "argument";
    throw new UsageError(cmd, "got unexpected extra " + word + " (" + extra.join(" ") + ")");
  };
}
