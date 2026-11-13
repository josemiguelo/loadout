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

// What the Go binary (cobra and pflag, worded as Clikt) printed for each.
test("bad command lines are refused in the Go binary's words", async () => {
  const root = "Usage: loadout [<options>] <command> [<args>]...\n\nError: ";
  const cases: [string[], string][] = [
    [["help"], root + "no such subcommand help"],
    [["--bogus", "status"], root + "no such option --bogus. Did you mean --verbose?"],
    [["status", "--jsn"], "Usage: loadout status [<options>]\n\nError: no such option --jsn. Did you mean --json?"],
    [
      ["status", "--json=maybe"],
      'Usage: loadout status [<options>]\n\nError: invalid argument "maybe" for "--json" flag: strconv.ParseBool: parsing "maybe": invalid syntax',
    ],
    [["init", "a", "b"], "Usage: loadout init [<options>] [<path>]\n\nError: got unexpected extra argument (b)"],
    [["installers", "a", "b", "c"], "Usage: loadout installers [<options>] [<name>]\n\nError: got unexpected extra arguments (b c)"],
    [["---x"], root + "bad flag syntax: ---x"],
    [["--version", "extra"], root + "no such subcommand extra"],
    [["init", "--parent"], "Usage: loadout init [<options>] [<path>]\n\nError: option --parent requires a value"],
    [["sync", "-m"], "Usage: loadout sync [<options>]\n\nError: option -m requires a value"],
    [["sync", "-mx", "--nope"], "Usage: loadout sync [<options>]\n\nError: no such option --nope. Did you mean --no-push?"],
    [["status", "--", "--json"], "Usage: loadout status [<options>]\n\nError: got unexpected extra argument (--json)"],
    [["-Vx"], root + "no such option -x"],
    [["-h extra"], root + "no such option - "],
    [["--version extra"], root + "no such option --version. (Possible options: --version, --verbose)"],
    [["--", "status"], root + "no such subcommand status. Did you mean status?"],
    [["--repo"], root + "option --repo requires a value"],
  ];
  for (const [args, want] of cases) expect([args, await refusal(args)]).toEqual([args, want]);
});

test("help wins over the arguments' check, and a flag error over help", async () => {
  expect(await refusal(["status", "-h", "extra"])).toBe("");
  expect(await refusal(["status", "-h", "--bogus"])).toBe("Usage: loadout status [<options>]\n\nError: no such option --bogus");
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

test("flags parse as pflag's: shorthands grouped, values attached or next, repeatable ones adding up", () => {
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
