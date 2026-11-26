// cli is loadout's commands (one file per subcommand) and their
// presentation: Style (palette -> ANSI), echoRows (tables and boxes),
// spinning, help (help.ts), and the converge pipeline. The command line
// is read by args.ts. The services they share with the home screen live in src/app.

import { type AppContext, hasScreen, newApp } from "../app/index.ts";
import { envVar, isStdoutTty } from "../core/platform/platform.ts";
import { VERSION } from "../version.ts";
import { type ArgSpec, Command, executeCommand, type Run } from "./args.ts";
import { newApplyConfigCmd } from "./apply-config.ts";
import { newBunCmd } from "./bun.ts";
import { newChezmoiCmd } from "./chezmoi.ts";
import { newCompileCmd } from "./compile.ts";
import { newDiffCmd } from "./diff.ts";
import { argsAtMost, exitWith, flagError, noSuchSubcommand, setRoot } from "./errors.ts";
import { newExplainCmd } from "./explain.ts";
import { home } from "./home.ts";
import { boolFlag, helpFlag, printHelp, stringFlag } from "./help.ts";
import { newInitCmd } from "./init.ts";
import { newInstallProgramCmd } from "./install-program.ts";
import { newInstallersCmd } from "./installers.ts";
import { newOutdatedCmd } from "./outdated.ts";
import { newCheckScriptCmd } from "./check-script.ts";
import { newRunScriptCmd } from "./run-script.ts";
import { newSelfUpgradeCmd } from "./selfupgrade.ts";
import { newSetupCmd } from "./setup.ts";
import { echo, echoErr } from "./spinner.ts";
import { Style } from "./style.ts";
import { newSyncCmd } from "./sync.ts";
import { newUpgradeCmd } from "./upgrade.ts";
import { newStatusCmd } from "./status.ts";

/**
 * ctx is the shared services, built by the root command before any
 * subcommand runs.
 */
let ctx: AppContext | undefined;

/** appCtx is the shared services; only a command's run may ask for them. */
export function appCtx(): AppContext {
  if (ctx === undefined) throw new Error("the command line hasn't been read yet");
  return ctx;
}

/** envOr is environment variable name, or fallback when it's unset or empty. */
export function envOr(name: string, fallback: string): string {
  const v = envVar(name);
  return v !== undefined && v !== "" ? v : fallback;
}

