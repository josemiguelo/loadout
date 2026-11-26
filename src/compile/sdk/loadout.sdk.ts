// loadout's manifest SDK, imported as "loadout". It is part of loadout, not
// of the repo: whenever loadout runs a repo's files (compile, scripts), its
// bun wrapper's preload registers this module, and compile and init write
// its types into the repo's node_modules/@types/loadout. A repo's manifests always run
// with the SDK of the loadout that compiles them.
//
// Each declaration returns a typed reference: a name that doesn't exist is a
// type error where it's used, and "go to definition" finds it. The entry
// file, loadout.ts, imports the machines (which import what they use) and
// calls `repo()`, which prints the draft `loadout compile` assembles into
// loadout.lock.json.
//
// A mistake the manifest language catches is thrown as one line naming the
// file, line and column of the declaration, as compile prints it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── references ─────────────────────────────────────────────────────────

/**
 * An installer, named for how it reads in `install`: as it is in a program
 * (`canBeInstalled: [withBrew]`), called with what that program's package needs
 * (`withOmarchy({ packageName: "mise-bin" })`, `withBrewTap({ tap: "hashicorp/tap" })`),
 * and called with programs in a machine (`withBrew(just, vim)`).
 */
export type Installer<Param extends string = never> = {
  (settings: VariantSpec & { readonly [P in Param]: string }): VariantEntry<never>;
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
export type Profile = { readonly kind: "profile"; readonly name: string };

/** A program by one of its ways to install: `setupBrew("linux")`. */
export type ProgramVariant = { readonly kind: "program-variant"; readonly program: Program; readonly variant: string };
/** A script with its options: `t2ChargeLimit({ limit: 90 })`. */
export type ScriptRun = { readonly kind: "script-run"; readonly script: Script; readonly options?: unknown };

/**
 * A reference that is called. defineProperty, since a function's own `name`
 * can't be assigned.
 */
function callable<T>(kind: string, name: string, call: (args: any[], self: T) => unknown, more: object = {}): T {
  const ref = ((...args: unknown[]) => call(args, ref)) as T;
  for (const [key, value] of Object.entries({ kind, name, ...more })) Object.defineProperty(ref, key, { value, enumerable: true });
  return ref;
}

/** Programs with an installer, in a machine: `withOmarchy(curl, git)`. */
export type ProgramsWith = { readonly kind: "programs-with"; readonly installer: { readonly name: string }; readonly programs: Program[] };

/** One, or a list of them, nested as deep as shared lists nest: flattened wherever it's read. */
export type Many<T> = T | readonly Many<T>[];
const flat = <T>(xs: Many<T> | undefined): T[] => (xs === undefined ? [] : Array.isArray(xs) ? (xs as T[]).flat(Infinity as 1) as T[] : [xs as T]);

/** An installer's reference: programs given make a machine's entry, settings a program's way to install. */
const installerRef = <Param extends string = never>(name: string, params: readonly Param[] = []): Installer<Param> =>
  callable<Installer<Param>>(
    "installer",
    name,
    (args, self) => {
      const [first] = args;
      if (first === undefined) fail(`installer '${name}' is called with programs or with settings`);
      const isSettings = typeof first === "object" && !Array.isArray(first);
      if (!isSettings) return { kind: "programs-with", installer: self, programs: flat(args as Many<Program>) };
      const { settings, values } = split(first, params);
      for (const p of params) if (values[p] === undefined) fail(`installer '${name}' needs '${p}'`);
      return { kind: "variant", key: name, spec: settings, values, at: caller() };
    },
    {
      needs: (...programs: Many<Program>[]) => {
        if (!ownFile(caller().file)) return;
        requiresOf.set(name, [...(requiresOf.get(name) ?? []), ...flat(programs).map((p) => p.name)]);
      },
    },
  );

/** Settings without the installer's params, and the params' values. */
function split(given: object, params: readonly string[]) {
  const settings: JSON = {};
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(given)) {
    if (params.includes(key)) values[key] = value;
    else settings[key] = value;
  }
  return { settings: settings as VariantSpec, values };
}

/** The built-in installers: shipped with loadout, `loadout installers` lists them. */
export const withApt = installerRef("apt");
export const withBrew = installerRef("brew");
export const withBrewCask = installerRef("brew-cask");
export const withDnf = installerRef("dnf");
export const withDnfCopr = installerRef("dnf-copr", ["copr"]);
export const withDnfRepo = installerRef("dnf-repo", ["repofile"]);
export const withFlatpak = installerRef("flatpak");
export const withOmarchy = installerRef("omarchy");
export const withOmarchyAur = installerRef("omarchy-aur");
export const withPacman = installerRef("pacman");

