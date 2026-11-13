// Package model is a config repo, resolved: what a manifest compiles to,
// what loadout.lock.json holds, and what every engine reads.
//
// The model is plain data: interfaces, built with the new… functions below
// (every field at its zero value unless given), copied with spreads, never
// mutated once another value holds it. Go's methods are functions taking the
// value first (m.ResolveInstall(p, k) is resolveInstall(m, p, k)). A Go
// pointer field is an optional one (undefined = nil); a Go slice is an array,
// always present, except ScriptStep.modes, where nil (the default) and empty
// differ.

import { cleanPath, cut, cutPrefix, joinPath, sortedStrings, slicesEqual, trimPrefix, trimRight, trimSpace } from "./gostd.ts";
import type { JSONObject } from "./json.ts";
import { concat, distinct, mapOf, mapValues, plus } from "./map.ts";
import { ManifestException } from "./refusal.ts";

/**
 * Manifest is a config repo, resolved. Machines are already flattened
 * (profiles merged in, then dropped) and carry their whole data.
 */
export interface Manifest {
  meta: Meta;
  layout: RepoLayout;
  /**
   * installers are the install mechanisms (`dnf`, `brew-cask`, ...) defined
   * once per repo. Probe, install/check patterns, and regex are properties
   * of the mechanism; programs reference installers instead of restating them.
   */
  installers: Map<string, Installer>;
  programs: Map<string, Program>;
  scripts: Map<string, ScriptStep>;
  /** machines is every machine, keyed by hostname. */
  machines: Map<string, MachineConfig>;
  /**
   * outdated holds the custom `loadout outdated` oracles beyond the
   * installer ones — entries whose command prints one `<item> <current>
   * <candidate>` line per outdated item (nothing when current). The entry
   * name becomes the row's source tag. The built-in self-version row is
   * conceptually the first of these, hardcoded.
   */
  outdated: Map<string, OutdatedSource>;
  /**
   * builtinInstallers says which of installers came from installerLibrary
   * rather than the repo — provenance for `explain`/`installers`, never
   * behavior.
   */
  builtinInstallers: string[];
  /** data is every per-machine data key with its default. */
  data: JSONObject;
  /**
   * toolPaths is where each binary the machine in view provides lands, for
   * the binaries whose variant says `at` (forMachine; empty before it). Put
   * first on PATH for every command that goes through that binary. Never
   * written to the lock.
   */
  toolPaths: Map<string, string[]>;
}

/** newManifest is a Manifest with every field not given at its zero value. */
export function newManifest(m: Partial<Manifest> = {}): Manifest {
  return {
    meta: newMeta(),
    layout: newRepoLayout(),
    installers: new Map(),
    programs: new Map(),
    scripts: new Map(),
    machines: new Map(),
    outdated: new Map(),
    builtinInstallers: [],
    data: new Map(),
    toolPaths: new Map(),
    ...m,
  };
}

/**
 * resolveInstall is everything the key variant of program programName
 * resolves to. Assumes the manifest validated (program and key exist).
 */
