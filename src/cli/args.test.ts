import { expect, test } from "bun:test";
import { Command, executeCommand, find, parseFlags } from "./args.ts";
import { UsageError, flagError } from "./errors.ts";
import { newRoot } from "./root.ts";

/** refusal is the UsageError the command line gets, rendered as main prints it (off a terminal). */
async function refusal(args: string[]): Promise<string> {
  const root = newRoot();
  // Every command's run is replaced: these tests read the command line only.
  for (const c of [root, ...root.commands]) if (c.run !== undefined) c.run = async () => {};
  try {
    await executeCommand(root, args, { flagError, printHelp: () => {} });
  } catch (e) {
    if (e instanceof UsageError) return e.render();
    throw e;
  }
  return "";
}

// What loadout prints for each.
test("bad command lines are refused with the command's usage and one Error: line", async () => {
  const root = "Usage: loadout [<options>] <command> [<args>]...\n\nError: ";
  const cases: [string[], string][] = [
    [["help"], root + "no such subcommand help"],
    [["--bogus", "status"], root + "no such option --bogus. Did you mean --verbose?"],
    [["machine", "status", "--jsn"], "Usage: loadout machine status [<options>]\n\nError: no such option --jsn. Did you mean --json?"],
    [
      ["machine", "status", "--json=maybe"],
      'Usage: loadout machine status [<options>]\n\nError: invalid argument "maybe" for "--json" flag: parsing "maybe": invalid syntax',
    ],
    [["repo", "init", "a", "b"], "Usage: loadout repo init [<options>] [<path>]\n\nError: got unexpected extra argument (b)"],
    [["installer", "list", "a", "b", "c"], "Usage: loadout installer list [<options>] [<name>]\n\nError: got unexpected extra arguments (b c)"],
    [["---x"], root + "bad flag syntax: ---x"],
    [["--version", "extra"], root + "no such subcommand extra"],
    [["repo", "init", "--parent"], "Usage: loadout repo init [<options>] [<path>]\n\nError: option --parent requires a value"],
    [["machine", "sync", "-m"], "Usage: loadout machine sync [<options>]\n\nError: option -m requires a value"],
    [["machine", "sync", "-mx", "--nope"], "Usage: loadout machine sync [<options>]\n\nError: no such option --nope. Did you mean --no-push?"],
    [["machine", "status", "--", "--json"], "Usage: loadout machine status [<options>]\n\nError: got unexpected extra argument (--json)"],
    [["-Vx"], root + "no such option -x"],
    [["-h extra"], root + "no such option - "],
    [["--version extra"], root + "no such option --version. (Possible options: --version, --verbose)"],
    [["--", "status"], root + "no such subcommand status"],
    [["--repo"], root + "option --repo requires a value"],
  ];
  for (const [args, want] of cases) expect([args, await refusal(args)]).toEqual([args, want]);
});

test("help wins over the arguments' check, and a flag error over help", async () => {
  expect(await refusal(["machine", "status", "-h", "extra"])).toBe("");
  expect(await refusal(["machine", "status", "-h", "--bogus"])).toBe("Usage: loadout machine status [<options>]\n\nError: no such option --bogus");
});

test("the command is found past persistent flags and their values", () => {
  const root = newRoot();
  const [cmd, rest] = find(root, ["--repo", "status", "init", "--configs"]);
  expect(cmd.name).toBe("init");
  expect(rest).toEqual(["--repo", "status", "--configs"]);
  const parsed = parseFlags(cmd, rest);
  expect(parsed.flags.string("repo")).toBe("status");
  expect(parsed.flags.bool("configs")).toBe(true);
  expect(parsed.args).toEqual([]);
});

test("flags parse: shorthands grouped, values attached or next, repeatable ones adding up", () => {
  const cmd = new Command("x");
  cmd.opts = [
    { long: "yes", short: "y", help: "", kind: "bool", value: "", persistent: false },
    { long: "message", short: "m", help: "", kind: "string", value: "dflt", persistent: false },
    { long: "item", short: "", help: "", kind: "strings", value: "", persistent: false },
  ];
  let p = parseFlags(cmd, ["a", "-ymhello", "--item=1", "b", "--item", "2", "--", "-y"]);
  expect([p.flags.bool("yes"), p.flags.string("message"), p.flags.strings("item"), p.args]).toEqual([true, "hello", ["1", "2"], ["a", "b", "-y"]]);
  expect(p.flags.changed("message")).toBe(true);
  p = parseFlags(cmd, ["-y=false", "-m", "v"]);
  expect([p.flags.bool("yes"), p.flags.string("message")]).toEqual([false, "v"]);
  p = parseFlags(cmd, []);
  expect([p.flags.string("message"), p.flags.changed("message"), p.flags.strings("item")]).toEqual(["dflt", false, []]);
});

test("a command that passes its arguments on gets them as given, after its name only", async () => {
  const root = newRoot();
  let got: string[] | undefined;
  const bun = root.commands.find((c) => c.name === "bun")!;
  bun.run = async (_cmd, args) => {
    got = args;
  };
  const cases: [string[], string[]][] = [
    [["bun", "--version"], ["--version"]],
    [["bun", "-h"], ["-h"]],
    [["bun", "run", "--watch", "x.ts", "--", "-v"], ["run", "--watch", "x.ts", "--", "-v"]],
    [["--repo", "bun", "-v", "bun", "--help"], ["--help"]],
    [["bun"], []],
  ];
  for (const [args, want] of cases) {
    got = undefined;
    await executeCommand(root, args, { flagError, printHelp: () => {} });
    expect([args, got]).toEqual([args, want]);
  }
});

test("a group runs bare as its help, and refuses a verb it doesn't have", async () => {
  const root = newRoot();
  let helped = "";
  await executeCommand(root, ["script"], { flagError, printHelp: (c) => void (helped = c.name) });
  // A bare group prints its own help (through printHelp, off a terminal).
  let refused = "";
  try {
    await executeCommand(root, ["script", "nope"], { flagError, printHelp: () => {} });
  } catch (e) {
    if (e instanceof UsageError) refused = e.render();
    else throw e;
  }
  expect(refused).toBe("Usage: loadout script [<options>] <command> [<args>]...\n\nError: no such subcommand nope");
  // A verb mistyped is suggested from its group.
  let typo = "";
  try {
    await executeCommand(root, ["machine", "stauts"], { flagError, printHelp: () => {} });
  } catch (e) {
    if (e instanceof UsageError) typo = e.render();
    else throw e;
  }
  expect(typo).toContain("no such subcommand stauts. Did you mean status?");
  expect(helped === "" || helped === "script").toBe(true);
});
