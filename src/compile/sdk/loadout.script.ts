// loadout's script SDK, imported as "loadout/script". Like the manifests'
// SDK, it is part of loadout: the bun wrapper's preload registers it when
// loadout runs a script, and its types are in the repo's node_modules/@types/loadout. A
// script stays any executable; this is for the ones in TypeScript
// (`#!/usr/bin/env bun`, run with the bun loadout brings).
//
// It holds loadout's protocols, so a script speaks them as the binary that
// runs it expects: a managed script's `check`/`install` (`main`), an
// outdated oracle's rows and `update <item>` (`oracle`), a program's own
// outdated check (`programOracle`), the LOADOUT_* environment (`env`); and
// helpers that make commands as terse as sh's. Commands are Bun Shell's
// $`…`: each ${value} is one argument, quoted for you, and a command that
// fails throws, with its output.
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { $ } from "bun";
export { $ };

// ─── the environment loadout runs a script in ───────────────────────────

/** What loadout sets for every command it runs (contract 5); a getter throws when it isn't set. */
export const env = {
  /** The repo's root (`LOADOUT_REPO`); a parent's declarations see the parent's. */
  get repo() {
    return need("LOADOUT_REPO");
  },
  /** The folder of the file that declared what runs (`LOADOUT_FRAGMENT_DIR`). */
  get fragmentDir() {
    return need("LOADOUT_FRAGMENT_DIR");
  },
  /** The machine loadout runs as (`LOADOUT_MACHINE`). */
  get machine() {
    return need("LOADOUT_MACHINE");
  },
  /** `linux` or `macos` (`LOADOUT_OS`). */
  get os() {
    return need("LOADOUT_OS") as "linux" | "macos";
  },
  /** chezmoi's source folder, when the repo holds dotfiles (`LOADOUT_CONFIGS`). */
  get configs(): string | undefined {
    return process.env.LOADOUT_CONFIGS || undefined;
  },
  /** A child repo's parent checkout (`LOADOUT_PARENT`). */
  get parent(): string | undefined {
    return process.env.LOADOUT_PARENT || undefined;
  },
};

function need(name: string): string {
  return process.env[name] || fail(`${name} isn't set: run this through loadout`);
}

/** path in the repo loadout runs (`$LOADOUT_REPO`). */
export const repoPath = (path: string) => join(env.repo, path);

// ─── a managed script, and one with its check inline ───────────────────

type Step = (...args: string[]) => Promise<unknown> | unknown;

/**
 * A managed script (`managedBy: "x.ts"`): `check [args…]` exits 0 when it's
 * done, 1 when not (a check that throws isn't done, and says why);
 * `[install] [args…]` does it, and a failure exits 1 with its message. The
 * machine's arguments reach both.
 */
export async function main(check: (...args: string[]) => Promise<boolean> | boolean, install: Step) {
  const argv = Bun.argv.slice(2);
  const mode = argv[0] === "check" || argv[0] === "install" ? argv.shift() : "install";
  try {
    if (mode === "check") process.exit((await check(...argv)) ? 0 : 1);
    await install(...argv);
  } catch (error) {
    fail(reason(error));
  }
}

/**
 * A script with no check of its own (a manifest's `file`, its check
 * inline): runs step with the arguments, and a failure exits 1 with its
 * message.
 */
export async function run(step: Step) {
  try {
    await step(...Bun.argv.slice(2));
  } catch (error) {
    fail(reason(error));
  }
}

// ─── outdated oracles ───────────────────────────────────────────────────

/**
 * One thing that's behind, as an outdated source reports it: loadout reads
 * `<item> <current> <candidate> [note…]`, and a URL at the end of the note
 * is the row's link (opened with `K` on the home screen).
 */
export type Row = { item: string; current: string; candidate: string; note?: string; link?: string };

