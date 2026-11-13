// Package cli is loadout's commands (one file per subcommand) and their
// presentation: Style (palette -> ANSI), echoRows (tables and boxes),
// spinning, help laid out as loadout 3's (Clikt's), and the converge
// pipeline. The command line is read as the Go binary's cobra read it
// (args.ts). The services they share with the home screen live in src/app.

import { type AppContext, hasScreen, newApp } from "../app/index.ts";
import { envVar, isStdoutTty } from "../core/platform/platform.ts";
import { VERSION } from "../version.ts";
import { type ArgSpec, Command, executeCommand, type Run } from "./args.ts";
import { newApplyCmd } from "./apply.ts";
import { newBunCmd } from "./bun.ts";
import { newCompileCmd } from "./compile.ts";
import { newDiffCmd } from "./diff.ts";
import { argsAtMost, exitWith, flagError, noSuchSubcommand, setRoot } from "./errors.ts";
import { newExplainCmd } from "./explain.ts";
import { home } from "./home.ts";
import { boolFlag, helpFlag, printHelp, stringFlag } from "./help.ts";
import { newInitCmd } from "./init.ts";
import { newInstallCmd } from "./install.ts";
import { newInstallersCmd } from "./installers.ts";
import { newOutdatedCmd } from "./outdated.ts";
import { newRunCmd } from "./run.ts";
import { newSelfUpgradeCmd } from "./selfupgrade.ts";
import { newSetupCmd } from "./setup.ts";
import { echo } from "./spinner.ts";
import { Style } from "./style.ts";
import { newSyncCmd } from "./sync.ts";
import { newUpgradeCmd } from "./upgrade.ts";
import { newStatusCmd } from "./status.ts";

/**
 * ctx is the shared services, built by the root command before any
 * subcommand runs (Go's appCtx).
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
    // The palette is settled before anything runs, as Clikt's theme
    // was: the background query (TTY only) never lands while a child
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
  // the root only, as Clikt did.
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

  for (const sub of [
    newStatusCmd(),
    newExplainCmd(),
    newInstallersCmd(),
    newSetupCmd(),
    newInstallCmd(),
    newOutdatedCmd(),
    newRunCmd(),
    newApplyCmd(),
    newDiffCmd(),
    newSyncCmd(),
    newUpgradeCmd(),
    newSelfUpgradeCmd(),
    newInitCmd(),
    newCompileCmd(),
    newBunCmd(),
  ]) {
    // A command that passes its arguments on passes --help on too.
    if (!sub.passArgs) helpFlag(sub);
    root.addCommand(sub);
  }
  // No `help` subcommand: Clikt had none, so `loadout help` is no such
  // subcommand. cobra's stand-in for one stays, hidden, showing its help.
  const noHelp = new Command("no-help-command");
  noHelp.hidden = true;
  root.addCommand(noHelp);
  return root;
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