// ─── where a declaration is ─────────────────────────────────────────────

type JSON = Record<string, unknown>;
const ROOT = process.cwd();
/** Compiling a child repo's parent: every origin is the parent's. */
const AS_PARENT = !!process.env.LOADOUT_AS_PARENT;

type Place = { file: string; line: string; col: string };

/**
 * A stack frame's file, line and column, when it names a file: bun prints
 * "at fn (path:line:col)", "at path:line:col", and sometimes no column. The
 * SDK's own frames name its module ("loadout:61:20"), never a path.
 */
const frameAt = /(?:\(|at )((?:file:\/\/)?\/[^():]+):(\d+)(?::(\d+))?\)?$/;

/** Where the user's code called the SDK: the first stack frame at a file. */
function caller(): Place {
  for (const frame of (new Error().stack ?? "").split("\n")) {
    const m = frame.match(frameAt);
    if (!m) continue;
    const file = m[1].startsWith("file://") ? fileURLToPath(m[1]) : m[1];
    return { file, line: m[2], col: m[3] ?? "1" };
  }
  return { file: resolve(ROOT, "loadout.ts"), line: "1", col: "1" };
}

/** file:line,col from the repo root, as compile names a place. */
const placeOf = (at: Place) => `${relative(ROOT, at.file)}:${at.line},${at.col}`;

/** A mistake in the manifest: printed as one line, with where it is. */
class ManifestError extends Error {}
function fail(message: string, at: Place = caller()): never {
  throw new ManifestError(`${placeOf(at)}: ${message}`);
}
/**
 * Any failure as one line with a place, as compile prints every refusal: the
 * language's own (ManifestError), a syntax or import error (bun's, with its
 * `position`), or a runtime one (its first stack frame in the repo's files).
 */
function oneLine(e: unknown): string {
  if (e instanceof ManifestError) return e.message;
  const err = e as { name?: string; message?: string; stack?: string; position?: { file?: string; line?: number; column?: number } };
  // Paths in bun's own messages from the repo root, as everywhere else.
  const message = (err?.message ?? String(e)).replaceAll(ROOT + "/", "");
  const what = err?.name && err.name !== "Error" && !/Message$/.test(err.name) ? `${err.name}: ${message}` : message;
  const pos = err?.position;
  if (pos?.file) return `${relative(ROOT, pos.file)}:${pos.line ?? 1},${pos.column ?? 1}: ${what}`;
  for (const frame of (err?.stack ?? "").split("\n")) {
    const m = frame.match(frameAt);
    if (!m) continue;
    const file = m[1].startsWith("file://") ? fileURLToPath(m[1]) : m[1];
    if (ownFile(file)) return `${placeOf({ file, line: m[2], col: m[3] ?? "1" })}: ${what}`;
  }
  return what.split("\n")[0];
}
process.on("uncaughtException", (e) => {
  console.error(oneLine(e));
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error(oneLine(e));
  process.exit(1);
});

/** In this repo (not its parent's checkout, which a child imports from). */
const ownFile = (file: string) => file === resolve(ROOT, "loadout.ts") || file.startsWith(ROOT + "/");

/** The folder of file from the repo root: where its paths resolve and its commands run. */
function originOf(file: string): string {
  const dir = dirname(relative(ROOT, file));
  const folder = dir === "." ? "" : dir;
  return AS_PARENT ? `parent:${folder}` : folder;
}

// ─── the draft being built ──────────────────────────────────────────────

/** A declaration: recorded only when its file is this repo's (a child sees its parent's as references). */
type Entry = { at: Place; value: JSON };
/**
 * One state per process, on globalThis: a child repo's files and the
 * parent's modules they import both import this SDK, and must see the same
 * declarations (the parent's programs' variants above all).
 */
const state = ((globalThis as Record<string, unknown>).__loadoutManifest ??= {
  draft: {
    installers: new Map<string, Entry>(),
    programs: new Map<string, Entry>(),
    scripts: new Map<string, Entry>(),
    outdated: new Map<string, Entry>(),
    machines: new Map<string, Entry>(),
    profiles: new Map<string, Entry>(),
  },
  requiresOf: new Map<string, string[]>(),
  spares: new Map<string, string>(),
  transitional: [] as string[],
  variantsOf: new Map<string, string[]>(),
  firstAt: new Map<string, Place>(),
}) as {
  draft: Record<"installers" | "programs" | "scripts" | "outdated" | "machines" | "profiles", Map<string, Entry>>;
  requiresOf: Map<string, string[]>;
  spares: Map<string, string>;
  transitional: string[];
  /** Every program's variant keys, the parent's too: what a machine's install resolves against. */
  variantsOf: Map<string, string[]>;
  firstAt: Map<string, Place>;
};
const { draft, requiresOf, spares, transitional, variantsOf, firstAt } = state;