/** row as loadout reads it, one line. */
export const formatRow = (row: Row) => [row.item, row.current, row.candidate, row.note, row.link].filter(Boolean).join(" ");

/**
 * An outdated source (`updatesManagedBy: "x.ts"` on a script, or an
 * oracle's command): with no arguments it prints a row per thing that's
 * behind; `update <item>` moves that one. A failure exits 1 with its
 * message, which loadout shows as the source having failed: a broken
 * oracle never reads as "nothing outdated".
 */
export async function oracle(spec: { rows: () => Promise<Row[]> | Row[]; update: (item: string) => Promise<unknown> | unknown }) {
  const [mode, item, ...rest] = Bun.argv.slice(2);
  try {
    if (mode === undefined) {
      for (const row of await spec.rows()) console.log(formatRow(row));
      return;
    }
    if (mode !== "update" || !item || rest.length) throw new Error("usage: <oracle> [update <item>]");
    await spec.update(item);
  } catch (error) {
    fail(reason(error));
  }
}

/**
 * A program's own outdated check (`updatesManagedBy: "x.ts"` on a
 * program): with no arguments it prints the newest version when this one is
 * behind, nothing otherwise; `update` moves it.
 */
export async function programOracle(spec: { latest: () => Promise<string | undefined> | string | undefined; update: () => Promise<unknown> | unknown }) {
  const [mode, ...rest] = Bun.argv.slice(2);
  try {
    if (mode === undefined) {
      const latest = await spec.latest();
      if (latest) console.log(latest);
      return;
    }
    if (mode !== "update" || rest.length) throw new Error("usage: <oracle> [update]");
    await spec.update();
  } catch (error) {
    fail(reason(error));
  }
}

// ─── clones that track their remote ─────────────────────────────────────

/** A clone and the name its row goes by. */
export type Clone = { name: string; dir: string };

