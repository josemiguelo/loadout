// loadout's manifest SDK, imported as "loadout". It is part of loadout, not
// of the repo: whenever loadout runs a repo's files (compile, scripts), its
// bun wrapper's preload registers this module, and compile and init write
// its types into the repo as loadout.d.ts. A repo's manifests always run
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
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── references ─────────────────────────────────────────────────────────

export type Installer = { readonly kind: "installer"; readonly name: string };
export type Program = { readonly kind: "program"; readonly name: string };
export type Script = { readonly kind: "script"; readonly name: string };
export type Profile = { readonly kind: "profile"; readonly name: string };

/** A program through one of its variants: `variant(setupBrew, "linux")`. */
export type ProgramVariant = { readonly kind: "program-variant"; readonly program: Program; readonly variant: string };
/** A script through one of its variants: `variant(hidAppleKeyboard, "arch")`. */
export type ScriptVariant = { readonly kind: "script-variant"; readonly script: Script; readonly variant: string };
/** A script with its arguments: `args(setupSsh, "id_ed25519")`. */
export type ScriptArgs = { readonly kind: "script-args"; readonly script: Script | ScriptVariant; readonly args: string[] };
/** Programs through an installer, in a machine: `via(omarchy, [curl, git])`. */
export type ViaGroup = { readonly kind: "via-group"; readonly installer: Installer; readonly programs: Program[] };

/** One, or a list of them, nested as deep as shared lists nest: flattened wherever it's read. */
export type Many<T> = T | readonly Many<T>[];
const flat = <T>(xs: Many<T> | undefined): T[] => (xs === undefined ? [] : Array.isArray(xs) ? (xs as T[]).flat(Infinity as 1) as T[] : [xs as T]);

const builtin = (name: string): Installer => ({ kind: "installer", name });
/** The built-in installers: shipped with loadout, `loadout installers` lists them. */
export const apt = builtin("apt");
export const brew = builtin("brew");
export const brewCask = builtin("brew-cask");
export const dnf = builtin("dnf");
export const dnfCopr = builtin("dnf-copr");
export const dnfRepo = builtin("dnf-repo");
export const flatpak = builtin("flatpak");
export const omarchy = builtin("omarchy");
export const omarchyAur = builtin("omarchy-aur");
export const pacman = builtin("pacman");

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
  if (!reason.trim()) fail(`${key}: spare needs a reason`, at);
  spares.set(key, reason);
}

function reason(what: string, value: string | undefined, at: Place): string | undefined {
  if (value !== undefined && !value.trim()) fail(`${what}: Empty reason; later = "why it can wait"`, at);
  return value;
}

/** The setting names given among names, for "only one of" checks. */
function conflict(what: string, spec: object, names: string[], at: Place) {
  const given = names.filter((n) => (spec as JSON)[n] !== undefined);
  if (given.length > 1) fail(`${what}: ${given.join(" and ")} can't go together: give one`, at);
}

const VERSION_REGEX = "([0-9]+\\.[0-9][0-9.]*)";

/**
 * A repo file as a command (`runScript(".loadout/x.ts check")`) or a param
 * value (`file("repos/x.repo")`): its path from the declaring file's folder,
 * run with the interpreter its `#!` line names.
 */
export const runScript = (command: string) => `file:${command}`;
export const file = (path: string) => `file:${path}`;

/**
 * Commands that must all pass, joined with `&&`; one holding `||` or `;` is
 * grouped in `{ …; }` first (a single one too), so the join can't change
 * what it means.
 */
function allOf(commands: string | string[]): string {
  return (typeof commands === "string" ? [commands] : commands).map((c) => (c.includes("||") || c.includes(";") ? `{ ${c}; }` : c)).join(" && ");
}

const distinct = <T>(xs: T[]) => [...new Set(xs)];

// ─── installers ─────────────────────────────────────────────────────────

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

export function installer(name: string, spec: InstallerSpec): Installer {
  const at = caller();
  spare(`installer '${name}'`, spec.spare, at);
  declare(draft.installers, "installer", name, at, clean({
    probe: spec.probe,
    params: spec.params,
    install: spec.install,
    check: spec.check,
    regex: spec.regex ?? VERSION_REGEX,
    outdated: spec.outdated,
    "outdated-all": spec.outdatedAll,
    upgrade: spec.upgrade,
    sudo: spec.needsSudo,
    origin: originOf(at.file) || undefined,
  }));
  return { kind: "installer", name };
}