/** newRoot is the `loadout` command with every subcommand. */
export function newRoot(): Command {
  const root = new Command("loadout");
  // The home screen is the bare invocation; every subcommand still runs
  // normally, and a pipe still gets help.
  root.validateArgs = (cmd, args) => {
    if (args.length > 0) throw noSuchSubcommand(cmd, args[0]!);
  };
  root.persistentPreRun = async (_cmd, _args, flags) => {
    // The palette is settled before anything runs: the background query (TTY only) never lands while a child
    // process or the home screen owns the terminal.
    Style.init();
    if (flags.bool("version")) {
      echo("loadout version " + VERSION);
      throw exitWith(0);
    }
    ctx = newApp(flags.string("repo"), flags.string("machine"), flags.bool("verbose"));
  };
  root.run = async (cmd) => {
    if (!isStdoutTty() || !hasScreen()) {
      printHelp(cmd);
      return;
    }
    return home(appCtx());
  };
  setRoot(root);
  root.help = "Set up a machine from a shared config repo and track installed program versions. v" + VERSION;

  // Persistent so they also parse after the subcommand; help lists them on
  // the root only.
  boolFlag(root, "version", "V", "Show the version and exit", true);
  stringFlag(
    root,
    "repo",
    "",
    envOr("LOADOUT_REPO", "."),
    "Path to the config repo (default: $LOADOUT_REPO, then the current directory)",
    true,
  );
  stringFlag(root, "machine", "", envOr("LOADOUT_MACHINE", ""), "Machine name for state tracking (default: hostname)", true);
  boolFlag(root, "verbose", "v", "Verbose output", true);
  helpFlag(root);

  // Commands that act on one kind of thing are its verbs: `loadout script
  // run`. The rest act across them and are a word each.
  const groups: [string, string, Command[]][] = [
    [
      "machine",
      "This machine: set it up, check it, see what's behind, sync it with the repo, compare it with the others.",
      [newSetupCmd(), newStatusCmd(), newOutdatedCmd(), newSyncCmd(), newDiffCmd(), newExplainCmd("explain", "machine")],
    ],
    ["repo", "The config repo: scaffold one, compile its manifests.", [newInitCmd(), newCompileCmd()]],
    ["program", "Programs: install them, explain them.", [newInstallProgramCmd(), newExplainCmd("explain", "program")]],
    ["script", "Scripts: run them, ask whether they're done, explain them.", [newRunScriptCmd(), newCheckScriptCmd(), newExplainCmd("explain", "script")]],
    ["config", "Configs (chezmoi's): write them to this machine, explain them.", [newApplyConfigCmd(), newExplainCmd("explain", "config")]],
    ["installer", "Installers: list them, and upgrade what one installed.", [newInstallersCmd(), newUpgradeCmd()]],
    ["self", "loadout itself: upgrade it.", [newSelfUpgradeCmd()]],
  ];
  for (const sub of [
    ...groups.map(([name, help, verbs]) => group(name, help, verbs)),
    newChezmoiCmd(),
    newBunCmd(),
    // loadout 6.0's names, kept working until 7.0, each saying where it went.
    renamed(newSetupCmd("setup-new-machine"), "machine new"),
    renamed(newStatusCmd("status"), "machine status"),
    renamed(newOutdatedCmd("outdated"), "machine outdated"),
    renamed(newSyncCmd("sync"), "machine sync"),
    renamed(newDiffCmd("diff"), "machine diff"),
    renamed(newExplainCmd("explain"), "program explain, script explain, config explain or machine explain"),
    renamed(newInitCmd("init"), "repo init"),
    renamed(newCompileCmd("compile"), "repo compile"),
    renamed(newInstallProgramCmd("install-program"), "program install"),
    renamed(newRunScriptCmd("run-script"), "script run"),
    renamed(newCheckScriptCmd("check-script"), "script check"),
    renamed(newApplyConfigCmd("apply-config"), "config apply"),
    renamed(newInstallersCmd("installers"), "installer list"),
    renamed(newUpgradeCmd("upgrade"), "installer upgrade"),
    renamed(newSelfUpgradeCmd("self-upgrade"), "self upgrade"),
  ]) {
    // A command that passes its arguments on passes --help on too.
    if (!sub.passArgs) helpFlag(sub);
    root.addCommand(sub);
  }
  // No `help` subcommand: `loadout help` is no such subcommand. A hidden
  // stand-in holds the name, showing its help.
  const noHelp = new Command("no-help-command");
  noHelp.hidden = true;
  root.addCommand(noHelp);
  return root;
}


/** group is a command that's only its verbs: run bare, it shows them. */
function group(name: string, help: string, verbs: Command[]): Command {
  const g = new Command(name);
  g.help = help;
  // Bare, it lists its verbs; a word it doesn't have is an error, never its help.
  g.run = async (cmd, args) => {
    if (args.length > 0) throw noSuchSubcommand(cmd, args[0]!);
    Style.init();
    printHelp(cmd);
  };
  for (const v of verbs) {
    helpFlag(v);
    g.addCommand(v);
  }
  return g;
}

/**
 * renamed is cmd under the name loadout 6.0 gave it: hidden, working as
 * before, saying on stderr what to run now. 7.0 drops them.
 */
function renamed(cmd: Command, now: string): Command {
  cmd.hidden = true;
  const run = cmd.run!;
  cmd.run = async (c, args, flags) => {
    echoErr(Style.dim("loadout " + cmd.name + " is now loadout " + now));
    return run(c, args, flags);
  };
  return cmd;
}

/**
 * subcommand is a subcommand named name with help (commandHelp's) and its
 * positional arguments, running run with the shared services (appCtx).
 */
export function subcommand(name: string, help: string, args: ArgSpec[], run: Run): Command {
  const cmd = new Command(name);
  cmd.run = run;
  cmd.help = help;
  cmd.args = args;
  const optional = args.length > 0 && args[args.length - 1]!.multiple === true;
  if (!optional) cmd.validateArgs = argsAtMost(args.length);
  return cmd;
}

/**
 * execute parses args and runs the command they name. What it throws is
 * for main to report: a UsageError (its render on stderr, exit 1), an
 * ExitError (its code, nothing printed), an InterruptedByUser (130), or
 * anything else (`error: <message>`, exit 1).
 */
export function execute(args: readonly string[]): Promise<void> {
  return executeCommand(newRoot(), args, { flagError, printHelp });
}