export function resolveInstall(m: Manifest, programName: string, key: string): ResolvedInstall {
  const program = m.programs.get(programName);
  if (program === undefined) throw new Error(`no program ${JSON.stringify(programName)}`);
  const variant = program.install.get(key);
  if (variant === undefined) throw new Error(`program ${JSON.stringify(programName)} has no variant ${JSON.stringify(key)}`);
  // An explicit `installer` reference wins; otherwise a variant whose key
  // names an installer uses it.
  const installer = m.installers.get(variant.installer ?? key);
  const pkg = variant.pkg ?? programName;
  // {pkg} plus whatever the installer declared as params — validated at
  // compile, so an unsubstituted placeholder can't reach a shell here.
  const values = plus(mapOf(["pkg", pkg]), variant.with);
  const sub = (s: string): string => {
    for (const [k, v] of values) s = s.replaceAll("{" + k + "}", v);
    return s;
  };
  const field = (own: string | undefined, of: (i: Installer) => string | undefined): string | undefined => {
    if (own !== undefined) return own;
    if (installer !== undefined) return of(installer);
    return undefined;
  };
  const checkCommand = field(variant.check, (i) => i.check);
  // A yes/no check records no version, so it needs no regex.
  const regex = variant.present ? undefined : field(variant.regex, (i) => i.regex);
  // Outdated precedence: explicit per-variant oracle, else the program's
  // own check (read with its version regex), else the installer's batch
  // oracle (one command for all its packages), else the installer's
  // per-package pattern.
  const explicitOutdated = variant.outdated ?? program.outdated?.command;
  let outdatedRegex = regex;
  if (variant.outdated === undefined && program.outdated !== undefined) {
    outdatedRegex = program.version?.regex;
  }
  const batch = explicitOutdated === undefined && installer !== undefined ? installer.outdatedAll : undefined;
  let outdatedCommand = explicitOutdated;
  if (outdatedCommand === undefined && batch === undefined && installer !== undefined) {
    outdatedCommand = installer.outdated;
  }
  let installerName = variant.installer;
  if (installerName === undefined && m.installers.has(key)) installerName = key;
  const probe = field(variant.probe, (i) => i.probe);
  // Through a provided tool, its folder comes first: on a fresh machine it
  // isn't on PATH yet (Homebrew).
  const probePath = probe !== undefined ? (m.toolPaths.get(probe) ?? []) : [];
  const reach = concat(probePath, program.path);
  // Each command runs where the file that wrote it lives: a variant's own
  // override in the program's directory, a pattern in its installer's.
  const installerOrigin = installer?.origin ?? "";
  const originOf = (override: string | undefined): string => (override !== undefined ? program.origin : installerOrigin);

  const resolved: ResolvedInstall = {
    commandOrigin: originOf(variant.command),
    probe,
    path: reach,
    sudo: variant.sudo ?? installer?.sudo ?? false,
  };
  const c = field(variant.command, (i) => i.install);
  if (c !== undefined) resolved.command = sub(c);
  // A check through the mechanism carries its probe; the program's own
  // `version` fallback is the program itself and carries none.
  if (checkCommand !== undefined && (regex !== undefined || variant.present)) {
    resolved.check = {
      command: sub(checkCommand),
      regex,
      probe,
      origin: originOf(variant.check),
      path: [...reach],
    };
  } else {
    resolved.check = program.version;
  }
  if (outdatedCommand !== undefined && outdatedRegex !== undefined) {
    resolved.outdated = {
      command: sub(outdatedCommand),
      regex: outdatedRegex,
      origin: originOf(explicitOutdated),
      path: [...reach],
    };
  }
  if (batch !== undefined && regex !== undefined && installerName !== undefined) {
    resolved.outdatedAll = {
      installer: installerName,
      command: batch,
      pkg,
      regex,
      origin: installerOrigin,
      path: [...probePath],
    };
  }
  if (installer?.upgrade !== undefined && installerName !== undefined) {
    resolved.upgradeWith = { installer: installerName, command: installer.upgrade, origin: installerOrigin };
  }
  return resolved;
}

/** checkFor is the version check to observe programName with when mapped to key (undefined = unmapped). */
export function checkFor(m: Manifest, programName: string, key: string | undefined): VersionCheck | undefined {
  if (key === undefined) return m.programs.get(programName)?.version;
  return resolveInstall(m, programName, key).check;
}

/**
 * dependenciesOf is what programName needs installed first on a machine
 * mapping it to key: the program's own `depends-on`, that variant's (a COPR
 * needs dnf-plugins-core; the same program from pacman needs nothing), and
 * what the variant's installer requires of everything it installs (brew
 * needs setup-brew), except the program itself. An undefined key (no machine
 * in view) gives the program's alone.
 */
export function dependenciesOf(m: Manifest, programName: string, key: string | undefined): string[] {
  const program = m.programs.get(programName);
  if (program === undefined) return [];
  let variantDeps: string[] = [];
  const required: string[] = [];
  if (key !== undefined) {
    const variant = program.install.get(key);
    if (variant !== undefined) {
      variantDeps = variant.dependsOn;
      const installer = m.installers.get(variant.installer ?? key);
      if (installer !== undefined) {
        for (const r of installer.requires) if (r !== programName) required.push(r);
      }
    }
  }
  return distinct(concat(program.dependsOn, variantDeps, required));
}

/**
 * forMachine is this manifest as machine sees it: each script it runs as a
 * variant becomes that variant, so engines read scripts.get(name) and never
 * ask which variant a machine picked.
 */
