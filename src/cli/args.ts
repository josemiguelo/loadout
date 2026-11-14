// The command line: which command the arguments name, its flags
// (interspersed with the positional arguments, persistent flags inherited
// from the root), then help, the arguments' check and the command itself,
// in that order. Errors here are the parser's own words; errors.ts turns
// them into the `Error: ` lines loadout prints.

/** OptKind is what an option holds: a switch, a value, or a repeatable value. */
export type OptKind = "bool" | "string" | "strings";

/** OptSpec is one option, in declaration order, for parsing and for Options. */
export interface OptSpec {
  long: string;
  /** short is the one-letter shorthand ("" = none). */
  short: string;
  help: string;
  kind: OptKind;
  /** value is a string option's default. */
  value: string;
  /** persistent options parse after the subcommand too (the root's). */
  persistent: boolean;
}

/** valued says whether o takes a value: `--repo=<text>`. */
export function valued(o: OptSpec): boolean {
  return o.kind !== "bool";
}

/** ArgSpec is one positional argument, for the usage line and Arguments. */
export interface ArgSpec {
  name: string;
  help: string;
  optional?: boolean;
  multiple?: boolean;
}

/** Run is what a command does with its positional arguments and flags. */
export type Run = (cmd: Command, args: string[], flags: Flags) => Promise<void>;

/** Command is one command of the tree: the root, or a subcommand. */
export class Command {
  /** help is commandHelp's text: help's description, and the root's command list. */
  help = "";
  args: ArgSpec[] = [];
  opts: OptSpec[] = [];
  /** hidden commands run but are never listed nor suggested. */
  hidden = false;
  parent: Command | undefined;
  commands: Command[] = [];
  /** validateArgs refuses positional arguments the command doesn't take; throws. */
  validateArgs: ((cmd: Command, args: string[]) => void) | undefined;
  /** run is the command; undefined = not runnable (help is shown instead). */
  run: Run | undefined;
  /** persistentPreRun runs before this command or any below it runs. */
  persistentPreRun: Run | undefined;
  /**
   * passArgs hands every argument after the command's name to run as it is,
   * flags and `--help` included.
   */
  passArgs = false;

  constructor(readonly name: string) {}

  addCommand(sub: Command): void {
    sub.parent = this;
    this.commands.push(sub);
  }

  hasParent(): boolean {
    return this.parent !== undefined;
  }

  /**
   * flagSet is every option the command parses: its own and its
   * ancestors' persistent ones.
   */
  flagSet(): OptSpec[] {
    const set = [...this.opts];
    for (let c = this.parent; c !== undefined; c = c.parent) set.push(...c.opts.filter((o) => o.persistent));
    return set;
  }
}

/** Flags is the parsed options of one invocation. */
export class Flags {
  private readonly values = new Map<string, boolean | string | string[]>();
  private readonly set = new Set<string>();

  constructor(private readonly opts: readonly OptSpec[]) {
    for (const o of opts) this.values.set(o.long, o.kind === "bool" ? false : o.kind === "string" ? o.value : []);
  }

  bool(name: string): boolean {
    return this.lookup(name, "bool") as boolean;
  }

  string(name: string): string {
    return this.lookup(name, "string") as string;
  }

  strings(name: string): string[] {
    return [...(this.lookup(name, "strings") as string[])];
  }

  /** changed says whether the command line set name. */
  changed(name: string): boolean {
    return this.set.has(name);
  }

  private lookup(name: string, kind: OptKind): boolean | string | string[] {
    const o = this.opts.find((x) => x.long === name);
    if (o === undefined || o.kind !== kind) throw new Error(`no ${kind} flag --${name}`);
    return this.values.get(name)!;
  }

  /** assign sets a value for o, as given; throws FlagError when a switch's isn't a bool. */
  assign(o: OptSpec, value: string): void {
    switch (o.kind) {
      case "bool": {
        const b = parseBool(value);
        if (b === undefined) {
          const flagName = o.short !== "" ? `-${o.short}, --${o.long}` : `--${o.long}`;
          throw new FlagError(
            `invalid argument ${quoteString(value)} for ${quoteString(flagName)} flag: parsing ${quoteString(value)}: invalid syntax`,
          );
        }
        this.values.set(o.long, b);
        break;
      }
      case "string":
        this.values.set(o.long, value);
        break;
      case "strings": {
        // The first value replaces the default, the next ones add to it.
        const before = this.set.has(o.long) ? (this.values.get(o.long) as string[]) : [];
        this.values.set(o.long, [...before, value]);
        break;
      }
    }
    this.set.add(o.long);
  }
}

/** FlagError is a command line the parser refuses, in its words. */
export class FlagError extends Error {}

/** HelpRequested is -h/--help on a command that doesn't declare it. */
export class HelpRequested extends Error {}

/** parseBool reads 1, t, T, TRUE, true, True and their false counterparts; undefined for anything else. */
function parseBool(s: string): boolean | undefined {
  switch (s) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "false":
    case "FALSE":
    case "False":
      return false;
  }
  return undefined;
}

