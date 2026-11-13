import * as fs from "node:fs";
import * as nodePath from "node:path";
import { entryFile, scriptSDK, scriptSDKFile, sdk, sdkFile } from "../compile/compile.ts";
import { newGitClient } from "../core/git/git.ts";
import { envVar } from "../core/platform/platform.ts";
import { cleanPath, compareStrings, goPathError, isAbsPath, joinPath, lockFileName } from "../model/index.ts";
import type { Command } from "./args.ts";
import { type CliContext, detectSystem } from "./context.ts";
import { exitWith } from "./errors.ts";
import { boolFlag, commandHelp, stringFlag } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { scaffoldTexts } from "./scaffold.ts";
import { echo } from "./spinner.ts";
import { Style } from "./style.ts";

// The scaffolds `init` writes, one folder per kind of repo: init (programs/
// and maintenance/), init-configs (everything in loadouts/, chezmoi's
// source, each tool's manifest where its files land), child and
// child-configs (contract 18: a parent block, no example that could clash).
// File names and contents are templates over ScaffoldVars ({{.Hostname}}
// and the like, as Go's text/template wrote them). Every scaffold gets the
// SDKs too (sdkFile, scriptSDKFile), so the editor has the manifests' and
// scripts' types before the first compile.

/** ScaffoldVars is what a scaffold's templates fill in. */
export interface ScaffoldVars {
  hostname: string;
  parentName: string;
  parentPath: string;
  /**
   * parentImport is the parent's checkout from the child's root, for
   * tsconfig.json's "parent/*" alias.
   */
  parentImport: string;
}

/** jsString is s escaped for the inside of a double-quoted TypeScript (and JSON) string literal. */
export function jsString(s: string): string {
  const escapes: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };
  return s.replace(/[\\"\n\r\t]/g, (c) => escapes[c]!);
}

/** ScaffoldFile is one file of a scaffold, rendered: its path in the repo and its content. */
export interface ScaffoldFile {
  path: string;
  content: string;
}

/**
 * walkOrder is Go's fs.WalkDir order: a folder's entries by name, each
 * folder's files where its name sorts.
 */
function walkOrder(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const c = compareStrings(as[i]!, bs[i]!);
    if (c !== 0) return c;
  }
  return as.length - bs.length;
}

/**
 * renderScaffold is the files of scaffold kind for vars, and the SDK. Paths
 * take the values as they are; contents take them escaped, since every
 * value lands inside a string.
 */
export function renderScaffold(kind: string, vars: ScaffoldVars): ScaffoldFile[] {
  const escaped: ScaffoldVars = {
    hostname: jsString(vars.hostname),
    parentName: jsString(vars.parentName),
    parentPath: jsString(vars.parentPath),
    parentImport: jsString(vars.parentImport),
  };
  const texts = scaffoldTexts[kind];
  if (texts === undefined) throw new Error(`open scaffold/${kind}: file does not exist`);
  const files = Object.keys(texts)
    .sort(walkOrder)
    .map((p) => ({ path: fill(p, vars), content: fill(texts[p]!, escaped) }));
  files.push({ path: sdkFile, content: sdk }, { path: scriptSDKFile, content: scriptSDK });
  return files;
}

/** The template fields, as the scaffolds spell them. */
const fields: Record<string, keyof ScaffoldVars> = {
  Hostname: "hostname",
  ParentName: "parentName",
  ParentPath: "parentPath",
  ParentImport: "parentImport",
};

/** fill is text with every `{{.Field}}` replaced by its value; any other action is an error. */
function fill(text: string, vars: ScaffoldVars): string {
  return text.replace(/\{\{(.*?)\}\}/gs, (action, inner: string) => {
    const m = /^\s*\.(\w+)\s*$/.exec(inner);
    const key = m ? fields[m[1]!] : undefined;
    if (key === undefined) throw new Error(`template: can't fill ${action}`);
    return vars[key];
  });
}

/** newInitCmd is `loadout init`. */
export function newInitCmd(): Command {
  const cmd = subcommand(
    "init",
    commandHelp(
      "Scaffold a new config repo (TypeScript manifests, machines/state/) and git init it.",
      "[path]     where to scaffold (default: current directory)",
      "--configs  hold your dotfiles too: chezmoi's source in loadouts/, each tool's manifest where its files land",
      "--parent   a child repo of the compiled repo at this path: uses its declarations by name",
      "--name     what the child calls its parent (default: parent)",
    ),
    [{ name: "path", help: "Where to create the repo", optional: true }],
    async (_cmd, args, flags) => {
      const root = args.length === 1 ? args[0]! : ".";
      const configs = flags.bool("configs");
      if (flags.changed("parent")) return initChild(appCtx(), root, flags.string("parent"), flags.string("name"), configs);
      return initRepo(appCtx(), root, configs);
    },
  );
  boolFlag(cmd, "configs", "", "Hold dotfiles too (chezmoi's source in loadouts/, each tool's manifest where its files land)");
  stringFlag(cmd, "parent", "", "", "Scaffold a child repo of the compiled repo at this path");
  stringFlag(cmd, "name", "", "parent", "What the child calls its parent");
  return cmd;
}

/** mkdirAll is Go's os.MkdirAll, its errors worded as Go's. */
function mkdirAll(p: string): void {
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(p);
  } catch {
    st = undefined;
  }
  if (st !== undefined) {
    if (st.isDirectory()) return;
    throw new Error(`mkdir ${p}: not a directory`);
  }
  let i = p.length;
  while (i > 0 && p[i - 1] === "/") i--;
  let j = i;
  while (j > 0 && p[j - 1] !== "/") j--;
  if (j > 1) mkdirAll(p.slice(0, j - 1));
  try {
    fs.mkdirSync(p, { mode: 0o755 });
  } catch (e) {
    try {
      if (fs.lstatSync(p).isDirectory()) return;
    } catch {
      // Not there: Mkdir's error stands.
    }
    throw goPathError(e, "mkdir", p);
  }
}