export function forMachine(m: Manifest, machine: string): Manifest {
  const config = m.machines.get(machine);
  if (config === undefined) return m;
  const out: Manifest = { ...m };
  if (config.scriptVariants.size > 0) {
    out.scripts = mapValues(m.scripts, (name, step) => {
      const pick = config.scriptVariants.get(name);
      return pick !== undefined ? scriptVariant(step, pick) : step;
    });
  }
  const paths = new Map<string, string[]>();
  for (const [name, key] of config.pm) {
    const variant = m.programs.get(name)?.install.get(key);
    if (variant === undefined) continue;
    for (const p of variant.provides) {
      if (p.at === undefined) continue;
      const have = paths.get(p.binary) ?? [];
      if (!have.includes(p.at)) paths.set(p.binary, [...have, p.at]);
    }
  }
  out.toolPaths = paths;
  const scriptPath = providedFolders(paths);
  if (scriptPath.length > 0) {
    out.scripts = mapValues(out.scripts, (_, step) => ({ ...step, path: scriptPath }));
    out.outdated = mapValues(out.outdated, (_, source) => ({ ...source, path: scriptPath }));
  }
  return out;
}

/** providedFolders is every folder in paths, once, by binary name: what scripts get first on PATH. */
export function providedFolders(paths: ReadonlyMap<string, string[]>): string[] {
  const out: string[] = [];
  for (const binary of sortedStrings(paths.keys())) {
    for (const dir of paths.get(binary)!) if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/** toolPathOf is the folders put first on PATH for installer's own commands (its upgrade), from toolPaths. */
export function toolPathOf(m: Manifest, installer: string): string[] {
  const i = m.installers.get(installer);
  if (i?.probe === undefined) return [];
  return m.toolPaths.get(i.probe) ?? [];
}

/** ResolvedInstall is a program's install variant with all installer defaults applied. */
export interface ResolvedInstall {
  /** command is the shell command to install (undefined only in invalid manifests — validation rejects it). */
  command?: string;
  /** commandOrigin is where command runs: the declaring file's repo-relative directory. */
  commandOrigin: string;
  /** check is the version check for this variant, falling back to the program's `version`. */
  check?: VersionCheck;
  /** probe is the binary that must exist before installing, or undefined for no probe. */
  probe?: string;
  /**
   * outdated is the command reporting the version available from the
   * remote source (its output should be just the candidate version; the
   * shared regex extracts it), or undefined when this variant has no update oracle.
   */
  outdated?: VersionCheck;
  /** outdatedAll is the installer's batch oracle covering this variant, when it has one. */
  outdatedAll?: BatchOracle;
  /** upgradeWith is how this variant upgrades in place, when its mechanism can. */
  upgradeWith?: UpgradeMechanism;
  /** sudo says command needs sudo's password without saying `sudo` itself (see Installer.sudo). */
  sudo: boolean;
  /** path is the directories put first on PATH for command (see Program.path). */
  path: string[];
}

/** UpgradeMechanism is how a variant's mechanism upgrades: all of it, in one command. */
export interface UpgradeMechanism {
  installer: string;
  command: string;
  /** origin is the installer file's repo-relative directory, where command runs. */
  origin: string;
}

/**
 * BatchOracle is one installer-wide `outdated-all` command: it prints a
 * `<pkg> <candidate>` line per outdated package, so `loadout outdated` asks
 * each remote once instead of once per program. regex extracts the version
 * from the candidate token, program by program.
 */
export interface BatchOracle {
  installer: string;
  command: string;
  pkg: string;
  regex: string;
  /** origin is the installer file's repo-relative directory, where command runs. */
  origin: string;
  /** path is put first on PATH for command: where its tool lands (Manifest.toolPaths). */
  path: string[];
}

/** Installer is an install mechanism. */
export interface Installer {
  /** probe is the binary that must exist (`command -v`) before installing via this mechanism. */
  probe?: string;
  /**
   * params are the named values this mechanism needs per program, beyond
   * the package id: `params = ["copr"]` makes `{copr}` substitutable in
   * every pattern below, and every variant using this installer must supply
   * it in its `with` table. Declared, never inferred — an undeclared `with`
   * key and a missing declared one are both errors. "pkg" is reserved.
   */
  params: string[];
  /** install is the install command pattern; `{pkg}` is replaced with the package id. */
  install?: string;
  /** check is the version check command pattern; `{pkg}` is replaced with the package id. */
  check?: string;
  /** regex extracts the version from check's output (capture group 1). */
  regex?: string;
  /**
   * outdated is the pattern printing the version available from the remote
   * source for `{pkg}` (nothing when up to date); regex extracts it. Powers
   * `loadout outdated`.
   */
  outdated?: string;
  /**
   * outdatedAll is the batch form of outdated (`outdated-all`): ONE command
   * printing a `<pkg> <candidate>` line per outdated package this installer
   * manages. When present it replaces the per-package outdated pattern.
   */
  outdatedAll?: string;
  /**
   * upgrade upgrades EVERYTHING this mechanism manages, in one command —
   * there is no per-package form on purpose (contract 15): partial upgrades
   * are unsupported on Arch, discouraged on Fedora, and a package manager
   * resolves its own transaction anyway. Converge never runs this;
   * `loadout upgrade` is the explicit verb.
   */
  upgrade?: string;
  /**
   * sudo says install and upgrade need sudo's password but don't say
   * `sudo` themselves: they call it from inside (`omarchy pkg add`, a
   * `file:` script). A run whose plan holds a step that needs sudo (this,
   * or a command that visibly runs it) asks for the password once, before
   * the first step, and keeps sudo's credentials fresh until it ends.
   * Declared, never guessed: nothing reads a script to find sudo in it.
   * Same for `sudo` on install variants, scripts and `outdated` sources.
   */
  sudo: boolean;
  /**
   * requires is the programs every program installed through this
   * installer depends on (setup-brew before any brew install). A required
   * program installed through this same installer is exempt from its own rule.
   */
  requires: string[];
  /**
   * origin is the repo-relative directory of the declaring file ("" = repo
   * root): paths resolve and commands run there.
   */
  origin: string;
}

/** newInstaller is an Installer with every field not given at its zero value. */
export function newInstaller(i: Partial<Installer> = {}): Installer {
  return { params: [], sudo: false, requires: [], origin: "", ...i };
}

/**
 * InstallVariant is one entry of a program's install table, keyed by its
 * installer's name or, for a command of its own, by a name the program
 * picks. Every field is optional: the installer supplies defaults, and `pkg`
 * defaults to the program name — so the empty variant means "the standard
 * package".
 */
export interface InstallVariant {
  /** installer provides defaults; defaults to the variant key when that names one. */
  installer?: string;
  /** pkg is the package id within the installer's namespace; defaults to the program name. */
  pkg?: string;
  /** command is the full install command, replacing the installer's pattern. `file:` prefix allowed. */
  command?: string;
  /** check is the version check command, replacing the installer's pattern. */
  check?: string;
  /** regex is the version regex, replacing the installer's. */
  regex?: string;
  /** present says the check only says yes or no: exit 0 = installed, no version recorded. */
  present: boolean;
  /** probe is the probe binary, replacing the installer's. */
  probe?: string;
  /** outdated is the remote-candidate command, replacing the installer's (see Installer.outdated). */
  outdated?: string;
  /** with holds values for the installer's params; each becomes `{name}` in the resolved commands. */
  with: Map<string, string>;
  /** sudo replaces the installer's Installer.sudo for this variant's install command. */
  sudo?: boolean;
  /**
   * dependsOn is the programs THIS variant needs first (`depends-on`), on
   * top of the program's own — for prerequisites of one mechanism only,
   * which would otherwise drag e.g. a dnf package onto a pacman machine.
   */
  dependsOn: string[];
  /**
   * provides is the binaries this variant puts on the machine (`flatpak`,
   * `brew`), so a plan that installs it may install, after it, what goes
   * through them: their probe needn't be there before the run.
   */
  provides: Provides[];
}

/** newInstallVariant is an InstallVariant with every field not given at its zero value. */
export function newInstallVariant(v: Partial<InstallVariant> = {}): InstallVariant {
  return { present: false, with: new Map(), dependsOn: [], provides: [], ...v };
}

/** Provides is a binary a variant provides, and the folder it lands in when that isn't on PATH yet. */
export interface Provides {
  binary: string;
  at?: string;
}

/**
 * MachineConfig is a machine as the engines see it: its profiles merged in
 * (contract 2), one program mapping and one script list, and its whole data.
 */
export interface MachineConfig {
  /** extends is the profiles this machine was built on, in order; kept for `explain`. */
  extends: string[];
  /**
   * pm says which entry of each program's `install` table this machine
   * uses, keyed by program name. Every program a machine installs must be mapped.
   */
  pm: Map<string, string>;
  /**
   * scripts this machine runs: entries are `"name"` or `"name args..."`
   * (first word = script name, rest = arguments passed as positional
   * parameters to `file` scripts and their checks). Scripts run and are
   * observed only on machines that opt in.
   */
  scripts: string[];
  /** scriptVariants is the variant this machine runs (`script-variants`), for each of its scripts that has variants. */
  scriptVariants: Map<string, string>;
  /** data is the machine's whole data: defaults, profiles, its own. */
  data: JSONObject;
  /**
   * label is what declared it (`machine 'x'`, `profile 'y'`), for
   * messages. Never written to the lock.
   */
  label: string;
}

/** newMachineConfig is a MachineConfig with every field not given at its zero value. */
export function newMachineConfig(c: Partial<MachineConfig> = {}): MachineConfig {
  return { extends: [], pm: new Map(), scripts: [], scriptVariants: new Map(), data: new Map(), label: "", ...c };
}

/** scriptArgs is c.scripts parsed into script name -> argument string (see scriptEntry). */
export function scriptArgs(c: MachineConfig): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of c.scripts) {
    const [name, args] = scriptEntry(entry);
    out.set(name, args);
  }
  return out;
}

