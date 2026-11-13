import type { SystemInfo } from "../coremodel/coremodel.ts";
import { envVar } from "../platform/platform.ts";
import { bunDirVar, isParentOrigin, originFolder } from "../../model/index.ts";
import type { ShellCommand } from "./exec.ts";

/** FrameParent is a child repo's parent checkout and its commands' variables. */
export interface FrameParent {
  root: string;
  env: Record<string, string>;
}

/**
 * CommandFrame is how manifest commands run (contract 5): in the directory
 * of the file that declared them (its repo-relative origin), with the
 * `LOADOUT_*` variables. In a child repo (contract 18) a parent's
 * declaration (model.originParent) runs in the parent's checkout with the
 * parent's `LOADOUT_REPO` and `LOADOUT_CONFIGS`, as it would in the parent
 * itself. A frame without a repo root (unit tests) runs in the caller's
 * directory with only the variables it was given.
 */
export class CommandFrame {
  /**
   * repoRoot is the absolute repo root, or "" for "the caller's directory";
   * parent is a child repo's parent: where its declarations run, and what
   * they see instead of env.
   */
  constructor(
    private readonly repoRoot: string,
    private readonly env: Record<string, string> | undefined,
    private readonly parent: FrameParent | undefined,
  ) {}

  /** cwd is where a command of origin runs, or "" for the caller's directory. */
  cwd(origin: string): string {
    let root = this.repoRoot;
    if (isParentOrigin(origin) && this.parent !== undefined) root = this.parent.root;
    if (root === "") return "";
    const folder = originFolder(origin);
    if (folder === "") return root;
    return root + "/" + folder;
  }

  /** command is line, declared at origin, in this frame. */
  command(line: string, origin: string): ShellCommand {
    const cwd = this.cwd(origin);
    let vars = this.env;
    if (isParentOrigin(origin) && this.parent !== undefined) vars = this.parent.env;
    let env = vars === undefined ? undefined : { ...vars };
    if (cwd !== "") {
      env ??= {};
      env["LOADOUT_FRAGMENT_DIR"] = cwd;
    }
    return { line, cwd, env };
  }
}

/**
 * newCommandFrame is a frame over repoRoot ("" = the caller's directory)
 * with env, and parent for a child repo (undefined otherwise).
 */
export function newCommandFrame(repoRoot: string, env: Record<string, string> | undefined, parent: FrameParent | undefined): CommandFrame {
  return new CommandFrame(repoRoot, env, parent);
}

/**
 * frameOf is the frame for system in the repo at absolute repoRoot, with its
 * `layout configs` (undefined: none); for a child repo, also its parent's
 * absolute parentRoot ("" for none) and configs. bunDir is the folder of
 * the `bun` manifest commands run (core/bun: loadout's wrapper, or
 * $LOADOUT_BUN's; "" for none, in tests): first on PATH, and in
 * LOADOUT_BUN_DIR for the lines that put folders of their own first
 * (model.shellLine).
 */
export function frameOf(
  repoRoot: string,
  system: SystemInfo,
  configs: string | undefined,
  parentRoot: string,
  parentConfigs: string | undefined,
  bunDir: string,
): CommandFrame {
  const common: Record<string, string> = {
    LOADOUT_MACHINE: system.machine,
    LOADOUT_OS: system.os,
  };
  if (bunDir !== "") {
    common[bunDirVar] = bunDir;
    common["PATH"] = bunDir + ":" + (envVar("PATH") ?? "");
  }
  // Every command of a child sees its parent: a parent program's `file`
  // value runs in whichever repo's installer takes it.
  if (parentRoot !== "") common["LOADOUT_PARENT"] = parentRoot;
  const repoEnv = (root: string, configs: string | undefined): Record<string, string> => {
    const env: Record<string, string> = { ...common, LOADOUT_REPO: root };
    if (configs !== undefined) env["LOADOUT_CONFIGS"] = root + "/" + configs;
    return env;
  };
  const parent = parentRoot !== "" ? { root: parentRoot, env: repoEnv(parentRoot, parentConfigs) } : undefined;
  return new CommandFrame(repoRoot, repoEnv(repoRoot, configs), parent);
}