function declare(table: Map<string, Entry>, kind: string, name: string, at: Place, value: JSON) {
  const key = `${kind} '${name}'`;
  const first = firstAt.get(key);
  if (first) fail(`${key} is declared twice; first at ${placeOf(first)}`, at);
  firstAt.set(key, at);
  if (ownFile(at.file)) table.set(name, { at, value });
}

/**
 * Drops what wasn't set (undefined, empty lists and objects), so the draft
 * says only what was. A false stays: compile reads it as unset, except a
 * variant's `sudo`, where false overrides the installer's.
 */
function clean(o: JSON): JSON {
  return Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) =>
        v !== undefined &&
        !(Array.isArray(v) && v.length === 0) &&
        !(v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0),
    ),
  );
}

function spare(key: string, reason: string | undefined, at: Place) {
  if (reason === undefined) return;
  if (!reason.trim()) fail(`${key}: keepUnused needs a reason`, at);
  spares.set(key, reason);
}

function reason(what: string, value: string | undefined, at: Place): string | undefined {
  if (value !== undefined && !value.trim()) fail(`${what}: canWait needs a reason`, at);
  return value;
}

/** The setting names given among names, for "only one of" checks. */
function conflict(what: string, spec: object, names: string[], at: Place) {
  const given = names.filter((n) => (spec as JSON)[n] !== undefined);
  if (given.length > 1) fail(`${what}: ${given.join(" and ")} can't go together: give one`, at);
}

/** A regex as the lock holds it: its pattern, which has no flags. */
function regexSource(regex: RegExp | undefined, at: Place): string | undefined {
  if (regex === undefined) return undefined;
  if (!(regex instanceof RegExp)) fail("versionRegex is a regex: /([0-9.]+)/", at);
  if (regex.flags) fail(`versionRegex ${regex} can't have flags`, at);
  return regex.source;
}

const VERSION_REGEX = "([0-9]+\\.[0-9][0-9.]*)";

/**
 * The command that runs a repo file with arguments, each exactly one word
 * (`{tap}` is still filled in): `runFile(".loadout/x.ts", "check")`. Its path
 * is from the declaring file's folder, and it runs with the interpreter its
 * `#!` line names.
 */