const whitespace = /[ \t\n\x0B\f\r]+/;

/**
 * scriptEntry is one `scripts` entry as [name, arguments]: words split on
 * any whitespace and the arguments re-joined with single spaces. The
 * arguments are pasted into a shell command line, where a newline would end
 * the command.
 */
export function scriptEntry(entry: string): [name: string, args: string] {
  const words = trimSpace(entry).split(whitespace);
  return [words[0]!, words.slice(1).join(" ")];
}

/** Meta is the repo's name, the loadout it needs and the bun its scripts run with. */
export interface Meta {
  name: string;
  /** minToolVersion is the oldest loadout that may read the lock (`min-tool-version`). */
  minToolVersion?: string;
  /**
   * bun is the bun version loadout downloads and puts first on PATH for
   * every manifest command (`bun`), so a `#!/usr/bin/env bun` script runs
   * before anything is installed; undefined = none, the machine's own PATH.
   */
  bun?: string;
}

/** newMeta is a Meta with every field not given at its zero value. */
export function newMeta(m: Partial<Meta> = {}): Meta {
  return { name: "", ...m };
}

/**
 * RepoLayout is where the repo keeps what loadout writes and reads besides
 * the manifests. Paths are relative to the repo root.
 */
export interface RepoLayout {
  /** state is the state directory: one `<machine>.json` per machine. Required. */
  state: string;
  /** configs is the chezmoi source root, when the repo holds dotfiles. */
  configs?: string;
  /**
   * sources is the globs of the manifest sources, in compile order. The
   * lock's hash covers the files they match, so an edit the lock hasn't
   * seen is refused.
   */
  sources: string[];
  /** parent is the repo this one builds on, for a child repo (contract 18); undefined for any other. */
  parent?: ParentLayout;
}

