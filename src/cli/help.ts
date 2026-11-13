import { isStdoutTty, terminalColumns } from "../core/platform/platform.ts";
import { type ArgSpec, type Command, type OptSpec, valued } from "./args.ts";
import { streams } from "./spinner.ts";
import { Style } from "./style.ts";
import { padEnd, runeCount } from "./table.ts";

/**
 * commandHelp is structured command help: a summary line, then one
 * indented line per arg/flag, names in an aligned column. Help renders it
 * as written (whitespace kept), only wrapping lines too long for the
 * terminal, in the root's command list as on the command's own page.
 */
export function commandHelp(summary: string, ...details: string[]): string {
  if (details.length === 0) return summary;
  const cut = (d: string): [string, string] => {
    const i = d.indexOf("  ");
    return i < 0 ? [d, ""] : [d.slice(0, i), d.slice(i + 2)];
  };
  let nameWidth = 0;
  for (const d of details) nameWidth = Math.max(nameWidth, runeCount(cut(d)[0]));
  const lines = [summary];
  for (const d of details) {
    const [name, rawDesc] = cut(d);
    const desc = rawDesc.trim();
    lines.push(desc === "" ? "  " + name : "  " + padEnd(name, nameWidth + 2) + desc);
  }
  return lines.join("\n");
}

/** argUsage is a's place in the usage line: `<name>`, `[<name>]`, `[<name>]...`. */
function argUsage(a: ArgSpec): string {
  let s = "<" + a.name + ">";
  if (a.optional) s = "[" + s + "]";
  if (a.multiple) s += "...";
  return s;
}

/** optTerm is o as Options lists it: `-y, --yes`, `--repo=<text>`. */
function optTerm(o: OptSpec, name: (s: string) => string, muted: (s: string) => string): string {
  let s = "";
  if (o.short !== "") s = name("-" + o.short) + ", ";
  s += name("--" + o.long);
  if (valued(o)) s += "=" + muted("<text>");
  return s;
}

function addOpt(cmd: Command, o: Omit<OptSpec, "persistent">, persistent: boolean): void {
  cmd.opts.push({ ...o, persistent });
}

/** boolFlag declares a switch and records it for help; persistent ones parse after a subcommand too. */
export function boolFlag(cmd: Command, long: string, short: string, help: string, persistent = false): void {
  addOpt(cmd, { long, short, help, kind: "bool", value: "" }, persistent);
}

/** stringFlag declares an option taking a value (value: its default) and records it for help. */
export function stringFlag(cmd: Command, long: string, short: string, value: string, help: string, persistent = false): void {
  addOpt(cmd, { long, short, help, kind: "string", value }, persistent);
}

/** stringsFlag declares a repeatable option and records it for help. */
export function stringsFlag(cmd: Command, long: string, short: string, help: string): void {
  addOpt(cmd, { long, short, help, kind: "strings", value: "" }, false);
}

/** helpFlag is -h/--help, last in every command's options. */
export function helpFlag(cmd: Command): void {
  boolFlag(cmd, "help", "h", "Show this message and exit");
}

/** helpWidth is the width help wraps to: the terminal's, else 79. */
export function helpWidth(): number {
  if (isStdoutTty()) {
    const cols = terminalColumns();
    if (cols > 0) return cols;
  }
  return 79;
}

/**
 * wrap is text as lines no wider than width, whitespace kept as written
 * (indentation, aligned columns); a line too long breaks at its last space
 * that fits, and goes on at the start of the next line.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let current = "";
    let cur = 0;
    let rest = line;
    while (rest !== "") {
      // One segment: the spaces before a word, and the word.
      let i = 0;
      while (i < rest.length && rest[i] === " ") i++;
      let j = i;
      while (j < rest.length && rest[j] !== " ") j++;
      const spaces = rest.slice(0, i);
      const word = rest.slice(i, j);
      rest = rest.slice(j);
      const n = runeCount(spaces) + runeCount(word);
      if (cur > 0 && cur + n > width && word !== "") {
        out.push(current.replace(/ +$/, ""));
        current = word;
        cur = runeCount(word);
        continue;
      }
      current += spaces + word;
      cur += n;
    }
    out.push(current.replace(/ +$/, ""));
  }
  return out;
}

/**
 * definitionList is terms (styled) and their descriptions, the
 * descriptions in one column after the widest term.
 */
function definitionList(terms: string[], plainTerms: string[], descs: string[], width: number): string {
  let b = "";
  let termWidth = 0;
  for (const t of plainTerms) termWidth = Math.max(termWidth, runeCount(t));
  const col = 2 + termWidth + 2;
  terms.forEach((term, i) => {
    b += "  " + term;
    if (descs[i] === "") {
      b += "\n";
      return;
    }
    b += " ".repeat(termWidth - runeCount(plainTerms[i]!) + 2);
    wrap(descs[i]!, Math.max(width - col, 1)).forEach((line, k) => {
      if (k > 0) b += " ".repeat(col);
      b += line + "\n";
    });
  });
  return b;
}

/** usageLine is `Usage: loadout <command> [<options>] <args>`. */
export function usageLine(cmd: Command): string {
  const s = Style;
  if (!cmd.hasParent()) {
    return s.helpTitle("Usage:") + " loadout " + s.helpMuted("[<options>]") + " " + s.helpMuted("<command> [<args>]...");
  }
  let line = s.helpTitle("Usage:") + " loadout " + cmd.name + " " + s.helpMuted("[<options>]");
  for (const a of cmd.args) line += " " + s.helpMuted(argUsage(a));
  return line;
}

/**
 * renderHelp is cmd's --help, laid out as Clikt's MordantHelpFormatter
 * did: usage, description, Options, then Arguments or Commands, each
 * command listed with its FULL help (the structured arg/flag lines too).
 */
export function renderHelp(cmd: Command): string {
  const s = Style;
  const width = helpWidth();
  const plain = (x: string) => x;
  let b = usageLine(cmd) + "\n\n";
  for (const line of wrap(cmd.help, width - 2)) b += "  " + line + "\n";

  b += "\n" + s.helpTitle("Options:") + "\n";
  b += definitionList(
    cmd.opts.map((o) => optTerm(o, (x) => s.helpName(x), (x) => s.helpMuted(x))),
    cmd.opts.map((o) => optTerm(o, plain, plain)),
    cmd.opts.map((o) => o.help),
    width,
  );

  if (!cmd.hasParent()) {
    const subs = cmd.commands.filter((sub) => !sub.hidden);
    if (subs.length > 0) {
      b += "\n" + s.helpTitle("Commands:") + "\n";
      b += definitionList(
        subs.map((sub) => s.helpName(sub.name)),
        subs.map((sub) => sub.name),
        subs.map((sub) => sub.help),
        width,
      );
    }
  } else if (cmd.args.length > 0) {
    b += "\n" + s.helpTitle("Arguments:") + "\n";
    b += definitionList(
      cmd.args.map((a) => s.helpName("<" + a.name + ">")),
      cmd.args.map((a) => "<" + a.name + ">"),
      cmd.args.map((a) => a.help),
      width,
    );
  }
  return b;
}

/** printHelp writes cmd's help on stdout. */
export function printHelp(cmd: Command): void {
  streams.stdout.write(renderHelp(cmd));
}