export function runFile(path: string, ...args: string[]): string {
  if (path === "" || /[\s']/.test(path)) fail(`runFile: the file's path can't have spaces or quotes, and its arguments come after it: runFile("x.sh", "arg"), not '${path}'`);
  const word = (arg: string) => (/^[\w@%+=:,./{}-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);
  return ["file:" + path, ...args.map(word)].join(" ");
}

/** A repo file as an installer param's value: `withDnfRepo({ repofile: repoFile("x.repo") })`, from the declaring file's folder. */
export const repoFile = (path: string) => `file:${path}`;

/**
 * Commands that must all pass, joined with `&&`; one holding `||` or `;` is
 * grouped in `{ …; }` first (a single one too), so the join can't change
 * what it means.
 */
function allOf(commands: string | string[], at: Place): string {
  if (Array.isArray(commands) && commands.length > 1 && commands.some((c) => c.startsWith("file:"))) fail("runFile() is the only command of its list", at);
  return (typeof commands === "string" ? [commands] : commands).map((c) => (c.includes("||") || c.includes(";") ? `{ ${c}; }` : c)).join(" && ");
}

/** Refuses a setting spec doesn't have: the editor's types say so too, but compile doesn't type-check. */
function onlyKnown(what: string, spec: object, settings: Record<string, true>, at: Place) {
  const unknown = Object.keys(spec).find((k) => !(k in settings));
  if (unknown) fail(`${what} has no setting '${unknown}' (its settings: ${Object.keys(settings).join(", ")})`, at);
}

const distinct = <T>(xs: T[]) => [...new Set(xs)];

// ─── installers ─────────────────────────────────────────────────────────

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

const installerSpecSettings: Record<keyof InstallerSpec, true> = { neededBinary: true, installerParams: true, installCommand: true, checkCommand: true, versionRegex: true, outdatedCommand: true, allOutdatedCommand: true, upgradeCommand: true, needsSudo: true, keepUnused: true };

export function installer<const Param extends string = never>(name: string, spec: InstallerSpec<Param>): Installer<Param> {
  const at = caller();
  onlyKnown(`installer '${name}'`, spec, installerSpecSettings, at);
  spare(`installer '${name}'`, spec.keepUnused, at);
  const taken = spec.installerParams?.find((p) => p in variantSpecSettings);
  if (taken) fail(`installer '${name}': '${taken}' is already a setting of every installer: name the param something else`, at);
  declare(draft.installers, "installer", name, at, clean({
    probe: spec.neededBinary,
    params: spec.installerParams,
    install: spec.installCommand,
    check: spec.checkCommand,
    regex: regexSource(spec.versionRegex, at) ?? VERSION_REGEX,
    outdated: spec.outdatedCommand,
    "outdated-all": spec.allOutdatedCommand,
    upgrade: spec.upgradeCommand,
    sudo: spec.needsSudo,
    origin: originOf(at.file) || undefined,
  }));
  return installerRef(name, spec.installerParams);
}

// ─── programs ───────────────────────────────────────────────────────────

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
export function withCustomSteps(a: string | VariantSpec, b?: VariantSpec): VariantEntry {
  return typeof a === "string" ? { kind: "variant", key: a, way: a, spec: b!, at: caller() } : { kind: "variant", key: "custom", way: "custom", spec: a, at: caller() };
}

const variantSpecSettings: Record<keyof VariantSpec, true> = { packageName: true, installCommand: true, module: true, versionCommand: true, isInstalled: true, versionRegex: true, neededBinary: true, outdatedCommand: true, needsSudo: true, dependsOn: true, addsToPath: true, keepUnused: true };

function variantJSON(what: string, v: VariantSpec, values: Record<string, string> | undefined, at: Place, program: Place): JSON {
  onlyKnown(what, v, variantSpecSettings, at);
  conflict(what, v, ["versionCommand", "isInstalled"], at);
  conflict(what, v, ["module", "isInstalled"], at);
  conflict(what, v, ["installCommand", "module"], at);
  let check: string | undefined;
  let regex = regexSource(v.versionRegex, at);
  let present = false;
  if (v.versionCommand !== undefined) {
    check = v.versionCommand;
    regex ??= VERSION_REGEX;
  } else if (v.isInstalled !== undefined) {
    check = v.isInstalled;
    present = true;
  } else if (v.module !== undefined) {
    present = regex === undefined;
  }
  const value = clean({
    pkg: v.packageName,
    command: v.installCommand,
    check,
    regex,
    present,
    probe: v.neededBinary,
    outdated: v.outdatedCommand,
    with: values,
    // An explicit `needsSudo: false` is kept: it overrides the installer's.
    sudo: v.needsSudo === undefined ? undefined : v.needsSudo,
    "depends-on": v.dependsOn && distinct(flat(v.dependsOn).map((p) => p.name)),
    provides: v.addsToPath && Object.entries(v.addsToPath).map(([binary, at]) => clean({ binary, at: at === true ? undefined : at })),
  });
  if (v.module !== undefined && ownFile(program.file)) {
    modules.push({
      what,
      module: v.module,
      at,
      from: program,
      found: (path) => Object.assign(value, { command: `module:${path} install` }, check === undefined ? { check: `module:${path} check` } : {}),
    });
  }
  return value;
}

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
  /** Why setup-new-machine can do it last. */
  canWait?: string;
  /** Why it stays although nothing uses it. */
  keepUnused?: string;
};

const programSpecSettings: Record<keyof ProgramSpec, true> = { description: true, tags: true, dependsOn: true, canBeInstalled: true, versionCommand: true, versionRegex: true, searchPath: true, outdatedCommand: true, upgradeCommand: true, updates: true, canWait: true, keepUnused: true };

export function program<const W extends Way>(name: string, spec: ProgramSpec<W>): Program<CustomName<W>> {
  const at = caller();
  const what = `program '${name}'`;
  onlyKnown(what, spec, programSpecSettings, at);
  if (spec.versionRegex !== undefined && spec.versionCommand === undefined) fail(`${what}: versionRegex reads versionCommand's output: set it too`, at);
  conflict(what, spec, ["outdatedCommand", "updates"], at);
  conflict(what, spec, ["upgradeCommand", "updates"], at);
  if (spec.upgradeCommand !== undefined && spec.outdatedCommand === undefined) fail(`${what}: upgradeCommand moves the program outdatedCommand says is behind: set it too`, at);
  const install: JSON = {};
  for (const entry of spec.canBeInstalled) {
    const key = entry.kind === "installer" ? entry.name : entry.key;
    if (key in install) fail(`${what} has two '${key}' variants`, entry.kind === "installer" ? at : entry.at);
    if (entry.kind === "installer") install[key] = {};
    else {
      install[key] = variantJSON(`${what} via '${key}'`, entry.spec, entry.values, entry.at, at);
      spare(`${what} via '${key}'`, entry.spec.keepUnused, entry.at);
    }
  }
  if (Object.keys(install).length === 0) fail(`${what} has no way to install it: list them in canBeInstalled`, at);
  spare(what, spec.keepUnused, at);
  const origin = originOf(at.file);
  if (!variantsOf.has(name)) variantsOf.set(name, Object.keys(install));
  const updates: JSON = {};
  if (spec.updates !== undefined && ownFile(at.file)) {
    const found = (path: string) => Object.assign(updates, { command: `module:${path} newerVersion`, upgrade: `module:${path} update` });
    modules.push({ what: `${what} updates`, module: spec.updates, at, from: at, found });
  }
  declare(draft.programs, "program", name, at, clean({
    description: spec.description,
    tags: spec.tags,
    "depends-on": spec.dependsOn && distinct(flat(spec.dependsOn).map((p) => p.name)),
    version: spec.versionCommand === undefined ? undefined : clean({ command: spec.versionCommand, regex: regexSource(spec.versionRegex, at) ?? VERSION_REGEX, origin: origin || undefined, path: spec.searchPath }),
    install,
    outdated:
      spec.updates !== undefined
        ? Object.assign(updates, { command: "" })
        : spec.outdatedCommand !== undefined
          ? clean({ command: spec.outdatedCommand, upgrade: spec.upgradeCommand })
          : undefined,
    path: spec.searchPath,
    later: reason(what, spec.canWait, at),
    origin: origin || undefined,
  }));
  return callable<Program<CustomName<W>>>("program", name, ([way], self) => {
    const ways = spec.canBeInstalled.filter((w) => w.kind === "variant" && w.way !== undefined).map((w) => (w as VariantEntry).key);
    if (!ways.includes(way)) fail(`${what} has no way to install named '${way}' (it has: ${ways.join(", ") || "none"})`, caller());
    return { kind: "program-variant", program: self, variant: way };
  });
}

// ─── scripts ────────────────────────────────────────────────────────────

/** What's wrong with the options, for what their type can't say; nothing when they're right. */
export type Validate<Options> = (options: Options) => string | false | undefined;

/** What a script's `rules` exports. */
export type Rules<Options> = { validate: Validate<Options> };

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
export type OutdatedItem = { item: string; current: string; candidate: string; note?: string; link?: string };

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
export type Oracle = { name?: string; command: string; upgradeCommand?: string; needsSudo?: boolean };

export type ScriptSpec = StepSpec & {
  description?: string;
  needsSudo?: boolean;
  /** Only setup-new-machine runs it (a one-time bootstrap). */
  setupOnly?: boolean;
  /** setup-new-machine never runs it. */
  notDuringSetup?: boolean;
  /** Only until every machine has done it: compile says when to delete it. */
  deleteOnceDone?: boolean;
  /** Why setup-new-machine can do it last. */
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

const stepSettings = { runCommand: true, checkCommand: true, runAfter: true, keepUnused: true } as const;
const scriptSettings: Record<keyof ScriptSpec | keyof ModuleScriptSpec<unknown>, true> = {
  description: true, module: true, rules: true, ...stepSettings, needsSudo: true, setupOnly: true, notDuringSetup: true,
  deleteOnceDone: true, canWait: true, updates: true, outdated: true,
};

function stepJSON(what: string, s: StepSpec, origin: string, at: Place): JSON {
  return clean({
    run: s.runCommand === undefined ? undefined : allOf(s.runCommand, at),
    check: s.checkCommand === undefined ? undefined : allOf(s.checkCommand, at),
    after: s.runAfter && distinct(flat(s.runAfter).map((r) => `${r.kind}s.${r.name}`)),
    origin: origin || undefined,
  });
}

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

/**
 * Options as the lock holds them: what JSON would lose or change is refused.
 * An undefined property is one left out.
 */
function plainOptions(what: string, options: unknown, at: Place): unknown {
  const plain = (v: unknown, where: string): void => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (Array.isArray(v)) return v.forEach((x, i) => plain(x, `${where}[${i}]`));
    if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.entries(v as JSON).forEach(([k, x]) => x === undefined || plain(x, `${where}.${k}`));
    }
    fail(`${what}: ${where} can't be written to the lock: options are strings, numbers, booleans, null, lists and plain objects`, at);
  };
  plain(options, "options");
  return options;
}

/**
 * This repo's modules: once everything is declared, repo() tells each one's
 * declaration (through found) its path from the declaring file (from).
 */
const modules: { what: string; module: () => Promise<unknown>; at: Place; from: Place; found: (path: string) => void }[] = [];

/** Every call of a script with options, which repo() checks with the script's rules. */
const calls: { what: string; rules: () => Promise<Rules<any>>; options: unknown; at: Place }[] = [];
/** The rules files: compile runs them, so they're sources of the lock. */
const ruleFiles: string[] = [];

/** Checks every call's options. After findModules(), so each import here is a real one. */
async function checkCalls() {
  for (const { what, rules, options, at } of calls) {
    const { validate } = await rules().catch((error) => fail(`${what}: its rules couldn't be loaded: ${(error as Error)?.message ?? error}`, at));
    if (typeof validate !== "function") fail(`${what}: its rules export no validate()`, at);
    const wrong = validate(options);
    if (wrong) fail(`${what}: ${wrong}`, at);
  }
}

/** The files import() asked for while a script's module is being found; undefined the rest of the time. */
let imported: string[] | undefined;

/** While `imported` is a list, an import is only noted: the importer gets an empty module, and nothing runs. */
function noteImports() {
  Bun.plugin({
    name: "loadout modules",
    setup(build) {
      build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        if (!imported) return undefined;
        imported.push(/^\.\.?\//.test(path) ? resolve(dirname(importer), path) : path);
        return { path, namespace: "loadout-module" };
      });
      build.onLoad({ filter: /.*/, namespace: "loadout-module" }, () => ({ contents: "export {}", loader: "ts" }));
    },
  });
}