/** newRepoLayout is a RepoLayout with every field not given at its zero value. */
export function newRepoLayout(l: Partial<RepoLayout> = {}): RepoLayout {
  return { state: "", sources: [], ...l };
}

/**
 * ParentLayout is a child repo's parent, as its lock records it: the public
 * repo whose programs, scripts, installers, profiles and data schema the
 * child's manifests use by name. Its declarations in the child's lock carry
 * parent origins (originParent) and run in path.
 */
export interface ParentLayout {
  /** name is what messages call it: "parent dotfiles". */
  name: string;
  /** path is its checkout, as written: `~/…`, absolute, or relative to the child's root. */
  path: string;
  /** state is its state directory, read (never written) for the fleet view. */
  state: string;
  /** configs is its chezmoi source, applied beside the child's. */
  configs?: string;
  /** sources is its manifest globs, from its own lock. */
  sources: string[];
  /**
   * hash is the sha256 of the files sources match (sourcesHash): a change
   * is refused until the child recompiles.
   */
  hash: string;
}

/** newParentLayout is a ParentLayout with every field not given at its zero value. */
export function newParentLayout(p: Partial<ParentLayout> = {}): ParentLayout {
  return { name: "", path: "", state: "", sources: [], hash: "", ...p };
}

/**
 * parentRoot is p.path as a directory: `~/…` under home, an absolute path as
 * written, anything else under childRoot. An empty home means HOME is unset.
 * Throws a ManifestException when it can't place it.
 */