/** git's output, trimmed, or undefined when it fails. */
async function git(dir: string, ...args: string[]) {
  const result = await $`git -C ${dir} ${args}`.quiet().nothrow();
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

/** https://github.com/owner/repo for a GitHub origin (ssh or https), else undefined. */
async function githubOf(dir: string) {
  const url = await git(dir, "remote", "get-url", "origin");
  const m = url?.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}` : undefined;
}

/**
 * The row of a clone whose HEAD is behind its remote's: `<name> <head>
 * <tip> N commit(s) behind`, the shas cut to 9. undefined when it's up to
 * date, provably ahead (a pin on a non-default branch), or its fetch fails.
 * A shallow clone still compares shas, without the count. A GitHub origin
 * adds the compare page of the two shas as the link. Leaves FETCH_HEAD at
 * the remote's HEAD.
 */
async function rowOf({ name, dir }: Clone): Promise<Row | undefined> {
  const head = await git(dir, "rev-parse", "HEAD");
  if (!head || (await git(dir, "fetch", "-q", "origin", "HEAD")) === undefined) return undefined;
  const tip = await git(dir, "rev-parse", "FETCH_HEAD");
  if (!tip || tip === head) return undefined;
  const behind = await git(dir, "rev-list", "--count", `${head}..FETCH_HEAD`);
  if (behind === "0") return undefined;
  const github = await githubOf(dir);
  return {
    item: name,
    current: head.slice(0, 9),
    candidate: tip.slice(0, 9),
    note: behind ? `${behind} commit(s) behind` : undefined,
    link: github && `${github}/compare/${head.slice(0, 9)}...${tip.slice(0, 9)}`,
  };
}

/** A row per clone that's behind its remote's HEAD, by name; all fetched at once. What isn't a clone is skipped. */
export async function clonesBehind(clones: Clone[]): Promise<Row[]> {
  const rows = await Promise.all(clones.filter(({ dir }) => existsSync(`${dir}/.git`)).map(rowOf));
  return rows.filter((row): row is Row => row !== undefined).sort((a, b) => (formatRow(a) < formatRow(b) ? -1 : formatRow(a) > formatRow(b) ? 1 : 0));
}

/** Fast-forwards the clone to its remote; one that can't fails rather than rewriting history. */
export async function fastForward({ name, dir }: Clone) {
  if (!existsSync(`${dir}/.git`)) throw new Error(`no clone named '${name}' here`);
  console.log(`updating ${name} (${dir})`);
  await $`git -C ${dir} pull --ff-only`;
}

// ─── helpers ────────────────────────────────────────────────────────────

/** Is it on PATH? (sh's `command -v`) */
export const has = (program: string) => Bun.which(program) !== null;

/** Print to stderr and exit 1. */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Its output, trimmed; throws when it fails. */
export const out = async (command: ReturnType<typeof $>) => (await command.quiet().text()).trim();

/** Did it succeed? Its output is discarded. */
export const ok = async (command: ReturnType<typeof $>) => (await command.quiet().nothrow()).exitCode === 0;

/**
 * A file's text, or "" when there's none. Node's readFile, not Bun.file: a
 * Bun.file that was stat'ed first reads only the size the stat gave, and
 * /proc files say 0.
 */
export const read = (path: string): Promise<string> => readFile(path, "utf8").catch(() => "");

/** A file's text as `$(cat file)` reads it: trailing newlines dropped, "" when there's none. */
export const readTrimmed = async (path: string) => (await read(path)).replace(/\n+$/, "");

/** Can this user run path? (sh's `[ -x path ]`) */
export function executable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * text into path as root, with mode, its folder made: through a private temp
 * file and `sudo install`, never stdin (a Bun Shell redirect can't be opened
 * as /dev/stdin).
 */
export async function sudoWrite(path: string, text: string, mode = "644") {
  const dir = await mkdtemp(join(tmpdir(), "loadout-"));
  try {
    await Bun.write(join(dir, "file"), text);
    await $`sudo install -D -m ${mode} ${join(dir, "file")} ${path}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Re-run test() until it's true; fails after tries * every seconds. */
export async function waitUntil(test: () => Promise<boolean>, what = "it", every = 10, tries = 360) {
  for (let i = 0; i < tries; i++) {
    if (await test()) return;
    await Bun.sleep(every * 1000);
  }
  fail(`${what} didn't happen in time`);
}

/**
 * file's path in its repo's main checkout, for a script that writes its own
 * path into a file outside the repo (a hook, a command wrapper). Run from a
 * feature worktree, its own path dies with the worktree once the feature
 * merges, and the hook then fails silently on every call. The cost: while a
 * feature is tried, the hook runs the main checkout's copy, not the
 * feature's. file as an absolute path when it isn't in a worktree, or when
 * the main checkout has no copy yet (a script new to the feature): its
 * check, run from the main checkout after the merge, sees the path differ
 * and installs again.
 */
export async function mainCheckoutPath(file: string): Promise<string> {
  const dir = realpathSync(dirname(file));
  const own = join(dir, basename(file));
  const top = await $`git -C ${dir} rev-parse --show-toplevel`.quiet().nothrow();
  const common = await $`git -C ${dir} rev-parse --path-format=absolute --git-common-dir`.quiet().nothrow();
  if (top.exitCode !== 0 || common.exitCode !== 0) return own;
  const commonDir = common.stdout.toString().trim();
  // A non-bare main checkout keeps the common git dir as its .git.
  if (basename(commonDir) !== ".git") return own;
  const main = dirname(commonDir) + own.slice(top.stdout.toString().trim().length);
  return (await Bun.file(main).exists()) ? main : own;
}

/** What went wrong, as one line a user reads: a failed command's stderr. */
export function reason(error: unknown): string {
  if (error instanceof $.ShellError) {
    return error.stderr.toString().trim() || error.stdout.toString().trim() || `exited ${error.exitCode}`;
  }
  return error instanceof Error ? error.message : String(error);
}
