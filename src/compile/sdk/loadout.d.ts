// loadout's types: the modules manifests import as "loadout" and TypeScript
// scripts as "loadout/script". The modules themselves are inside loadout,
// which provides them whenever it runs this repo's files. Written by
// `loadout repo compile` (and `loadout repo init`) from the loadout that compiles the
// repo: don't edit it, a compile puts it back.

declare module "loadout" {
  /**
   * An installer, named for how it reads in `install`: as it is in a program
   * (`canBeInstalled: [withBrew]`), called with what that program's package needs
   * (`withOmarchy({ packageName: "mise-bin" })`, `withBrewTap({ tap: "hashicorp/tap" })`),
   * and called with programs in a machine (`withBrew(just, vim)`).
   */
  export type Installer<Param extends string = never> = {
    (settings: VariantSpec & {
      readonly [P in Param]: string;
    }): VariantEntry<never>;
    (program: Many<Program>, ...more: Many<Program>[]): ProgramsWith;
    /** Every install with it waits for these programs. */
    needs(...programs: Many<Program>[]): void;
    readonly kind: "installer";
    readonly name: string;
  };
  /** Called in a machine with one of its `withCustomSteps()` ways to install: `setupBrew("linux")`. */
  export type Program<Way extends string = never> = {
    (way: Way): ProgramVariant;
    readonly kind: "program";
    readonly name: string;
  };
  /** Called in a machine's `run` with its module's options, when it takes any: `t2ChargeLimit({ limit: 90 })`. */
  export type Script<Args extends unknown[] = any> = {
    (...args: Args): ScriptRun;
    readonly kind: "script";
    readonly name: string;
  };
  export type Profile = {
    readonly kind: "profile";
    readonly name: string;
  };
  /** A program by one of its ways to install: `setupBrew("linux")`. */
  export type ProgramVariant = {
    readonly kind: "program-variant";
    readonly program: Program;
    readonly variant: string;
  };
  /** A script with its options: `t2ChargeLimit({ limit: 90 })`. */
  export type ScriptRun = {
    readonly kind: "script-run";
    readonly script: Script;
    readonly options?: unknown;
  };
  /** Programs with an installer, in a machine: `withOmarchy(curl, git)`. */
  export type ProgramsWith = {
    readonly kind: "programs-with";
    readonly installer: {
      readonly name: string;
    };
    readonly programs: Program[];
  };
  /** One, or a list of them, nested as deep as shared lists nest: flattened wherever it's read. */
  export type Many<T> = T | readonly Many<T>[];
  /** The built-in installers: shipped with loadout, `loadout installer list` lists them. */
  export const withApt: Installer<never>;
  export const withBrew: Installer<never>;
  export const withBrewCask: Installer<never>;
  export const withDnf: Installer<never>;
  export const withDnfCopr: Installer<"copr">;
  export const withDnfRepo: Installer<"repofile">;
  export const withFlatpak: Installer<never>;
  export const withOmarchy: Installer<never>;
  export const withOmarchyAur: Installer<never>;
  export const withPacman: Installer<never>;
  type Place = {
    file: string;
    line: string;
    col: string;
  };
  /**
   * The command that runs a repo file with arguments, each exactly one word
   * (`{tap}` is still filled in): `runFile(".loadout/x.ts", "check")`. Its path
   * is from the declaring file's folder, and it runs with the interpreter its
   * `#!` line names.
   */
  export function runFile(path: string, ...args: string[]): string;
  /** A repo file as an installer param's value: `withDnfRepo({ repofile: repoFile("x.repo") })`, from the declaring file's folder. */
  export const repoFile: (path: string) => string;
  export type InstallerSpec<Param extends string = string> = {
    /** The binary that must be there for it to work. */
    neededBinary?: string;
    /** What a program calls it with, besides the settings every installer takes (`withBrewTap({ tap: "…" })`); `{tap}` in the commands. */
    installerParams?: readonly Param[];
    /** Installs `{packageName}`. */
    installCommand?: string;
    /** Prints `{packageName}`'s version. */
    checkCommand?: string;
    /** Reads the version, as its first group, from what checkCommand prints. */
    versionRegex?: RegExp;
    /** Prints one package's newer version, when it's behind. */
    outdatedCommand?: string;
    /** Lists every package that's behind. */
    allOutdatedCommand?: string;
    /** Upgrades everything it installed. */
    upgradeCommand?: string;
    needsSudo?: boolean;
    /** Why it stays although nothing uses it. */
    keepUnused?: string;
  };
  export function installer<const Param extends string = never>(name: string, spec: InstallerSpec<Param>): Installer<Param>;
  /** How one variant installs, checks and is reached, beyond what its installer says. */
  export type VariantSpec = {
    /** The package name, when it isn't the program's. */
    packageName?: string;
    /** Its own install command line (`runFile("x.sh")` for a repo script); or `module`, in TypeScript. */
    installCommand?: string;
    /**
     * The repo module that installs it, `() => import("./.loadout/x.ts")`: it
     * exports `install` and, unless `versionCommand` says how to check it,
     * `check` (is it there? with `versionRegex`, the version is read from what
     * it prints). Compile never runs it.
     */
    module?: () => Promise<Partial<Pick<PlainModule, "check">> & Pick<PlainModule, "install">>;
    /** A command printing the version. */
    versionCommand?: string;
    /** A command that passes when it's installed (no version). */
    isInstalled?: string;
    /** Reads the version, as its first group, from what the check prints. */
    versionRegex?: RegExp;
    /** The binary that must be there first, when it isn't the installer's. */
    neededBinary?: string;
    /** Prints the newer version, when this one is behind. */
    outdatedCommand?: string;
    needsSudo?: boolean;
    dependsOn?: Many<Program>;
    /** Binaries it installs, and the folder each is in (`{ brew: "/opt/homebrew/bin" }`); true for one already on PATH. */
    addsToPath?: Record<string, string | true>;
    /** Why it stays although nothing uses it. */
    keepUnused?: string;
  };
  /** One way a program is installed; Way is its name when it's a `withCustomSteps()` one. */
  export type VariantEntry<Way extends string = string> = {
    readonly kind: "variant";
    readonly key: string;
    readonly spec: VariantSpec;
    /** The installer's params' values. */
    readonly values?: Record<string, string>;
    readonly at: Place;
    readonly way?: Way;
  };
  /** Its own way to install (`withCustomSteps("linux", {...})`); named "custom" when unnamed. */
  export function withCustomSteps<const Way extends string>(name: Way, spec: VariantSpec): VariantEntry<Way>;
  export function withCustomSteps(spec: VariantSpec): VariantEntry<"custom">;
  /** A way to install in a program: an installer that needs nothing said, one called with settings, or `withCustomSteps()`. */
  type Way = Installer<never> | VariantEntry;
  /** The names of the `withCustomSteps()` ways among W. */
  type CustomName<W> = W extends VariantEntry<infer N> ? N : never;
  export type ProgramSpec<W extends Way = Way> = {
    description?: string;
    tags?: string[];
    dependsOn?: Many<Program>;
    /** Its ways to install, in order: `withBrew`, `withOmarchy({ packageName: "…" })`, `withCustomSteps(…)`. */
    canBeInstalled: W[];
    /** A command printing the version, for every way to install that has no check of its own. */
    versionCommand?: string;
    /** Reads the version, as its first group, from what versionCommand prints. */
    versionRegex?: RegExp;
    /** Folders put first on PATH for its own commands, for a tool that lands where a fresh shell doesn't look yet. */
    searchPath?: string[];
    /** Its own outdated check, for a program no installer's oracle covers. */
    outdatedCommand?: string;
    /** Upgrades this program alone. */
    upgradeCommand?: string;
    /** The repo module that says whether it's behind, and updates it: `() => import("./.loadout/x.ts")`. */
    updates?: () => Promise<ProgramUpdates>;
    /** Why loadout machine new can do it last. */
    canWait?: string;
    /** Why it stays although nothing uses it. */
    keepUnused?: string;
  };
  export function program<const W extends Way>(name: string, spec: ProgramSpec<W>): Program<CustomName<W>>;
  /** What's wrong with the options, for what their type can't say; nothing when they're right. */
  export type Validate<Options> = (options: Options) => string | false | undefined;
  /** What a script's `rules` exports. */
  export type Rules<Options> = {
    validate: Validate<Options>;
  };
  /** What a script's `module` exports when it takes options: the machine calls the script with them. */
  export type ScriptModule<Options> = {
    /** Is it done? A check that throws isn't, and says why. */
    check: (options: Options) => Promise<boolean> | boolean;
    /** Does it; a throw is the failure's message. */
    install: (options: Options) => unknown;
  };
  /** What a script's `module` exports when it takes no options. */
  export type PlainModule = {
    /** Is it done? A check that throws isn't, and says why. */
    check: () => Promise<boolean> | boolean;
    /** Does it; a throw is the failure's message. */
    install: () => unknown;
  };
  /** One thing that's behind, as `updates` reports it. */
  export type OutdatedItem = {
    item: string;
    current: string;
    candidate: string;
    note?: string;
    link?: string;
  };
  /** What a script's `updates` module exports. */
  export type ScriptUpdates = {
    /** What's behind. A throw is shown as the source having failed, never as nothing outdated. */
    listOutdated: () => Promise<OutdatedItem[]> | OutdatedItem[];
    /** Moves one of them, by its item. */
    update: (item: string) => unknown;
  };
  /** What a program's `updates` module exports. */
  export type ProgramUpdates = {
    /** The newest version when this one is behind, undefined otherwise. */
    newerVersion: () => Promise<string | undefined> | string | undefined;
    update: () => unknown;
  };
  /** What a script runs. */
  export type StepSpec = {
    /** Command lines, all of which must pass; `runFile("x.sh")` for a repo script in any language. */
    runCommand?: string | string[];
    /** Command lines that pass when it's done. */
    checkCommand?: string | string[];
    /** Programs and scripts it runs after, when the machine has them; never pulls them in. */
    runAfter?: Many<Program | Script>;
    /** Why it stays although nothing uses it. */
    keepUnused?: string;
  };
  /** An outdated oracle beside a script: what's behind, and `upgradeCommand` per item. */
  export type Oracle = {
    name?: string;
    command: string;
    upgradeCommand?: string;
    needsSudo?: boolean;
  };
  export type ScriptSpec = StepSpec & {
    description?: string;
    needsSudo?: boolean;
    /** Only loadout machine new runs it (a one-time bootstrap). */
    setupOnly?: boolean;
    /** loadout machine new never runs it. */
    notDuringSetup?: boolean;
    /** Only until every machine has done it: compile says when to delete it. */
    deleteOnceDone?: boolean;
    /** Why loadout machine new can do it last. */
    canWait?: string;
    /**
     * The repo module that says what of this script's is behind, and updates
     * it: `() => import("./.loadout/x.ts")`; or several, each by the name of
     * what it covers.
     */
    updates?: (() => Promise<ScriptUpdates>) | Record<string, () => Promise<ScriptUpdates>>;
    /** Commands instead, in any language. */
    outdated?: Oracle[];
  };
  /** A script done by a TypeScript module, which also says what options it takes. */
  export type ModuleScriptSpec<Options> = Omit<ScriptSpec, "runCommand" | "checkCommand"> & {
    /**
     * The repo module that does it, `() => import("./.loadout/x.ts")`: it
     * exports `check` and `install`, and the options they take are what a
     * machine calls the script with. Compile never runs it.
     */
    module: () => Promise<ScriptModule<Options>>;
    /**
     * The repo module that says what's wrong with the options,
     * `() => import("./.loadout/x.rules.ts")`: it exports `validate`, which
     * compile calls with every machine's, and loadout before `check` and
     * `install`. Nothing else goes in it: compile does run this one.
     */
    rules: () => Promise<Rules<NoInfer<Options>>>;
  };
  /** A script done by a TypeScript module that takes no options. */
  export type PlainModuleScriptSpec = Omit<ScriptSpec, "runCommand" | "checkCommand"> & {
    /** The repo module that does it, `() => import("./.loadout/x.ts")`: it exports `check` and `install`. Compile never runs it. */
    module: () => Promise<PlainModule>;
  };
  export function script<Options = undefined>(name: string, spec: ModuleScriptSpec<Options>): Script<undefined extends Options ? [options?: Options] : [options: Options]>;
  export function script(name: string, spec: PlainModuleScriptSpec): Script<[]>;
  export function script(name: string, spec: ScriptSpec): Script<[]>;
  /** An outdated oracle of its own, outside any script. */
  export function outdated(name: string, oracle: Omit<Oracle, "name">): void;
  type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
  };
  /** A script as it is only when it can be called with nothing: one whose options are required has to be called. */
  type RunEntry = Script<[]> | ScriptRun;
  export type MachineSpec<Data> = {
    /** Profiles it's built on, in order; a machine overrides them. */
    extends?: Many<Profile>;
    /** Its settings, over the profiles' and the schema's defaults. */
    data?: DeepPartial<Data>;
    /** Programs by their only way to install, by a named one (`setupBrew("linux")`), or with an installer (`withBrew(just, vim)`). */
    install?: Many<Program | ProgramVariant | ProgramsWith>;
    /** Scripts it runs: as they are, called with options (`t2ChargeLimit({ limit: 90 })`); lists are flattened. */
    run?: Many<RunEntry>;
    /** Why a profile stays although no machine extends it (a machine can't). */
    keepUnused?: string;
  };
  export function profile<Data = Record<string, unknown>>(name: string, spec: MachineSpec<Data>): Profile;
  export function machine<Data = Record<string, unknown>>(name: string, spec: Omit<MachineSpec<Data>, "keepUnused">): void;
  export type RepoSpec<Data> = {
    name: string;
    /** The folder each machine's state is written to. */
    stateFolder: string;
    /**
     * The dotfiles, when the repo holds them: chezmoi's source folder, as you
     * write it (`"loadouts"`), or tool folders compile builds chezmoi's sources from.
     */
    dotfiles?: string | ToolDotfiles;
    /** The oldest loadout that may read this repo. */
    minLoadoutVersion?: string;
    /** Every per-machine setting, with its default (a child repo's are its parent's). */
    data?: Data;
    /** The repo this one builds on (a child repo): its checkout, `~/…`, absolute, or relative to this one. */
    parent?: {
      name: string;
      path: string;
    };
  };
  /**
   * Dotfiles kept with their tools: every folder `tools` matches is a tool
   * (named after its folder), and in it `home/` is chezmoi source rooted at
   * `$HOME` and `root/` chezmoi source rooted at `/`, both optional. loadout
   * builds every tool's `home/` into `home` and every `root/` into `root`
   * (files as symlinks, kept current by every command: add both to
   * `.gitignore`); loadout applies `home` as
   * you and `root` as root. `from` is a chezmoi source tree merged into
   * `home` as it stands, for what hasn't moved into a tool folder yet.
   *
   * ```ts
   * dotfiles: { tools: "loadouts/*", home: ".chezmoi-home", root: ".chezmoi-root" }
   * ```
   */
  export type ToolDotfiles = {
    /** The tool folders, a glob relative to the repo root (`"loadouts/*"`). */
    tools: string;
    /** The folder compile builds the `$HOME` source into; `.chezmoiroot` names it, for plain chezmoi. */
    home: string;
    /** The folder compile builds the `/` source into; needed once a tool has `root/`. */
    root?: string;
    /** A chezmoi source tree merged into `home` as it is; apart from every tool folder. */
    from?: string;
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
   * declared everything. Under `loadout repo compile` it prints the draft.
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
   * A script a manifest runs as a command (`runFile()`): runs step with the arguments, and a failure exits 1 with its
   * message.
   */
  export function runStep(step: Step): Promise<void>;
  /**
   * One thing that's behind, as an outdated source reports it: loadout reads
   * `<item> <current> <candidate> [note…]`, and a URL at the end of the note
   * is the row's link (opened with `K` on the home screen).
   */
  export type OutdatedItem = {
    item: string;
    current: string;
    candidate: string;
    note?: string;
    link?: string;
  };
  /** row as loadout reads it, one line. */
  export const formatOutdatedItem: (row: OutdatedItem) => string;
  /** A clone and the name its row goes by. */
  export type Clone = {
    name: string;
    dir: string;
  };
  /** A row per clone that's behind its remote's HEAD, by name; all fetched at once. What isn't a clone is skipped. */
  export function clonesBehind(clones: Clone[]): Promise<OutdatedItem[]>;
  /** Fast-forwards the clone to its remote; one that can't fails rather than rewriting history. */
  export function fastForward({ name, dir }: Clone): Promise<void>;
  /** Is it on PATH? (sh's `command -v`) */
  export const isOnPath: (program: string) => boolean;
  /** Print to stderr and exit 1. */
  export function fail(message: string): never;
  /** Its output, trimmed; throws when it fails. */
  export const outputOf: (command: ReturnType<typeof $>) => Promise<string>;
  /** Did it succeed? Its output is discarded. */
  export const succeeds: (command: ReturnType<typeof $>) => Promise<boolean>;
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