/** isPrint says whether cp prints as itself in a quoted string, for the characters a command line holds. */
function isPrint(cp: number): boolean {
  if (cp < 0x20 || cp === 0x7f) return false;
  if (cp >= 0x80 && cp <= 0xa0) return false;
  if (cp === 0xad) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  if (cp === 0xfeff || (cp >= 0x2028 && cp <= 0x2029) || (cp >= 0x200b && cp <= 0x200f)) return false;
  return true;
}

/** quoted is cp escaped inside quote: a backslash before the quote and itself, `\n`-style escapes, `\x`/`\u`/`\U` for what doesn't print. */
function quoted(cp: number, quote: string): string {
  const c = String.fromCodePoint(cp);
  if (c === quote || c === "\\") return "\\" + c;
  if (isPrint(cp)) return c;
  const named: Record<number, string> = { 7: "\\a", 8: "\\b", 12: "\\f", 10: "\\n", 13: "\\r", 9: "\\t", 11: "\\v" };
  if (named[cp] !== undefined) return named[cp]!;
  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
  if (cp < 0x80) return "\\x" + hex(cp, 2);
  if (cp < 0x10000) return "\\u" + hex(cp, 4);
  return "\\U" + hex(cp, 8);
}

/** quoteString is s double-quoted, escaped by quoted. */
export function quoteString(s: string): string {
  let out = '"';
  for (const c of s) out += quoted(c.codePointAt(0)!, '"');
  return out + '"';
}

/** quoteByte is b single-quoted, escaped by quoted. */
function quoteByte(b: number): string {
  return "'" + quoted(b, "'") + "'";
}

function hasNoOptDefVal(name: string, set: readonly OptSpec[]): boolean {
  const o = set.find((x) => x.long === name);
  return o !== undefined && o.kind === "bool";
}

function shortHasNoOptDefVal(name: string, set: readonly OptSpec[]): boolean {
  const o = set.find((x) => x.short !== "" && x.short === name);
  return o !== undefined && o.kind === "bool";
}

/** takesValue says whether s is a flag whose value is the next argument (a guess, before parsing). */
function takesNext(s: string, set: readonly OptSpec[]): boolean {
  if (s.startsWith("--") && !s.includes("=") && !hasNoOptDefVal(s.slice(2), set)) return true;
  return s.startsWith("-") && !s.includes("=") && s.length === 2 && !shortHasNoOptDefVal(s.slice(1), set);
}

/** stripFlags is args without flags (and what look like their values): the command words. */
function stripFlags(args: readonly string[], c: Command): string[] {
  const set = c.flagSet();
  const commands: string[] = [];
  let rest = [...args];
  while (rest.length > 0) {
    const s = rest[0]!;
    rest = rest.slice(1);
    if (s === "--") break;
    if (takesNext(s, set)) {
      if (rest.length <= 1) break;
      rest = rest.slice(1);
      continue;
    }
    if (s !== "" && !s.startsWith("-")) commands.push(s);
  }
  return commands;
}

/** argsMinusFirstX is args without the first command word x. */
function argsMinusFirstX(args: readonly string[], c: Command, x: string): string[] {
  const set = c.flagSet();
  for (let pos = 0; pos < args.length; pos++) {
    const s = args[pos]!;
    if (s === "--") break;
    if (takesNext(s, set)) {
      pos++;
      continue;
    }
    if (!s.startsWith("-") && s === x) return [...args.slice(0, pos), ...args.slice(pos + 1)];
  }
  return [...args];
}

/**
 * argsAfterFirstX is what follows the first command word x in args: a
 * passArgs command's own arguments, without the flags before its name.
 */
function argsAfterFirstX(args: readonly string[], c: Command, x: string): string[] {
  const set = c.flagSet();
  for (let pos = 0; pos < args.length; pos++) {
    const s = args[pos]!;
    if (s === "--") break;
    if (takesNext(s, set)) {
      pos++;
      continue;
    }
    if (!s.startsWith("-") && s === x) return args.slice(pos + 1);
  }
  return [...args];
}

/** find is the command args name, and the arguments left for it. */
export function find(root: Command, args: readonly string[]): [Command, string[]] {
  let c = root;
  let rest = [...args];
  for (;;) {
    const words = stripFlags(rest, c);
    if (words.length === 0) return [c, rest];
    const next = c.commands.find((sub) => sub.name === words[0]);
    if (next === undefined) return [c, rest];
    rest = argsMinusFirstX(rest, c, words[0]!);
    c = next;
  }
}

/**
 * parseFlags is args parsed for cmd: flags anywhere among the
 * positional arguments, `--` ending them, `--flag=value`, `--flag value`,
 * `-abc`, `-fvalue`, `-f=value`, `-f value`. Throws FlagError or
 * HelpRequested.
 */
