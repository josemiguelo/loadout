// loadout's types: the modules manifests import as "loadout" and TypeScript
// scripts as "loadout/script". The modules themselves are inside loadout,
// which provides them whenever it runs this repo's files. Written by
// `loadout compile` (and `loadout init`) from the loadout that compiles the
// repo: don't edit it, a compile puts it back.

declare module "loadout" {
  export type Installer = {
    readonly kind: "installer";
    readonly name: string;
  };
  export type Program = {
    readonly kind: "program";
    readonly name: string;
  };
  export type Script = {
    readonly kind: "script";
    readonly name: string;
  };
  export type Profile = {
    readonly kind: "profile";
    readonly name: string;
  };
  /** A program through one of its variants: `variant(setupBrew, "linux")`. */
  export type ProgramVariant = {
    readonly kind: "program-variant";
    readonly program: Program;
    readonly variant: string;
  };
  /** A script through one of its variants: `variant(hidAppleKeyboard, "arch")`. */
  export type ScriptVariant = {
    readonly kind: "script-variant";
    readonly script: Script;
    readonly variant: string;
  };
  /** A script with its arguments: `args(setupSsh, "id_ed25519")`. */
  export type ScriptArgs = {
    readonly kind: "script-args";
    readonly script: Script | ScriptVariant;
    readonly args: string[];
  };
  /** Programs through an installer, in a machine: `via(omarchy, [curl, git])`. */
  export type ViaGroup = {
    readonly kind: "via-group";
    readonly installer: Installer;
    readonly programs: Program[];
  };
  /** One, or a list of them, nested as deep as shared lists nest: flattened wherever it's read. */
  export type Many<T> = T | readonly Many<T>[];
  /** The built-in installers: shipped with loadout, `loadout installers` lists them. */
  export const apt: Installer;
  export const brew: Installer;
  export const brewCask: Installer;
  export const dnf: Installer;
  export const dnfCopr: Installer;
  export const dnfRepo: Installer;
  export const flatpak: Installer;
  export const omarchy: Installer;
  export const omarchyAur: Installer;
  export const pacman: Installer;
  type Place = {
    file: string;
    line: string;
    col: string;
  };
  /**
   * A repo file as a command (`runScript(".loadout/x.ts check")`) or a param
   * value (`file("repos/x.repo")`): its path from the declaring file's folder,
   * run with the interpreter its `#!` line names.
   */
  export const runScript: (command: string) => string;
  export const file: (path: string) => string;
  export type InstallerSpec = {
    /** The binary whose presence says the installer is there. */
    probe?: string;
    /** Names a program's variant gives values for (`params = { tap = … }`), `{name}` in the commands. */
    params?: string[];
    install?: string;
    check?: string;
    regex?: string;
    outdated?: string;
    outdatedAll?: string;
    upgrade?: string;
    needsSudo?: boolean;
    spare?: string;
  };
  export function installer(name: string, spec: InstallerSpec): Installer;
  /** Every install through installer waits for these programs. */
  export function requires(installer: Installer, programs: Many<Program>): void;
  /** How one variant installs, checks and is reached, beyond what its installer says. */
  export type VariantSpec = {
    /** The package name, when it isn't the program's. */
    pkg?: string;
    /** Values for the installer's params (`{ tap: "tmuxpack/tpack" }`); `file("x.repo")` for a repo file. */
    params?: Record<string, string>;
    /** Its own install command line; or installedBy / managedBy for a repo script. */
    command?: string;
    /** A repo script that installs it; `version` checks it. */
    installedBy?: string;
    /** A repo script with `check` and `install` modes; the check is presence unless `regex` reads a version from it. */
    managedBy?: string;
    /** A command printing the version (read by `regex`). */
    version?: string;
    /** A command that passes when it's installed (no version). */
    present?: string;
    regex?: string;
    probe?: string;
    outdated?: string;
    needsSudo?: boolean;
    dependsOn?: Many<Program>;
    /** Binaries it puts on PATH, and where: `{ brew: { at: "/opt/homebrew/bin" } }`. */
    provides?: Record<string, {
      at?: string;
    }>;
    spare?: string;
  };
  type VariantEntry = {
    readonly kind: "variant";
    readonly key: string;
    readonly spec: VariantSpec;
    readonly at: Place;
  };
  /** A variant through installer that needs a setting: `via(brewTapCask, { params: { tap: "…" } })`. */
  export function via(installer: Installer, spec: VariantSpec): VariantEntry;
  /** In a machine: programs through installer, `via(omarchy, [curl, git])`. */
  export function via(installer: Installer, programs: Many<Program>[]): ViaGroup;
  /** Its own way to install (`custom("linux", {...})`); named "custom" when unnamed. */
  export function custom(name: string, spec: VariantSpec): VariantEntry;
  export function custom(spec: VariantSpec): VariantEntry;
  export type ProgramSpec = {
    description?: string;
    tags?: string[];
    dependsOn?: Many<Program>;
    /** Its ways to install, in order: installers as they are (`brew`), `via(...)`, `custom(...)`. */
    install: (Installer | VariantEntry)[];
    /** A version check every variant falls back to. */
    version?: string;
    regex?: string;
    /** Folders put first on PATH for its commands. */
    path?: string[];
    /** Its own outdated check, for a program no installer's oracle covers. */
    outdated?: string;
    upgrade?: string;
    /** A repo script that's its outdated oracle: prints the newer version, `update` moves it. */
    updatesManagedBy?: string;
    /** Why setup-new-machine can do it last. */
    later?: string;
    spare?: string;
  };
  export function program(name: string, spec: ProgramSpec): Program;
  /** A program or script through one of its variants. */
  export function variant(program: Program, variant: string): ProgramVariant;
  export function variant(script: Script, variant: string): ScriptVariant;
  /** What a script, and each of its variants, runs. */
  export type StepSpec = {
    /** A repo script with `check` and `install` modes; the machine's arguments reach both. */
    managedBy?: string;
    /** A repo script run as it is, with `check` inline... */
    file?: string;
    /** ...or command lines, all of which must pass. */
    run?: string | string[];
    /** Command lines that pass when it's done. */
    check?: string | string[];
    /** Programs and scripts it runs after, when the machine has them; never pulls them in. */
    runAfter?: Many<Program | Script>;
    spare?: string;
  };
  /** An outdated oracle beside a script: rows of what's behind, and `upgrade` per row. */
  export type Oracle = {
    name?: string;
    command: string;
    upgrade?: string;
    needsSudo?: boolean;
  };
  export type ScriptSpec = StepSpec & {
    description?: string;
    needsSudo?: boolean;
    /** Only setup-new-machine runs it (a one-time bootstrap). */
    setupOnly?: boolean;
    /** Only maintenance runs it, never setup-new-machine. */
    maintainOnly?: boolean;
    /** Only until every machine has done it: compile says when to delete it. */
    transitional?: boolean;
    /** Why setup-new-machine can do it last. */
    later?: string;
    /** A repo script that's the outdated oracle of what this script set up: rows, and `update <item>`. */
    updatesManagedBy?: string;
    outdated?: Oracle[];
    /** Different ways to do this one step, by name; a machine picks one with `variant()`. */
    variants?: Record<string, StepSpec & {
      transitional?: never;
    }>;
  };
  export function script(name: string, spec: ScriptSpec): Script;
  /** A script with arguments, as the machine runs it: each is one word or more. */
  export const args: (script: Script | ScriptVariant, ...args: string[]) => ScriptArgs;
  /** An outdated oracle of its own, outside any script. */
  export function outdated(name: string, oracle: Omit<Oracle, "name">): void;
  /** A data setting's kind and default, in the repo's data schema. */
  export const flag: (value: boolean) => boolean;
  export const text: (value: string) => string;
  export const number: (value: number) => number;
  export const whole: (value: number) => number;
  export const list: (value: string[]) => string[];
  type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
  };
  type RunEntry = Script | ScriptArgs | ScriptVariant;
  export type MachineSpec<Data> = {
    /** Profiles it's built on, in order; a machine overrides them. */
    extends?: Many<Profile>;
    /** Its settings, over the profiles' and the schema's defaults. */
    data?: DeepPartial<Data>;
    /** Programs through their one variant, `variant(p, "x")`, or `via(installer, [...])`. */
    install?: Many<Program | ProgramVariant | ViaGroup>;
    /** Scripts it runs, with `args(...)` and `variant(...)`; lists are flattened. */
    run?: Many<RunEntry>;
    /** A profile kept though no machine extends it (machines can't be spare). */
    spare?: string;
  };
  export function profile<Data = Record<string, unknown>>(name: string, spec: MachineSpec<Data>): Profile;
  export function machine<Data = Record<string, unknown>>(name: string, spec: Omit<MachineSpec<Data>, "spare">): void;
  export type RepoSpec<Data> = {
    name: string;
    /** The folder each machine's state is written to. */
    state: string;
    /** The dotfiles folder (chezmoi's source), when the repo holds them. */
    configs?: string;
    /** The oldest loadout that may read this repo. */
    minToolVersion?: string;
    /** Every per-machine setting, with its default (a child repo's are its parent's). */
    data?: Data;
    /** The repo this one builds on (a child repo): its checkout, `~/…`, absolute, or relative to this one. */
    parent?: {
      name: string;
      path: string;
    };
  };
  /**
   * Imports every repo file the globs match (Bun.Glob; `*` and `**` match dot
   * files and folders too), in path order: the fragments of a repo that keeps
   * one per tool, so a new file needs no import of its own; a glob that
   * matches nothing yet is fine. loadout.ts awaits it before `repo()`.
   */
  export function include(...globs: string[]): Promise<void>;
  /**
   * The repo itself: the last thing loadout.ts does, once its imports have
   * declared everything. Under `loadout compile` it prints the draft.
   */
  export function repo<Data>(spec: RepoSpec<Data>): void;
  export {};
}