/** Finds every module's path: what its `module` imports, without running it. */
async function findModules() {
  if (modules.length) noteImports();
  for (const { what, module, at, from, found } of modules) {
    imported = [];
    try {
      await module();
    } catch (error) {
      fail(`${what}: module failed while its import was looked up: ${(error as Error)?.message ?? error}`, at);
    }
    const files = imported;
    imported = undefined;
    const path = files[0] ?? "";
    if (files.length !== 1 || !path.startsWith("/") || /[\s']/.test(path)) {
      fail(`${what}: module imports one file of the repo: () => import("./x.ts"), a relative path without spaces or quotes`, at);
    }
    found(relative(dirname(from.file), path));
  }
}

export function script<Options = undefined>(
  name: string,
  spec: ModuleScriptSpec<Options>,
): Script<undefined extends Options ? [options?: Options] : [options: Options]>;
export function script(name: string, spec: PlainModuleScriptSpec): Script<[]>;
export function script(name: string, spec: ScriptSpec): Script<[]>;
export function script(name: string, spec: ScriptSpec & { module?: () => Promise<unknown>; rules?: () => Promise<Rules<any>> }): Script {
  const at = caller();
  const what = `script '${name}'`;
  onlyKnown(what, spec, scriptSettings, at);
  const origin = originOf(at.file);
  conflict(what, spec, ["setupOnly", "notDuringSetup"], at);
  if (spec.canWait !== undefined && spec.notDuringSetup) fail(`${what}: canWait orders a script within setup-new-machine, which a notDuringSetup script isn't part of: drop one`, at);
  const { module, rules } = spec;
  if (rules !== undefined && module === undefined) fail(`${what}: rules are a module's: give it one`, at);
  for (const other of ["runCommand", "checkCommand"]) conflict(what, spec, ["module", other], at);
  const step = stepJSON(what, spec, origin, at);
  if (spec.deleteOnceDone) {
    if (!step.check && !module) fail(`${what} sets deleteOnceDone, so it needs a check: it's done when the check passes`, at);
    if (ownFile(at.file) && !transitional.includes(name)) transitional.push(name);
  }
  spare(what, spec.keepUnused, at);
  const { origin: _o, ...rest } = step;
  const value = clean({
    description: spec.description,
    ...rest,
    modes: spec.setupOnly ? ["setup"] : spec.notDuringSetup ? ["maintain"] : undefined,
    sudo: spec.needsSudo,
    later: reason(what, spec.canWait, at),
    origin: origin || undefined,
  });
  declare(draft.scripts, "script", name, at, value);
  if (module !== undefined && ownFile(at.file)) {
    const found = (path: string) => Object.assign(value, { module: path });
    modules.push({ what, module, at, from: at, found });
  }
  if (rules !== undefined && ownFile(at.file)) {
    const found = (path: string) => {
      value.rules = path;
      // One that isn't there is assembly's to refuse, by its path.
      const full = resolve(dirname(at.file), path);
      if (existsSync(full)) ruleFiles.push(full);
    };
    modules.push({ what: `${what} rules`, module: rules, at, from: at, found });
  }
  const oracles: [string, JSON][] = [];
  const sources = typeof spec.updates === "function" ? { [name]: spec.updates } : (spec.updates ?? {});
  for (const [n, source] of Object.entries(sources)) {
    const oracle: JSON = { command: "" };
    oracles.push([n, oracle]);
    if (!ownFile(at.file)) continue;
    const found = (path: string) => Object.assign(oracle, { command: `module:${path} listOutdated`, upgrade: `module:${path} update {item}` });
    modules.push({ what: `${what} updates '${n}'`, module: source, at, from: at, found });
  }
  for (const o of spec.outdated ?? []) oracles.push([o.name ?? name, clean({ command: o.command, upgrade: o.upgradeCommand, sudo: o.needsSudo })]);
  for (const [n, o] of oracles) declare(draft.outdated, "outdated source", n, at, Object.assign(o, origin ? { origin } : {}));
  return callable<Script>("script", name, ([options, ...rest], self) => {
    const at = caller();
    if (rest.length) fail(`${what} takes its options as one value`, at);
    if (options === undefined) return { kind: "script-run", script: self };
    if (module === undefined) fail(`${what} takes no options: only a module's script does`, at);
    plainOptions(what, options, at);
    if (rules === undefined) fail(`${what} takes options, so it needs rules: () => import("./.loadout/x.rules.ts")`, at);
    calls.push({ what, rules, options, at });
    return { kind: "script-run", script: self, options };
  });
}

/** An outdated oracle of its own, outside any script. */
export function outdated(name: string, oracle: Omit<Oracle, "name">) {
  const at = caller();
  const origin = originOf(at.file);
  declare(draft.outdated, "outdated source", name, at, clean({ command: oracle.command, upgrade: oracle.upgradeCommand, sudo: oracle.needsSudo, origin: origin || undefined }));
}

// ─── data ───────────────────────────────────────────────────────────────

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ─── machines and profiles ──────────────────────────────────────────────

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

const machineSettings: Record<keyof MachineSpec<unknown>, true> = { extends: true, data: true, install: true, run: true, keepUnused: true };

function machineConfig<Data>(label: string, spec: MachineSpec<Data>, at: Place): JSON {
  onlyKnown(label, spec, machineSettings, at);
  const pm: Record<string, string> = {};
  const map = (program: string, v: string) => {
    if (program in pm) fail(`${label} installs '${program}' twice`, at);
    pm[program] = v;
  };
  for (const p of flat(spec.install)) {
    if (p.kind === "program-variant") map(p.program.name, p.variant);
    else if (p.kind === "programs-with") for (const program of p.programs) map(program.name, p.installer.name);
    else {
      const keys = variantsOf.get(p.name) ?? [];
      if (keys.length === 1) map(p.name, keys[0]);
      else if (keys.length === 0) fail(`${label} installs '${p.name}', which has no install variants`, at);
      else fail(`${label} installs '${p.name}' without saying how (it has: ${keys.join(", ")}): call an installer with it (withBrew(…)) or it with one of its own ways`, at);
    }
  }
  const scripts: JSON[] = [];
  for (const entry of flat(spec.run)) {
    const s = entry.kind === "script-run" ? entry.script : entry;
    if (scripts.some((e) => e.name === s.name)) fail(`${label} runs '${s.name}' twice`, at);
    const run: JSON = { name: s.name };
    if (entry.kind === "script-run" && entry.options !== undefined) run.options = entry.options;
    scripts.push(run);
  }
  return clean({
    extends: spec.extends && flat(spec.extends).map((p) => p.name),
    pm,
    scripts,
    data: spec.data as JSON | undefined,
  });
}

export function profile<Data = Record<string, unknown>>(name: string, spec: MachineSpec<Data>): Profile {
  const at = caller();
  spare(`profile '${name}'`, spec.keepUnused, at);
  declare(draft.profiles, "profile", name, at, machineConfig(`profile '${name}'`, spec, at));
  return { kind: "profile", name };
}

export function machine<Data = Record<string, unknown>>(name: string, spec: Omit<MachineSpec<Data>, "keepUnused">) {
  const at = caller();
  if ((spec as JSON).keepUnused !== undefined) fail(`machine '${name}' sets keepUnused, but only a profile can: a machine is used by being declared`, at);
  declare(draft.machines, "machine", name, at, machineConfig(`machine '${name}'`, spec, at));
}

// ─── the repo ───────────────────────────────────────────────────────────

const repoSettings = ["name", "stateFolder", "dotfiles", "minLoadoutVersion", "data", "parent"];

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
  parent?: { name: string; path: string };
};

