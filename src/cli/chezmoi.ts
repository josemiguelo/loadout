import * as fs from "node:fs";
import * as path from "node:path";
import { carryOver, drift, driftMessage, planBuild, type Plan, snapshot, type Snapshot, writeBuild } from "../core/configbuild/configbuild.ts";
import * as engine from "../core/engine/index.ts";
import { envVar } from "../core/platform/platform.ts";
import type { Command } from "./args.ts";
import { askForSudoUpfront } from "./converge.ts";
import { exitWith } from "./errors.ts";
import { commandHelp, printHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo, echoErr } from "./spinner.ts";
import { Style } from "./style.ts";

/** These run over both sources when no path picks one: they're about every target. */
const overBoth = ["apply", "diff", "status", "managed", "verify", "re-add", "merge-all", "archive", "dump", "ignored"];

/** These write chezmoi's source: in a repo with tool folders, what they wrote is carried over to the tool's folder. */
const wrapped = ["re-add", "add", "merge", "merge-all", "chattr", "forget", "edit"];

/** These don't fit a repo loadout keeps: each with what to run instead. */
const refused: Record<string, string> = {
  init: "the repo is set up already: chezmoi's source is the repo's dotfiles (loadout init scaffolds one)",
  update: "run: loadout sync",
  upgrade: "upgrade chezmoi with the machine's package manager (loadout upgrade)",
  purge: "it deletes chezmoi's source: remove the dotfiles from loadout.ts instead",
  git: "run git in the repo itself",
  destroy: "remove the file from its tool's folder, add it to .chezmoiremove, and run loadout apply-config",
  import: "unpack the archive into a tool's home/ or root/",
};

/**
 * newChezmoiCmd is `loadout chezmoi <command> [args…]`: chezmoi over this
 * repo's configs, from any checkout (`--repo`), as every other command runs
 * it (contract 17). With tool folders it also keeps chezmoi and the folders
 * in step: a path outside $HOME goes to the root source, and what a command
 * that writes the source (re-add, add, merge, chattr, forget) wrote into a
 * build is carried over to the tool's own folder.
 */
export function newChezmoiCmd(): Command {
  const cmd = subcommand(
    "chezmoi",
    commandHelp(
      "Run chezmoi over this repo's configs. With tool folders, a path outside $HOME goes to the / configs, and what re-add, add, merge, chattr and forget write lands in the tool's folder.",
      "--tool <name>  with add: the tool folder a new file goes into",
    ),
    [{ name: "args", help: "chezmoi's command and arguments", optional: true, multiple: true }],
    async (self, args) => {
      if (args.length === 0) {
        printHelp(self);
        return;
      }
      const code = await runChezmoi(args);
      if (code !== 0) throw exitWith(code < 0 ? 1 : code);
    },
  );
  cmd.passArgs = true;
  return cmd;
}

async function runChezmoi(given: string[]): Promise<number> {
  const a = appCtx();
  const configs = a.configs();
  if (configs === undefined) throw new engine.ConfigException("this repo has no configs (repo({ dotfiles }) in loadout.ts)");
  const [args, tool] = takeTool(given);
  const sub = args.find((x) => !x.startsWith("-"));
  if (sub !== undefined && refused[sub] !== undefined) throw new engine.ConfigException("loadout chezmoi " + sub + ": " + refused[sub]);
  if (tool !== undefined && sub !== "add") throw new engine.ConfigException("--tool is for add: the tool folder a new file goes into");

  const own = configs.sourceList().filter((s) => s.label === "this repo");
  const home = own.find((s) => s.root === undefined);
  const rootSource = own.find((s) => s.root !== undefined);
  const env = configs.environment();
  const root = a.canonicalRoot();
  const layout = a.layout();

  if (sub === "cd") {
    const where = layout.build !== undefined ? toolsBase(layout.build.tools) : layout.configs!;
    return a.runner.inherit({ line: 'exec "${SHELL:-sh}"', cwd: path.join(root, where), env: undefined });
  }

  // Which source each path goes to: outside $HOME is /'s.
  const userHome = envVar("HOME") ?? "";
  const after = sub === undefined ? [] : args.slice(args.indexOf(sub) + 1);
  const isRootPath = (x: string) => rootSource !== undefined && x.startsWith("/") && !inside(x, userHome);
  const isHomePath = (x: string) => !x.startsWith("-") && (x.startsWith("~") || x.startsWith("./") || x.startsWith("../") || (x.startsWith("/") && inside(x, userHome)));
  const rootPaths = after.filter(isRootPath);
  const homePaths = after.filter(isHomePath);
  let runHome = home !== undefined;
  let runRoot = rootSource !== undefined;
  if (rootPaths.length > 0 && homePaths.length === 0) runHome = false;
  else if (homePaths.length > 0 && rootPaths.length === 0) runRoot = false;
  else if (rootPaths.length === 0 && homePaths.length === 0 && !overBoth.includes(sub ?? "")) runRoot = false;
  if (home === undefined && !runRoot) throw new engine.ConfigException("this repo has no $HOME configs");

  const plan = wrapped.includes(sub ?? "") ? planBuild(root, layout) : undefined;
  if (tool !== undefined && plan !== undefined && !plan.tools.some((t) => t.name === tool)) {
    throw new engine.ConfigException("no tool folder " + tool + " (dotfiles' tools: " + layout.build!.tools + ")");
  }
  const before = plan === undefined ? undefined : snapshots(root, plan);

  let code = 0;
  if (runHome) {
    const homeArgs = args.filter((x) => !rootPaths.includes(x));
    if (sub === "source-path") code = await sourcePath(a.runner, engine.chezmoiLine(home!, env) + words(homeArgs), env);
    else code = await a.runner.inherit({ line: engine.chezmoiLine(home!, env) + words(homeArgs), cwd: "", env });
  }
  if (runRoot && code === 0) {
    const rootArgs = args.filter((x) => !homePaths.includes(x));
    if (sub === "apply") code = await applyRoot(configs, rootPaths, rootArgs.filter((x) => x !== "apply" && !rootPaths.includes(x)));
    else if (sub === "source-path") code = await sourcePath(a.runner, engine.chezmoiLine(rootSource!, env) + words(rootArgs), env);
    else code = await a.runner.inherit({ line: engine.chezmoiLine(rootSource!, env) + words(rootArgs), cwd: "", env });
  }

  if (plan !== undefined && before !== undefined && !carry(root, plan, before, tool) && code === 0) code = 1;
  return code;
}