/** Every install through installer waits for these programs. */
export function requires(installer: Installer, programs: Many<Program>) {
  if (!ownFile(caller().file)) return;
  requiresOf.set(installer.name, [...(requiresOf.get(installer.name) ?? []), ...flat(programs).map((p) => p.name)]);
}

// ─── programs ───────────────────────────────────────────────────────────

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
  provides?: Record<string, { at?: string }>;
  spare?: string;
};

type VariantEntry = { readonly kind: "variant"; readonly key: string; readonly spec: VariantSpec; readonly at: Place };

/** A variant through installer that needs a setting: `via(brewTapCask, { params: { tap: "…" } })`. */
export function via(installer: Installer, spec: VariantSpec): VariantEntry;
/** In a machine: programs through installer, `via(omarchy, [curl, git])`. */
export function via(installer: Installer, programs: Many<Program>[]): ViaGroup;
export function via(installer: Installer, arg: VariantSpec | Many<Program>[]): VariantEntry | ViaGroup {
  if (Array.isArray(arg)) return { kind: "via-group", installer, programs: flat(arg) };
  return { kind: "variant", key: installer.name, spec: arg, at: caller() };
}

/** Its own way to install (`custom("linux", {...})`); named "custom" when unnamed. */
export function custom(name: string, spec: VariantSpec): VariantEntry;
export function custom(spec: VariantSpec): VariantEntry;
export function custom(a: string | VariantSpec, b?: VariantSpec): VariantEntry {
  return typeof a === "string" ? { kind: "variant", key: a, spec: b!, at: caller() } : { kind: "variant", key: "custom", spec: a, at: caller() };
}

function variantJSON(what: string, v: VariantSpec, at: Place): JSON {
  conflict(what, v, ["version", "present", "managedBy"], at);
  conflict(what, v, ["command", "installedBy", "managedBy"], at);
  let command = v.command;
  let check: string | undefined;
  let regex = v.regex;
  let present = false;
  if (v.installedBy !== undefined) command = runScript(v.installedBy);
  if (v.managedBy !== undefined) {
    command = `${runScript(v.managedBy)} install`;
    check = `${runScript(v.managedBy)} check`;
    present = regex === undefined;
  } else if (v.version !== undefined) {
    check = v.version;
    regex ??= VERSION_REGEX;
  } else if (v.present !== undefined) {
    check = v.present;
    present = true;
  }
  return clean({
    pkg: v.pkg,
    command,
    check,
    regex,
    present,
    probe: v.probe,
    outdated: v.outdated,
    with: v.params,
    // An explicit `needsSudo: false` is kept: it overrides the installer's.
    sudo: v.needsSudo === undefined ? undefined : v.needsSudo,
    "depends-on": v.dependsOn && distinct(flat(v.dependsOn).map((p) => p.name)),
    provides: v.provides && Object.entries(v.provides).map(([binary, p]) => clean({ binary, at: p.at })),
  });
}

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

export function program(name: string, spec: ProgramSpec): Program {
  const at = caller();
  const what = `program '${name}'`;
  if (spec.regex !== undefined && spec.version === undefined) fail(`${what}: regex reads its version command's output: set version too`, at);
  conflict(what, spec, ["outdated", "updatesManagedBy"], at);
  if (spec.upgrade !== undefined && spec.updatesManagedBy !== undefined) fail(`${what}: updatesManagedBy updates through its script (\`<script> update\`): drop upgrade`, at);
  if (spec.upgrade !== undefined && spec.outdated === undefined) fail(`${what}: upgrade moves the program outdated says is behind: set outdated too`, at);
  const install: JSON = {};
  for (const entry of spec.install) {
    const key = entry.kind === "installer" ? entry.name : entry.key;
    if (key in install) fail(`${what} has two '${key}' variants`, entry.kind === "installer" ? at : entry.at);
    if (entry.kind === "installer") install[key] = {};
    else {
      install[key] = variantJSON(`${what} via '${key}'`, entry.spec, entry.at);
      spare(`${what} via '${key}'`, entry.spec.spare, entry.at);
    }
  }
  if (Object.keys(install).length === 0) fail(`${what} has no way to install it: list its installers or variants in install`, at);
  spare(what, spec.spare, at);
  const origin = originOf(at.file);
  if (!variantsOf.has(name)) variantsOf.set(name, Object.keys(install));
  declare(draft.programs, "program", name, at, clean({
    description: spec.description,
    tags: spec.tags,
    "depends-on": spec.dependsOn && distinct(flat(spec.dependsOn).map((p) => p.name)),
    version: spec.version === undefined ? undefined : clean({ command: spec.version, regex: spec.regex ?? VERSION_REGEX, origin: origin || undefined, path: spec.path }),
    install,
    outdated:
      spec.updatesManagedBy !== undefined
        ? { command: runScript(spec.updatesManagedBy), upgrade: `${runScript(spec.updatesManagedBy)} update` }
        : spec.outdated !== undefined
          ? clean({ command: spec.outdated, upgrade: spec.upgrade })
          : undefined,
    path: spec.path,
    later: reason(what, spec.later, at),
    origin: origin || undefined,
  }));
  return { kind: "program", name };
}