/**
 * Dotfiles kept with their tools: every folder `tools` matches is a tool
 * (named after its folder), and in it `home/` is chezmoi source rooted at
 * `$HOME` and `root/` chezmoi source rooted at `/`, both optional. Compile
 * builds every tool's `home/` into `home` and every `root/` into `root`
 * (files as symlinks, committed like the lock); loadout applies `home` as
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

const toolDotfilesSettings = ["tools", "home", "root", "from"];

/** The layout's dotfiles fields, from `dotfiles` as written. */
function dotfilesLayout(dotfiles: RepoSpec<unknown>["dotfiles"]) {
  if (dotfiles === undefined || typeof dotfiles === "string") return { configs: dotfiles };
  if (typeof dotfiles !== "object" || dotfiles === null) fail("repo's dotfiles is a folder or { tools, home, root, from }");
  const unknown = Object.keys(dotfiles).filter((k) => !toolDotfilesSettings.includes(k));
  if (unknown.length) fail(`repo's dotfiles has no setting '${unknown[0]}' (its settings: ${toolDotfilesSettings.join(", ")})`);
  for (const k of toolDotfilesSettings) {
    const v = (dotfiles as Record<string, unknown>)[k];
    if (v !== undefined && typeof v !== "string") fail(`repo's dotfiles.${k} is a path, not ${typeof v}`);
  }
  if (!dotfiles.tools) fail("repo's dotfiles needs tools: the glob of the tool folders (\"loadouts/*\")");
  if (!dotfiles.home) fail("repo's dotfiles needs home: the folder compile builds the $HOME source into (\".chezmoi-home\")");
  return { configs: dotfiles.home, "root-configs": dotfiles.root, build: clean({ tools: dotfiles.tools, from: dotfiles.from }) };
}