/** rootApplyRefused is apply's flags the / configs can't take: their two passes choose what's applied. */
const rootApplyRefused = ["--include", "-i", "--exclude", "-x"];

/**
 * applyRoot is `apply` for the / configs: as root, folders already there
 * left alone (ConfigEngine.applyCommand), with the user's flags (--dry-run,
 * --verbose, --force…) on both passes.
 */
async function applyRoot(configs: engine.ConfigEngine, paths: string[], flags: string[]): Promise<number> {
  const a = appCtx();
  const refused = flags.find((f) => rootApplyRefused.some((r) => f === r || f.startsWith(r + "=")));
  if (refused !== undefined) throw new engine.ConfigException("loadout chezmoi apply: " + refused + " doesn't go with the / configs: name their files instead");
  const targets = (await configs.units()).flatMap((u) => u.targets).filter((t) => t.startsWith("/") && (paths.length === 0 || paths.includes(t)));
  if (targets.length === 0) return 0;
  await askForSudoUpfront(a.runner, await configs.rootNeedsSudo(targets));
  const apply = await configs.applyCommand(targets, flags.includes("--force"), flags.filter((f) => f !== "--force"));
  return apply.line === "true" ? 0 : a.runner.inherit(apply);
}

/** sourcePath prints chezmoi's source path, a build's symlink resolved: the file in the tool's folder. */
async function sourcePath(runner: import("../core/exec/index.ts").ProcessRunner, line: string, env: Record<string, string> | undefined): Promise<number> {
  const result = await runner.capture({ line, cwd: "", env });
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    return result.exitCode;
  }
  for (const l of result.stdout.split("\n")) {
    if (l === "") continue;
    let shown = l;
    try {
      if (fs.lstatSync(l).isSymbolicLink()) shown = fs.realpathSync(l);
    } catch {
      // Not there: as chezmoi said it.
    }
    echo(shown);
  }
  return 0;
}

function snapshots(root: string, plan: Plan): Map<"home" | "root", Snapshot> {
  const out = new Map<"home" | "root", Snapshot>();
  for (const b of [plan.home, plan.root]) if (b !== undefined) out.set(b.side, snapshot(root, b));
  return out;
}

/**
 * carry brings what the chezmoi command did over to the tool folders
 * (configbuild.carryOver), says what moved, and rebuilds. False when
 * something is left for the user: a new file from no tool, or a build
 * still off.
 */
function carry(root: string, plan: Plan, before: Map<"home" | "root", Snapshot>, tool: string | undefined): boolean {
  const done = carryOver(root, plan, before, tool);
  for (const line of done.done) echo(" " + Style.ok("✔") + "  " + line);
  if (done.homeless.length > 0) {
    echoErr(
      " " + Style.error("✘") + "  from no tool: " + done.homeless.join(", ") +
        " — add it with `loadout chezmoi add --tool <tool> …`, or move it into a tool's home/ or root/",
    );
    return false;
  }
  const fresh = planBuild(root, appCtx().layout());
  if (fresh === undefined) return true;
  writeBuild(root, fresh);
  const left = driftMessage(drift(root, fresh));
  if (left !== undefined) echoErr(" " + Style.warn("!") + "  " + left);
  return left === undefined;
}

/** takeTool is args without `--tool <name>` (or `--tool=<name>`), and the name. */
function takeTool(args: string[]): [string[], string | undefined] {
  const out: string[] = [];
  let tool: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!;
    if (x === "--tool") {
      tool = args[++i];
      if (tool === undefined) throw new engine.ConfigException("--tool needs a tool folder's name");
    } else if (x.startsWith("--tool=")) tool = x.slice("--tool=".length);
    else out.push(x);
  }
  return [out, tool];
}

/** toolsBase is the folder the tools glob starts in (`loadouts/*` → `loadouts`). */
function toolsBase(glob: string): string {
  const segs = glob.split("/");
  const i = segs.findIndex((s) => s.includes("*") || s.includes("?"));
  return i <= 0 ? "." : segs.slice(0, i).join("/");
}

function inside(p: string, dir: string): boolean {
  return dir !== "" && (p === dir || p.startsWith(dir.replace(/\/$/, "") + "/"));
}

function words(args: readonly string[]): string {
  return args.map((x) => " '" + x.replaceAll("'", `'\\''`) + "'").join("");
}
