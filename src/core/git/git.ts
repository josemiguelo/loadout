// Package git is the config repo's git, through the `git` binary.

import { Refusal, trimSpace } from "../../model/index.ts";
import { type ExecResult, line, type ProcessRunner, success } from "../exec/exec.ts";

/** GitException is a git command that failed. */
export class GitException extends Refusal {}

/** GitClient is a thin wrapper over the `git` binary, always operating on the config repo. */
export class GitClient {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly repoRoot: string,
  ) {}

  private git(args: string): Promise<ExecResult> {
    return this.runner.capture(line("git " + args, this.repoRoot));
  }

  private async require(args: string, what: string): Promise<void> {
    const result = await this.git(args);
    if (!success(result)) {
      let detail = trimSpace(result.stderr);
      if (detail === "") detail = trimSpace(result.stdout);
      throw new GitException(`git ${what} failed (exit ${result.exitCode}): ${detail}`);
    }
  }

  /** isRepo says whether the repo root is inside a git work tree. */
  async isRepo(): Promise<boolean> {
    return success(await this.git("rev-parse --is-inside-work-tree"));
  }

  /** hasUpstream says whether the current branch tracks a remote one. */
  async hasUpstream(): Promise<boolean> {
    return success(await this.git("rev-parse --abbrev-ref @{upstream}"));
  }

  /** init makes the repo root a git repo. */
  init(): Promise<void> {
    return this.require("init", "init");
  }

  /** pullRebase pulls with a rebase, stashing local edits around it. */
  pullRebase(): Promise<void> {
    return this.require("pull --rebase --autostash", "pull");
  }

  /** addCommit stages paths and commits them; false when nothing changed. */
  async addCommit(paths: readonly string[], message: string): Promise<boolean> {
    for (const path of paths) await this.require("add '" + path + "'", "add");
    if (success(await this.git("diff --cached --quiet"))) return false;
    await this.require("commit -m '" + message.replaceAll("'", `'\\''`) + "'", "commit");
    return true;
  }

  /** push pushes the current branch. */
  push(): Promise<void> {
    return this.require("push", "push");
  }
}

/** newGitClient is the git of the repo at repoRoot (Go's git.New). */
export function newGitClient(runner: ProcessRunner, repoRoot: string): GitClient {
  return new GitClient(runner, repoRoot);
}