const included = new Set<string>();
const includeGlobs: string[] = [];

/**
 * Imports every repo file the globs match (Bun.Glob; `*` and `**` match dot
 * files and folders too), in path order: the fragments of a repo that keeps
 * one per tool, so a new file needs no import of its own; a glob that
 * matches nothing yet is fine. loadout.ts awaits it before `repo()`.
 */
export async function include(...globs: string[]) {
  for (const glob of globs) {
    if (!includeGlobs.includes(glob)) includeGlobs.push(glob);
    const files = [...new Bun.Glob(glob).scanSync({ cwd: ROOT, dot: true, onlyFiles: true })]
      .filter((f) => !f.split("/").includes("node_modules"))
      .sort();
    for (const f of files) {
      const abs = resolve(ROOT, f);
      included.add(abs);
      await import(abs);
    }
  }
}

/** The SDK's modules: loadout's own, never a repo file. */
const sdkModules = ["loadout", "loadout/script"];

/**
 * The sources whose edits make the lock stale: the include() globs (so a
 * new file they'd pick up counts too), and every repo file the entry and
 * what it included reach through static imports, helpers and the data
 * schema included. The lock hashes what they match (model.SourcesHash).
 */
function sourcesFrom(entries: string[]): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const { path, kind } of transpiler.scanImports(readFileSync(f, "utf8"))) {
      // A script's module isn't part of the manifest.
      if (kind === "dynamic-import") continue;
      if (sdkModules.includes(path)) continue;
      let resolved: string;
      try {
        resolved = Bun.resolveSync(path, dirname(f));
      } catch {
        continue;
      }
      if (ownFile(resolved) && !resolved.includes("/node_modules/")) walk(resolved);
    }
  };
  for (const e of entries) walk(e);
  return [...includeGlobs, ...[...seen].map((f) => relative(ROOT, f)).sort()];
}