/** A program or script through one of its variants. */
export function variant(program: Program, variant: string): ProgramVariant;
export function variant(script: Script, variant: string): ScriptVariant;
export function variant(ref: Program | Script, variant: string): ProgramVariant | ScriptVariant {
  return ref.kind === "program" ? { kind: "program-variant", program: ref, variant } : { kind: "script-variant", script: ref, variant };
}

// ─── scripts ────────────────────────────────────────────────────────────

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
export type Oracle = { name?: string; command: string; upgrade?: string; needsSudo?: boolean };

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
  variants?: Record<string, StepSpec & { transitional?: never }>;
};

function stepJSON(what: string, s: StepSpec, origin: string, at: Place): JSON {
  conflict(what, s, ["file", "managedBy"], at);
  conflict(what, s, ["check", "managedBy"], at);
  return clean({
    file: s.managedBy ?? s.file,
    run: s.run === undefined ? undefined : allOf(s.run),
    check: s.managedBy !== undefined ? `${runScript(s.managedBy)} check "$@"` : s.check === undefined ? undefined : allOf(s.check),
    after: s.runAfter && distinct(flat(s.runAfter).map((r) => `${r.kind}s.${r.name}`)),
    origin: origin || undefined,
  });
}

export function script(name: string, spec: ScriptSpec): Script {
  const at = caller();
  const what = `script '${name}'`;
  const origin = originOf(at.file);
  conflict(what, spec, ["setupOnly", "maintainOnly"], at);
  if (spec.later !== undefined && spec.maintainOnly) fail(`${what}: later orders a script within setup-new-machine, which a maintainOnly script isn't part of: drop one`, at);
  const step = stepJSON(what, spec, origin, at);
  const variants: JSON = {};
  for (const [v, s] of Object.entries(spec.variants ?? {})) {
    if ((s as JSON).transitional) fail(`${what}: transitional goes on the script, not on its '${v}' variant`, at);
    variants[v] = stepJSON(`${what} as '${v}'`, s, origin, at);
    spare(`${what} as '${v}'`, s.spare, at);
  }
  if (spec.transitional) {
    const checkless = Object.keys(variants).length ? Object.values(variants).some((v) => !(v as JSON).check) : !step.check;
    if (checkless) fail(`${what} is transitional, so it needs a check: it's done when the check passes`, at);
    if (ownFile(at.file) && !transitional.includes(name)) transitional.push(name);
  }
  spare(what, spec.spare, at);
  const { origin: _o, ...rest } = step;
  declare(draft.scripts, "script", name, at, clean({
    description: spec.description,
    ...rest,
    modes: spec.setupOnly ? ["setup"] : spec.maintainOnly ? ["maintain"] : undefined,
    sudo: spec.needsSudo,
    later: reason(what, spec.later, at),
    variants,
    origin: origin || undefined,
  }));
  const oracles: [string, JSON][] = [];
  if (spec.updatesManagedBy !== undefined) {
    const s = runScript(spec.updatesManagedBy);
    oracles.push([name, { command: s, upgrade: `${s} update {item}` }]);
  }
  for (const o of spec.outdated ?? []) oracles.push([o.name ?? name, clean({ command: o.command, upgrade: o.upgrade, sudo: o.needsSudo })]);
  for (const [n, o] of oracles) declare(draft.outdated, "outdated source", n, at, { ...o, ...(origin ? { origin } : {}) });
  return { kind: "script", name };
}