export function parseFlags(cmd: Command, args: readonly string[]): { flags: Flags; args: string[] } {
  const set = cmd.flagSet();
  const flags = new Flags(set);
  const positional: string[] = [];
  let rest = [...args];
  while (rest.length > 0) {
    const s = rest[0]!;
    rest = rest.slice(1);
    if (s.length === 0 || s[0] !== "-" || s.length === 1) {
      positional.push(s);
      continue;
    }
    if (s[1] === "-") {
      if (s.length === 2) {
        positional.push(...rest);
        break;
      }
      rest = parseLongArg(s, rest, set, flags);
    } else {
      rest = parseShortArg(s, rest, set, flags);
    }
  }
  return { flags, args: positional };
}

function parseLongArg(s: string, args: string[], set: readonly OptSpec[], flags: Flags): string[] {
  let name = s.slice(2);
  if (name.length === 0 || name[0] === "-" || name[0] === "=") throw new FlagError(`bad flag syntax: ${s}`);
  const eq = name.indexOf("=");
  const split = eq < 0 ? [name] : [name.slice(0, eq), name.slice(eq + 1)];
  name = split[0]!;
  const o = set.find((x) => x.long === name);
  if (o === undefined) {
    if (name === "help") throw new HelpRequested();
    throw new FlagError(`unknown flag: --${name}`);
  }
  let value: string;
  if (split.length === 2) {
    value = split[1]!;
  } else if (o.kind === "bool") {
    value = "true";
  } else if (args.length > 0) {
    value = args[0]!;
    args = args.slice(1);
  } else {
    throw new FlagError(`flag needs an argument: ${s}`);
  }
  flags.assign(o, value);
  return args;
}

/**
 * parseShortArg is one `-…` argument: a series of shorthands, the last of
 * them perhaps with its value. It works on bytes, not characters.
 */
function parseShortArg(s: string, args: string[], set: readonly OptSpec[], flags: Flags): string[] {
  let shorthands = Buffer.from(s.slice(1), "utf8");
  let rest = args;
  const text = (b: Buffer) => b.toString("utf8");
  while (shorthands.length > 0) {
    if (text(shorthands).startsWith("test.")) return rest;
    const c = shorthands[0]!;
    let outShorts = shorthands.subarray(1);
    const letter = String.fromCharCode(c);
    const o = c < 0x80 ? set.find((x) => x.short !== "" && x.short === letter) : undefined;
    if (o === undefined) {
      if (letter === "h") throw new HelpRequested();
      throw new FlagError(`unknown shorthand flag: ${quoteByte(c)} in -${text(shorthands)}`);
    }
    let value: string;
    if (shorthands.length > 2 && shorthands[1] === 0x3d) {
      value = text(shorthands.subarray(2));
      outShorts = Buffer.alloc(0);
    } else if (o.kind === "bool") {
      value = "true";
    } else if (shorthands.length > 1) {
      value = text(shorthands.subarray(1));
      outShorts = Buffer.alloc(0);
    } else if (args.length > 0) {
      value = args[0]!;
      rest = args.slice(1);
    } else {
      throw new FlagError(`flag needs an argument: ${quoteByte(c)} in -${text(shorthands)}`);
    }
    flags.assign(o, value);
    shorthands = outShorts;
  }
  return rest;
}

/** Hooks is what executeCommand reports through: the presentation lives elsewhere. */
export interface Hooks {
  /** flagError is a FlagError's message as the error loadout throws. */
  flagError(cmd: Command, message: string): Error;
  printHelp(cmd: Command): void;
}

/**
 * executeCommand runs the command args name: flags parsed
 * (a bad one is hooks.flagError's), help if asked for (or if the command
 * isn't runnable), the positional arguments checked, the nearest
 * persistentPreRun, then the command.
 */
export async function executeCommand(root: Command, args: readonly string[], hooks: Hooks): Promise<void> {
  const [cmd, rest] = find(root, args);
  let parsed: { flags: Flags; args: string[] };
  if (cmd.passArgs && cmd.run !== undefined && cmd.parent !== undefined) {
    const own = cmd.parent === root ? argsAfterFirstX(args, root, cmd.name) : rest;
    const flags = new Flags(cmd.flagSet());
    for (let c: Command | undefined = cmd; c !== undefined; c = c.parent) {
      if (c.persistentPreRun !== undefined) {
        await c.persistentPreRun(cmd, own, flags);
        break;
      }
    }
    await cmd.run(cmd, own, flags);
    return;
  }
  try {
    parsed = parseFlags(cmd, rest);
  } catch (e) {
    if (e instanceof HelpRequested) {
      hooks.printHelp(cmd);
      return;
    }
    if (e instanceof FlagError) throw hooks.flagError(cmd, e.message);
    throw e;
  }
  const { flags } = parsed;
  if (cmd.flagSet().some((o) => o.long === "help") && flags.bool("help")) {
    hooks.printHelp(cmd);
    return;
  }
  if (cmd.run === undefined) {
    hooks.printHelp(cmd);
    return;
  }
  cmd.validateArgs?.(cmd, parsed.args);
  for (let c: Command | undefined = cmd; c !== undefined; c = c.parent) {
    if (c.persistentPreRun !== undefined) {
      await c.persistentPreRun(cmd, parsed.args, flags);
      break;
    }
  }
  await cmd.run(cmd, parsed.args, flags);
}