const entries = (m: Map<string, Entry>) => (m.size ? Object.fromEntries([...m].map(([k, e]) => [k, e.value])) : undefined);

/**
 * The repo itself: the last thing loadout.ts does, once its imports have
 * declared everything. Under `loadout compile` it prints the draft.
 */
export function repo<Data>(spec: RepoSpec<Data>): void {
  const unknown = Object.keys(spec).filter((k) => !repoSettings.includes(k));
  if (unknown.length) fail(`repo has no setting '${unknown[0]}' (its settings: ${repoSettings.join(", ")})`);
  dotfilesLayout(spec.dotfiles);
  if (process.env.LOADOUT_COMPILE) void printDraft(spec);
}

async function printDraft<Data>(spec: RepoSpec<Data>) {
  await findModules();
  await checkCalls();
  const manifest = clean({
    meta: clean({ name: spec.name, "min-tool-version": spec.minLoadoutVersion }),
    layout: clean({ state: spec.stateFolder, ...dotfilesLayout(spec.dotfiles), sources: sourcesFrom([Bun.main, ...included, ...ruleFiles]) }),
    installers: entries(draft.installers),
    programs: entries(draft.programs),
    scripts: entries(draft.scripts),
    machines: entries(draft.machines),
    outdated: entries(draft.outdated),
    data: spec.data as JSON | undefined,
  });
  const out = clean({
    manifest,
    profiles: entries(draft.profiles),
    requires: requiresOf.size ? Object.fromEntries(requiresOf) : undefined,
    spares: spares.size ? Object.fromEntries(spares) : undefined,
    transitional,
    parent: spec.parent,
  });
  process.stdout.write(JSON.stringify(out) + "\n");
}