export function parentRoot(p: ParentLayout, home: string, childRoot: string): string {
  if (p.path === "~" || p.path.startsWith("~/")) {
    if (home === "") throw new ManifestException(`HOME is unset: can't place parent ${p.name} at ${p.path}`);
    return cleanPath(trimRight(home, "/") + trimPrefix(p.path, "~"));
  }
  if (p.path.startsWith("/")) return cleanPath(p.path);
  return cleanPath(joinPath(childRoot, p.path));
}

/**
 * A declaration's origin, as the lock records it: the repo-relative folder
 * of the file that wrote it, where its commands run and its `file:` paths
 * resolve. In a child repo's lock, a declaration of its parent's is that
 * folder in the parent, prefixed originParent.
 */
export const originParent = "parent:";

/** isParentOrigin says whether origin is the parent's (Origin.isParent). */
export function isParentOrigin(origin: string): boolean {
  return origin.startsWith(originParent);
}

/** originFolder is the folder, relative to its repo's root (Origin.folder). */
export function originFolder(origin: string): string {
  return trimPrefix(origin, originParent);
}

/** parentOrigin is folder as a parent's origin (Origin.ofParent). */
export function parentOrigin(folder: string): string {
  return originParent + folder;
}

/**
 * installFilePrefix starts commands (install variant `command`s, installer
 * patterns, oracles and any check command) that name a script file relative
 * to the declaring file's directory — where the command also runs —
 * validated at compile to exist inside the repo, instead of an inline
 * command. Tokens after the first space are arguments, so the path itself
 * can't contain spaces.
 */
export const installFilePrefix = "file:";

/** expandFilePrefix expands a `file:path args…` command to fileLine(path, args); others pass through. */
export function expandFilePrefix(command: string): string {
  const [spec, ok] = cutPrefix(command, installFilePrefix);
  if (!ok) return command;
  const [p, args] = cut(spec, " ");
  return fileLine(p, args);
}

/**
 * fileLine runs the repo script at path with args the way the kernel runs an
 * executable: with the interpreter its first line names (`#!/usr/bin/env
 * bun`, `#!/bin/bash`), else sh. The line is read when the command runs, so
 * a script file is never read here, and needn't be executable.
 */
export function fileLine(path: string, args: string): string {
  let quoted = "'" + path + "'";
  if (args !== "") quoted += " " + args;
  return "{ l=$(head -n 1 '" + path + "'); case $l in '#!'*) ${l#??} " + quoted + ";; *) sh " + quoted + ";; esac; }";
}

/**
 * fileLineShape matches what fileLine writes: group 1 is the path, group 2
 * the arguments (with their leading space).
 */
const fileLineShape =
  /\{ l=\$\(head -n 1 '([^']*)'\); case \$l in '#!'\*\) \$\{l#\?\?\} '[^']*'(.*?);; \*\) sh '[^']*'.*?;; esac; \}/g;

/**
 * shownLine is line as a user reads it: every fileLine back to the script
 * it runs and its arguments (`.loadout/x.ts check`), and no repo bun folder
 * in its PATH (shellLine's, set only while it runs).
 */
export function shownLine(line: string): string {
  return line.replace(fileLineShape, "$1$2").replaceAll(bunFirst, "");
}

/**
 * bunDirVar is the folder of the repo's bun (`repo { bun = … }`), set by
 * the frame of every manifest command; unset when the repo pins none.
 */
export const bunDirVar = "LOADOUT_BUN_DIR";

/** bunFirst is the repo's bun folder and a colon, or nothing when unset. */
const bunFirst = "${" + bunDirVar + ":+$" + bunDirVar + ":}";