declare module "loadout/script" {
  import { $ } from "bun";
  export { $ };
  /** What loadout sets for every command it runs (contract 5); a getter throws when it isn't set. */
  export const env: {
    /** The repo's root (`LOADOUT_REPO`); a parent's declarations see the parent's. */
    readonly repo: string;
    /** The folder of the file that declared what runs (`LOADOUT_FRAGMENT_DIR`). */
    readonly fragmentDir: string;
    /** The machine loadout runs as (`LOADOUT_MACHINE`). */
    readonly machine: string;
    /** `linux` or `macos` (`LOADOUT_OS`). */
    readonly os: "linux" | "macos";
    /** chezmoi's source folder, when the repo holds dotfiles (`LOADOUT_CONFIGS`). */
    readonly configs: string | undefined;
    /** A child repo's parent checkout (`LOADOUT_PARENT`). */
    readonly parent: string | undefined;
  };
  /** path in the repo loadout runs (`$LOADOUT_REPO`). */
  export const repoPath: (path: string) => string;
  type Step = (...args: string[]) => Promise<unknown> | unknown;
  /**
   * A managed script (`managedBy: "x.ts"`): `check [args…]` exits 0 when it's
   * done, 1 when not (a check that throws isn't done, and says why);
   * `[install] [args…]` does it, and a failure exits 1 with its message. The
   * machine's arguments reach both.
   */
  export function main(check: (...args: string[]) => Promise<boolean> | boolean, install: Step): Promise<void>;
  /**
   * A script with no check of its own (a manifest's `file`, its check
   * inline): runs step with the arguments, and a failure exits 1 with its
   * message.
   */
  export function run(step: Step): Promise<void>;
  /**
   * One thing that's behind, as an outdated source reports it: loadout reads
   * `<item> <current> <candidate> [note…]`, and a URL at the end of the note
   * is the row's link (opened with `K` on the home screen).
   */
  export type Row = {
    item: string;
    current: string;
    candidate: string;
    note?: string;
    link?: string;
  };
  /** row as loadout reads it, one line. */
  export const formatRow: (row: Row) => string;
  /**
   * An outdated source (`updatesManagedBy: "x.ts"` on a script, or an
   * oracle's command): with no arguments it prints a row per thing that's
   * behind; `update <item>` moves that one. A failure exits 1 with its
   * message, which loadout shows as the source having failed: a broken
   * oracle never reads as "nothing outdated".
   */
  export function oracle(spec: {
    rows: () => Promise<Row[]> | Row[];
    update: (item: string) => Promise<unknown> | unknown;
  }): Promise<void>;
  /**
   * A program's own outdated check (`updatesManagedBy: "x.ts"` on a
   * program): with no arguments it prints the newest version when this one is
   * behind, nothing otherwise; `update` moves it.
   */
  export function programOracle(spec: {
    latest: () => Promise<string | undefined> | string | undefined;
    update: () => Promise<unknown> | unknown;
  }): Promise<void>;
  /** A clone and the name its row goes by. */
  export type Clone = {
    name: string;
    dir: string;
  };
  /** A row per clone that's behind its remote's HEAD, by name; all fetched at once. What isn't a clone is skipped. */
  export function clonesBehind(clones: Clone[]): Promise<Row[]>;
  /** Fast-forwards the clone to its remote; one that can't fails rather than rewriting history. */
  export function fastForward({ name, dir }: Clone): Promise<void>;
  /** Is it on PATH? (sh's `command -v`) */
  export const has: (program: string) => boolean;
  /** Print to stderr and exit 1. */
  export function fail(message: string): never;
  /** Its output, trimmed; throws when it fails. */
  export const out: (command: ReturnType<typeof $>) => Promise<string>;
  /** Did it succeed? Its output is discarded. */
  export const ok: (command: ReturnType<typeof $>) => Promise<boolean>;
  /**
   * A file's text, or "" when there's none. Node's readFile, not Bun.file: a
   * Bun.file that was stat'ed first reads only the size the stat gave, and
   * /proc files say 0.
   */
  export const read: (path: string) => Promise<string>;
  /** A file's text as `$(cat file)` reads it: trailing newlines dropped, "" when there's none. */
  export const readTrimmed: (path: string) => Promise<string>;
  /** Can this user run path? (sh's `[ -x path ]`) */
  export function executable(path: string): boolean;
  /**
   * text into path as root, with mode, its folder made: through a private temp
   * file and `sudo install`, never stdin (a Bun Shell redirect can't be opened
   * as /dev/stdin).
   */
  export function sudoWrite(path: string, text: string, mode?: string): Promise<void>;
  /** Re-run test() until it's true; fails after tries * every seconds. */
  export function waitUntil(test: () => Promise<boolean>, what?: string, every?: number, tries?: number): Promise<void>;
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
  export function mainCheckoutPath(file: string): Promise<string>;
  /** What went wrong, as one line a user reads: a failed command's stderr. */
  export function reason(error: unknown): string;
}