/** A script with arguments, as the machine runs it: each is one word or more. */
export const args = (script: Script | ScriptVariant, ...args: string[]): ScriptArgs => ({ kind: "script-args", script, args });

/** An outdated oracle of its own, outside any script. */
export function outdated(name: string, oracle: Omit<Oracle, "name">) {
  const at = caller();
  const origin = originOf(at.file);
  declare(draft.outdated, "outdated source", name, at, clean({ command: oracle.command, upgrade: oracle.upgrade, sudo: oracle.needsSudo, origin: origin || undefined }));
}

// ─── data ───────────────────────────────────────────────────────────────

/** A data setting's kind and default, in the repo's data schema. */
export const flag = (value: boolean) => value;
export const text = (value: string) => value;
export const number = (value: number) => value;
export const whole = (value: number) => value;
export const list = (value: string[]) => value;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ─── machines and profiles ──────────────────────────────────────────────

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

function machineConfig<Data>(label: string, spec: MachineSpec<Data>, at: Place): JSON {
  const pm: Record<string, string> = {};
  const map = (program: string, v: string) => {
    if (program in pm) fail(`${label} installs '${program}' twice`, at);
    pm[program] = v;
  };
  for (const p of flat(spec.install)) {
    if (p.kind === "program-variant") map(p.program.name, p.variant);
    else if (p.kind === "via-group") for (const program of p.programs) map(program.name, p.installer.name);
    else {
      const keys = variantsOf.get(p.name) ?? [];
      if (keys.length === 1) map(p.name, keys[0]);
      else if (keys.length === 0) fail(`${label} installs '${p.name}', which has no install variants`, at);
      else fail(`${label} installs '${p.name}' without saying how (it has: ${keys.join(", ")}): use variant()`, at);
    }
  }
  const scripts: string[] = [];
  const scriptVariants: Record<string, string> = {};
  for (const entry of flat(spec.run)) {
    const target = entry.kind === "script-args" ? entry.script : entry;
    const s = target.kind === "script-variant" ? target.script : target;
    if (target.kind === "script-variant") scriptVariants[s.name] = target.variant;
    if (scripts.some((e) => e.split(" ")[0] === s.name)) fail(`${label} runs '${s.name}' twice`, at);
    scripts.push([s.name, ...(entry.kind === "script-args" ? entry.args : [])].join(" "));
  }
  return clean({
    extends: spec.extends && flat(spec.extends).map((p) => p.name),
    pm,
    scripts,
    "script-variants": scriptVariants,
    data: spec.data as JSON | undefined,
  });
}

export function profile<Data = Record<string, unknown>>(name: string, spec: MachineSpec<Data>): Profile {
  const at = caller();
  spare(`profile '${name}'`, spec.spare, at);
  declare(draft.profiles, "profile", name, at, machineConfig(`profile '${name}'`, spec, at));
  return { kind: "profile", name };
}

export function machine<Data = Record<string, unknown>>(name: string, spec: Omit<MachineSpec<Data>, "spare">) {
  const at = caller();
  if ((spec as JSON).spare !== undefined) fail(`machine '${name}' is marked spare, but only a profile can be: a machine is used by being declared`, at);
  declare(draft.machines, "machine", name, at, machineConfig(`machine '${name}'`, spec, at));
}

// ─── the repo ───────────────────────────────────────────────────────────

const repoSettings = ["name", "state", "configs", "minToolVersion", "data", "parent"];

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
  parent?: { name: string; path: string };
};

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
    for (const { path } of transpiler.scanImports(readFileSync(f, "utf8"))) {
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
export function repo<Data>(spec: RepoSpec<Data>) {
  const unknown = Object.keys(spec).filter((k) => !repoSettings.includes(k));
  if (unknown.length) fail(`repo has no setting '${unknown[0]}' (its settings: ${repoSettings.join(", ")})`);
  if (!process.env.LOADOUT_COMPILE) return;
  const manifest = clean({
    meta: clean({ name: spec.name, "min-tool-version": spec.minToolVersion }),
    layout: clean({ state: spec.state, configs: spec.configs, sources: sourcesFrom([Bun.main, ...included]) }),
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