/**
 * shellLine is the shell line for command: `file:` expanded, and path put
 * first on PATH, after the repo's bun folder when the frame sets one: a
 * `provides … at` folder (brew's bin) may hold a bun of its own, and a
 * `#!/usr/bin/env bun` script runs with the repo's. The directories are
 * expanded by the shell, so `$HOME` works.
 */
export function shellLine(command: string, path: readonly string[] | undefined): string {
  const line = expandFilePrefix(command);
  if (path === undefined || path.length === 0) return line;
  return 'PATH="' + bunFirst + path.join(":") + ':$PATH"; export PATH; ' + line;
}

/** Program is one program: its install variants and how to observe it. */
export interface Program {
  description: string;
  tags: string[];
  /** dependsOn is `depends-on`. */
  dependsOn: string[];
  /** version is the variant-independent version check; the fallback when a variant resolves no check. */
  version?: VersionCheck;
  /**
   * install is the install variants, keyed by installer name (`dnf`) or,
   * for a command of the program's own, by the name it gives it (`linux`).
   * Each machine's mapping picks which key to use.
   */
  install: Map<string, InstallVariant>;
  /**
   * outdated is this program's own remote check, for programs no
   * installer's oracle covers (a binary that updates itself). Its candidate
   * is read with the program's version regex, and ProgramOutdated.upgrade
   * moves this one program on its own.
   */
  outdated?: ProgramOutdated;
  /**
   * path is the directories put first on PATH for this program's commands,
   * for a tool that lands somewhere a fresh shell doesn't look yet
   * (`$HOME/.local/bin`).
   */
  path: string[];
  /**
   * later is why this program can wait (`later = "…"`): setup-new-machine
   * installs it in its later phase, after every core program and script.
   * "" = core.
   */
  later: string;
  /**
   * origin is the repo-relative directory of the declaring file ("" = repo
   * root): paths resolve and commands run there.
   */
  origin: string;
}

/** newProgram is a Program with every field not given at its zero value. */
export function newProgram(p: Partial<Program> = {}): Program {
  return { description: "", tags: [], dependsOn: [], install: new Map(), path: [], later: "", origin: "", ...p };
}

/** ProgramOutdated is a program's own `outdated` block: command prints the newest version, upgrade updates it. */
export interface ProgramOutdated {
  /** command prints the newest version available (nothing when up to date); the program's version regex reads it. */
  command: string;
  /** upgrade updates this program alone. Runs once per upgrade; `{item}` is not substituted. */
  upgrade?: string;
}

/** VersionCheck is a command that reports a version (or, without a regex, only yes or no). */
export interface VersionCheck {
  command: string;
  /** regex extracts the version (capture group 1); undefined for a yes/no check, which records none. */
  regex?: string;
  /**
   * probe is the tool this check asks through (the installer's probe), when
   * the check isn't the program's own binary. Set by resolveInstall, never
   * declared or written: it's what lets "brew: command not found" mean
   * "couldn't ask" instead of "not installed".
   */
  probe?: string;
  /**
   * origin is the repo-relative directory of the declaring file ("" = repo
   * root): paths resolve and commands run there.
   */
  origin: string;
  /** path is the directories put first on PATH (see Program.path). */
  path: string[];
}

/** newVersionCheck is a VersionCheck with every field not given at its zero value. */
export function newVersionCheck(v: Partial<VersionCheck> & { command: string }): VersionCheck {
  return { origin: "", path: [], ...v };
}

/** versionCheckEqual is value equality (undefined equals only undefined). */
export function versionCheckEqual(v: VersionCheck | undefined, o: VersionCheck | undefined): boolean {
  if (v === undefined || o === undefined) return v === o;
  return (
    v.command === o.command &&
    v.regex === o.regex &&
    v.probe === o.probe &&
    v.origin === o.origin &&
    slicesEqual(v.path, o.path)
  );
}

const theDefaultModes = ["setup", "maintain"];

/** defaultModes is a script's modes when it doesn't say: both surfaces (a fresh array). */
export function defaultModes(): string[] {
  return [...theDefaultModes];
}

/** isDefaultModes says whether modes are the default ones, written out. */
export function isDefaultModes(modes: readonly string[]): boolean {
  return slicesEqual(modes, theDefaultModes);
}