/** exists says whether p can be stat'ed (Go's os.Stat without an error). */
function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** writeScaffold refuses to overwrite anything a scaffold would write (the lock included), then writes it. */
export function writeScaffold(root: string, files: readonly ScaffoldFile[]): void {
  const existing = [entryFile, lockFileName];
  for (const f of files) {
    if (nodePath.posix.basename(f.path) !== ".gitkeep" && !existing.includes(f.path)) existing.push(f.path);
  }
  for (const name of existing) {
    if (exists(joinPath(root, name))) {
      echo("error: " + joinPath(root, name) + " already exists; refusing to overwrite.");
      throw exitWith(1);
    }
  }
  for (const f of files) {
    const target = joinPath(root, f.path);
    mkdirAll(nodePath.dirname(target));
    try {
      fs.writeFileSync(target, f.content, { mode: 0o644 });
    } catch (e) {
      throw goPathError(e, "open", target);
    }
  }
}

/** initRepo scaffolds a config repo at root and git inits it. */
export async function initRepo(a: CliContext, root: string, configs: boolean): Promise<void> {
  const kind = configs ? "init-configs" : "init";
  const files = renderScaffold(kind, { hostname: detectSystem(a).machine, parentName: "", parentPath: "", parentImport: "" });
  writeScaffold(root, files);
  let example = "programs/cli.loadout.ts";
  let parts = ["loadout.ts", "programs/", "maintenance/"];
  if (configs) {
    example = "loadouts/private_dot_config/.ripgrep.loadout.ts";
    parts = ["loadout.ts", "loadouts/ (chezmoi's source)"];
  }
  parts.push("machines/ (machines.loadout.ts, data.ts, state/)", "tsconfig.json");
  echo("Created " + root + ": " + parts.join(", "));

  const repo = newGitClient(a.runner, root);
  if (await repo.isRepo()) {
    echo("Already inside a git repository; skipping git init.");
  } else {
    await repo.init();
    echo("Initialized git repository.");
  }

  echo("");
  echo(Style.header("Next steps:"));
  echo("  1. Open " + root + " in your editor (bun install there gives it bun's types) and add");
  echo("     programs and scripts (*.loadout.ts files, beside " + example + ")");
  if (configs) {
    echo("     (a tool's file sits where its files land; what lands outside your home");
    echo("     in loadouts/.etc/<concern>/, like loadouts/.etc/dnf/)");
  }
  echo("  2. Say what this machine installs in machines/machines.loadout.ts");
  echo("  3. loadout --repo " + root + " compile   # writes " + lockFileName);
  if (configs) {
    echo("     (and loadouts/.chezmoidata/loadout.json + .chezmoitemplates/loadout/machine:");
    echo('     templates read this machine\'s data with includeTemplate "loadout/machine" . | fromJson)');
  }
  echo("  4. loadout --repo " + root + " status");
  echo("  5. Commit (the lock too), add a remote and push, then clone it on your other machines");
}

/**
 * getwd is Go's os.Getwd: $PWD when it names the current directory (the
 * path as the user's shell spells it, symlinks kept), else the real one.
 */
function getwd(): string {
  const pwd = envVar("PWD");
  if (pwd !== undefined && pwd.startsWith("/")) {
    try {
      const a = fs.statSync(pwd);
      const b = fs.statSync(".");
      if (a.dev === b.dev && a.ino === b.ino) return pwd;
    } catch {
      // fall back to the real path
    }
  }
  return process.cwd();
}

/** absPath is Go's filepath.Abs. */
function absPath(p: string): string {
  return isAbsPath(p) ? cleanPath(p) : joinPath(getwd(), p);
}

/** relPath is Go's filepath.Rel for two absolute, clean paths. */
function relPath(base: string, target: string): string {
  return nodePath.posix.relative(base, target) || ".";
}

/**
 * initChild scaffolds a child repo of the compiled repo at parentPath: its
 * repo block names the parent, its machine uses the parent's names as they
 * are, and it has no example program that could clash.
 */
export async function initChild(a: CliContext, root: string, parentPath: string, parentName: string, configs: boolean): Promise<void> {
  const parentRoot = isAbsPath(parentPath) ? parentPath : joinPath(getwd(), parentPath);
  if (!exists(joinPath(parentRoot, lockFileName))) {
    echo("error: parent " + parentPath + " has no " + lockFileName + " — compile it first");
    throw exitWith(1);
  }
  const kind = configs ? "child-configs" : "child";
  const hostname = detectSystem(a).machine;
  const childRoot = absPath(root);
  const parentImport = relPath(childRoot, cleanPath(parentRoot));
  // The repo's parent path is read from the child's root: a relative one
  // given from here is rewritten from there.
  let repoParentPath = parentPath;
  if (!isAbsPath(parentPath) && parentPath !== "~" && !parentPath.startsWith("~/")) repoParentPath = parentImport;
  const files = renderScaffold(kind, { hostname, parentName, parentPath: repoParentPath, parentImport });
  writeScaffold(root, files);
  echo("Created " + root + ": a child repo of " + parentName + " (" + parentPath + ")");
  const repo = newGitClient(a.runner, root);
  if (!(await repo.isRepo())) await repo.init();
  echo("");
  echo(Style.header("Next steps:"));
  echo("  1. Say what this machine installs in machines/" + hostname + ".loadout.ts (import " + parentName + "'s from \"parent/…\")");
  echo("  2. loadout --repo " + root + " compile");
  echo("  3. Point LOADOUT_REPO at " + root + " on this machine, then: loadout status");
}