/** ScriptStep is one idempotent setup step. */
export interface ScriptStep {
  description: string;
  /** file is the script file to execute, relative to the declaring file's directory. Exactly one of file/run. */
  file?: string;
  /** run is the inline shell command to execute. Exactly one of file/run. */
  run?: string;
  /** check is a shell command; exit 0 means the step is already done and is skipped. */
  check?: string;
  /** after holds ordering constraints: entries like "programs.git" or "scripts.dotfiles". */
  after: string[];
  /**
   * modes is the execution surfaces this script participates in: "setup"
   * (setup-new-machine's converge) and/or "maintain" (the home screen's
   * scripts picker). undefined means the default, both (defaultModes); an
   * empty list is an empty list, which validation refuses. Governs
   * execution only — `status` observes every opted-in script regardless,
   * and `run <name>` is the explicit escape hatch.
   */
  modes?: string[];
  /** sudo says the script needs sudo's password without saying `sudo`; see Installer.sudo. */
  sudo: boolean;
  /**
   * later is why this script can wait (`later = "…"`): setup-new-machine
   * runs it in its later phase, after every core program and script. Shared
   * by its variants. "" = core.
   */
  later: string;
  /**
   * variants is the ways to do this one step, keyed by name; a machine
   * running the script picks one. Each holds its own file/run, check and
   * after; the step's own description, modes and sudo apply to all of them.
   */
  variants: Map<string, ScriptStep>;
  /**
   * origin is the repo-relative directory of the declaring file ("" = repo
   * root): paths resolve and commands run there.
   */
  origin: string;
  /**
   * path is the directories put first on PATH for the script's commands:
   * every `provides … at` folder of the machine in view (forMachine), so a
   * script finds its interpreter (bun from brew) before a shell would.
   * Never written to the lock.
   */
  path: string[];
}

/** newScriptStep is a ScriptStep with every field not given at its zero value. */
export function newScriptStep(s: Partial<ScriptStep> = {}): ScriptStep {
  return { description: "", after: [], sudo: false, later: "", variants: new Map(), origin: "", path: [], ...s };
}

/** modeList is s.modes with the default applied. */
export function modeList(s: ScriptStep): string[] {
  return s.modes === undefined ? defaultModes() : s.modes;
}

/** runsIn says whether the step runs on the mode surface. */
export function runsIn(s: ScriptStep, mode: string): boolean {
  return modeList(s).includes(mode);
}

/** scriptVariant is the step as variant name does it (Go's ScriptStep.Variant). Assumes the variant exists. */
export function scriptVariant(s: ScriptStep, name: string): ScriptStep {
  const chosen = s.variants.get(name);
  if (chosen === undefined) throw new Error(`script has no variant ${JSON.stringify(name)}`);
  return {
    ...s,
    file: chosen.file,
    run: chosen.run,
    check: chosen.check ?? s.check,
    after: distinct(concat(s.after, chosen.after)),
    sudo: s.sudo || chosen.sudo,
    variants: new Map(),
    origin: chosen.origin,
  };
}

/** OutdatedSource is one custom `outdated` oracle; see Manifest.outdated. */
export interface OutdatedSource {
  /** command prints `<item> <current> <candidate>` lines. `file:` allowed. */
  command?: string;
  /**
   * upgrade is how to update ONE of this source's items: `{item}` is the
   * row name, and the command runs once per row you pick. Per-item on
   * purpose — a pin in a file and a plugin clone are independent, unlike a
   * package manager's transaction (contract 15). Without this, the source's
   * rows are read-only. `file:` allowed.
   */
  upgrade?: string;
  /** sudo says upgrade needs sudo's password without saying `sudo`; see Installer.sudo. */
  sudo: boolean;
  /**
   * origin is the repo-relative directory of the declaring file ("" = repo
   * root): paths resolve and commands run there.
   */
  origin: string;
  /** path is ScriptStep.path, for the source's commands (forMachine). */
  path: string[];
}

/** newOutdatedSource is an OutdatedSource with every field not given at its zero value. */
export function newOutdatedSource(o: Partial<OutdatedSource> = {}): OutdatedSource {
  return { sudo: false, origin: "", path: [], ...o };
}
