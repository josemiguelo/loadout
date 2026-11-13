// Package assemble turns what a config repo declares into the Manifest the
// lock holds: built-ins merged, profiles flattened, everything validated.

import {
  cleanPath,
  compareStrings,
  cut,
  cutPrefix,
  dataConflicts,
  dependenciesOf,
  distinct,
  globHasWildcard,
  globProblem,
  hasSpace,
  installerLibrary,
  installFilePrefix,
  isAbsPath,
  isBlank,
  isParentOrigin,
  type JSONObject,
  keysOf,
  type MachineConfig,
  type Manifest,
  ManifestException,
  mapValues,
  mergeData,
  modeList,
  newManifest,
  originFolder,
  parentOrigin,
  plus,
  type RepoFS,
  resolveInstall,
  scriptArgs,
  scriptEntry,
  type ScriptStep,
  scriptVariant,
  sortedMap,
  sortStrings,
  trimPrefix,
  trimSpace,
  validateData,
  versionCheckEqual,
} from "../model/index.ts";

/**
 * ManifestDraft is what a config repo declares, before it becomes a
 * Manifest: the repo's own installers (built-ins not merged yet), and
 * machines and profiles unflattened. loadout.ts prints one; assemble
 * turns it into what the lock holds.
 *
 * In manifest, machines and profiles carry their own settings only (their
 * extends unresolved) and a label for messages (`machine 'm'`, `profile
 * 'p'`); every origin is the declaring file's folder (parentOrigin for
 * a parent's declarations). Map order is declaration order: it decides the
 * order of errors and of the lock's unsorted maps (a program's variants).
 */
export interface ManifestDraft {
  manifest: Manifest;
  /** profiles are the declared profiles, keyed by name. */
  profiles: Map<string, MachineConfig>;
  /**
   * requires is the programs each installer requires, built-ins included: a
   * repo adds a requirement to `dnf` without redefining it, so these apply
   * after the built-ins are merged.
   */
  requires: Map<string, string[]>;
}

/** newManifestDraft is a ManifestDraft with every field not given at its zero value. */
export function newManifestDraft(d: Partial<ManifestDraft> = {}): ManifestDraft {
  return { manifest: newManifest(), profiles: new Map(), requires: new Map(), ...d };
}

/**
 * assemble turns draft into a validated Manifest: the built-in installers
 * merged under the repo's, profiles flattened into machines (contract 2),
 * everything checked, and `file:` paths checked against repo (rooted at the
 * repo root) and parent (the parent's checkout, undefined for a repo without
 * one). Shared by compile (which writes the lock) and the binary (which
 * re-checks files when it reads one), so both say the same thing. Its
 * refusal (thrown) is a ManifestException.
 */
export function assemble(draft: ManifestDraft, repo: RepoFS, parent: RepoFS | undefined): Manifest {
  return assembleWith(draft, { repo, parent });
}

/**
 * assembleWithoutFiles is assemble without the `file:` checks. TEST-ONLY:
 * everything else — built-ins, flattening, validation — behaves exactly as
 * in production.
 */
export function assembleWithoutFiles(draft: ManifestDraft): Manifest {
  return assembleWith(draft, undefined);
}

interface Files {
  repo: RepoFS;
  parent: RepoFS | undefined;
}

function assembleWith(draft: ManifestDraft, files: Files | undefined): Manifest {
  const errors: string[] = [];
  const manifest = withBuiltinInstallers(draft.manifest);
  manifest.installers = mapValues(manifest.installers, (name, installer) => {
    const extra = draft.requires.get(name);
    return extra !== undefined ? { ...installer, requires: distinct([...installer.requires, ...extra]) } : installer;
  });
  for (const name of draft.requires.keys()) {
    if (!manifest.installers.has(name)) errors.push("requires on unknown installer '" + name + "'");
  }
  const state = manifest.layout.state;
  if (trimSpace(state) === "") errors.push("layout state is missing (a directory)");
  const dirs: string[] = [];
  if (trimSpace(state) !== "") dirs.push(state);
  if (manifest.layout.configs !== undefined) dirs.push(manifest.layout.configs);
  for (const dir of dirs) {
    if (globHasWildcard(dir)) errors.push("layout '" + dir + "' is a directory, not a glob");
    const problem = globProblem(dir);
    if (problem !== "") errors.push("layout '" + dir + "' " + problem);
  }
  for (const [name, config] of plus(draft.profiles, manifest.machines)) {
    errors.push(...validateData(manifest.data, config.data, config.label === "" ? name : config.label, ""));
  }
  const machines = new Map<string, MachineConfig>();
  errors.push(...flatten(manifest.machines, draft.profiles, machines));
  if (errors.length > 0) throw invalid(errors);

  const flat: Manifest = {
    ...manifest,
    machines: mapValues(machines, (_, config) => ({ ...config, data: mergeData(manifest.data, config.data) })),
  };
  validate(flat);
  if (files !== undefined) {
    const missing = checkFiles(flat, files.repo, files.parent);
    if (missing.length > 0) throw invalid(missing);
  }
  return sorted(withFileValues(flat));
}

/**
 * checkFiles is the problems with every `file:` path the manifest names,
 * against repo (and parent, for a parent's declarations; undefined skips
 * them): each is relative to its declaring file's directory and must exist
 * without leaving the repo.
 */
export function checkFiles(manifest: Manifest, repo: RepoFS, parent: RepoFS | undefined): string[] {
  const problems: string[] = [];
  const requirePath = (file: string, origin: string, label: string) => {
    // A parent's declaration resolves in the parent's checkout.
    let root = repo;
    let where = "the repo";
    if (isParentOrigin(origin)) {
      if (parent === undefined) return;
      root = parent;
      where = "the parent's";
    }
    const folder = originFolder(origin);
    if (folder === "") where += " root";
    else where = origin + "/";
    const relative = normalized(folder !== "" ? folder + "/" + file : file);
    if (isAbsPath(relative) || relative === ".." || relative.startsWith("../")) {
      problems.push(label + ": file '" + file + "' leaves the repo (paths are relative to " + where + ")");
    } else if (!exists(root, relative)) {
      problems.push(label + ": file '" + file + "' not found (relative to " + where + ")");
    }
  };
  const requireFile = (command: string | undefined, origin: string, label: string) => {
    if (command === undefined || !command.startsWith(installFilePrefix)) return;
    // Anything after the first space is arguments, not path.
    const [p] = cut(trimPrefix(command, installFilePrefix), " ");
    requirePath(p, origin, label);
  };
  for (const [name, script] of manifest.scripts) {
    const steps: [string, ScriptStep][] = [["", script]];
    for (const [key, v] of script.variants) steps.push(["." + key, v]);
    for (const [label, step] of steps) {
      if (step.file !== undefined) requirePath(step.file, step.origin, "scripts." + name + label);
      requireFile(step.check, step.origin, "scripts." + name + label + ".check");
    }
  }
  for (const [name, source] of manifest.outdated) {
    requireFile(source.command, source.origin, "outdated." + name);
    requireFile(source.upgrade, source.origin, "outdated." + name + ".upgrade");
  }
  for (const [name, program] of manifest.programs) {
    if (program.version !== undefined) {
      requireFile(program.version.command, program.version.origin, "programs." + name + ".version");
    }
    const own = program.outdated;
    if (own !== undefined) {
      requireFile(own.command, program.origin, "programs." + name + ".outdated");
      requireFile(own.upgrade, program.origin, "programs." + name + ".outdated upgrade");
    }
    for (const key of program.install.keys()) {
      const resolved = resolveInstall(manifest, name, key);
      const at = "programs." + name + ".install." + key;
      requireFile(resolved.command, resolved.commandOrigin, at);
      // The version fallback is already checked once above.
      const c = resolved.check;
      if (c !== undefined && !versionCheckEqual(c, program.version)) requireFile(c.command, c.origin, at + " check");
      if (resolved.outdated !== undefined) requireFile(resolved.outdated.command, resolved.outdated.origin, at + " outdated");
      if (resolved.outdatedAll !== undefined) {
        requireFile(resolved.outdatedAll.command, resolved.outdatedAll.origin, at + " outdated-all");
      }
      if (resolved.upgradeWith !== undefined) {
        requireFile(resolved.upgradeWith.command, resolved.upgradeWith.origin, at + " upgrade");
      }
    }
    for (const [key, variant] of program.install) {
      for (const [param, value] of variant.with) {
        const label = "programs." + name + ".install." + key + ".with." + param;
        if (value.startsWith(installFilePrefix)) {
          requirePath(trimPrefix(value, installFilePrefix), program.origin, label);
        } else if (value.startsWith(repoPath)) {
          // In a lock it's already a repo path (see withFileValues).
          requirePath(trimPrefix(value, repoPath), "", label);
        } else if (value.startsWith(parentPath)) {
          requirePath(trimPrefix(value, parentPath), parentOrigin(""), label);
        }
      }
    }
  }
  return problems;
}

/** normalized is p cleaned as okio's normalized() does: "" stays "". */
function normalized(p: string): string {
  return p === "" ? "" : cleanPath(p);
}

/** exists says whether p (repo-relative, normalized) is there; a symlink counts, even a dangling one. */
function exists(root: RepoFS, p: string): boolean {
  return root.lstat(p === "" ? "." : p) !== undefined;
}

/**
 * installOrder is programs in dependency order (dependencies before
 * dependents), each program's edges being those of the variant mapping
 * picks for it (dependenciesOf). Ties break by name. names undefined means
 * every program. Assumes validation passed, i.e. the graph is acyclic.
 */
export function installOrder(manifest: Manifest, names: readonly string[] | undefined, mapping: ReadonlyMap<string, string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name) || !manifest.programs.has(name)) return;
    seen.add(name);
    for (const d of sortStrings(dependenciesOf(manifest, name, mapping.get(name)))) visit(d);
    result.push(name);
  };
  for (const n of sortStrings([...(names ?? manifest.programs.keys())])) visit(n);
  return result;
}

/**
 * scriptOrder is scripts ordered so that a script listed in another's
 * `after` runs first, ties by name. names undefined means every script. Only
 * script-to-script edges affect this order; `programs.*` references are
 * satisfied by installs always running before scripts.
 */
export function scriptOrder(manifest: Manifest, names: readonly string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name) || !manifest.scripts.has(name)) return;
    seen.add(name);
    const after: string[] = [];
    for (const ref of manifest.scripts.get(name)!.after) {
      const [s, ok] = cutPrefix(ref, "scripts.");
      if (ok) after.push(s);
    }
    for (const a of sortStrings(after)) visit(a);
    result.push(name);
  };
  for (const n of sortStrings([...(names ?? manifest.scripts.keys())])) visit(n);
  return result;
}

/** repoPath is how a `file:` `with` value reads once assembled: a path under the repo. */
const repoPath = "$LOADOUT_REPO/";

/**
 * parentPath is a parent's file in a child's lock: under `LOADOUT_PARENT`,
 * which every command of a child repo sees, so it resolves whichever repo's
 * installer (a built-in's runs in the child) the value is substituted into.
 */
const parentPath = "$LOADOUT_PARENT/";

/** invalid is the refusal listing errors: "Invalid manifest:" and one indented line each. */
export function invalid(errors: readonly string[]): ManifestException {
  return new ManifestException("Invalid manifest:" + errors.map((e) => "\n  - " + e).join(""));
}

/**
 * withBuiltinInstallers merges loadout's shipped installers UNDER the
 * manifest's own: a repo definition of the same name replaces the built-in,
 * and what survived is recorded for `explain`/`installers`. The one place
 * this happens.
 */
function withBuiltinInstallers(manifest: Manifest): Manifest {
  const builtins = installerLibrary();
  const survived = keysOf(builtins).filter((name) => !manifest.installers.has(name));
  return { ...manifest, installers: plus(builtins, manifest.installers), builtinInstallers: survived };
}

/**
 * withFileValues makes a `with` value marked `file:` — a path relative to
 * the program's file, like every other path — "$LOADOUT_REPO/<path>", since
 * it's substituted into an installer pattern that runs elsewhere.
 */
function withFileValues(manifest: Manifest): Manifest {
  return {
    ...manifest,
    programs: mapValues(manifest.programs, (_, program) => ({
      ...program,
      install: mapValues(program.install, (_, variant) => ({
        ...variant,
        with: mapValues(variant.with, (_, value) => {
          const [file, ok] = cutPrefix(value, installFilePrefix);
          if (!ok) return value;
          const folder = originFolder(program.origin);
          const joined = folder !== "" ? folder + "/" + file : file;
          return (isParentOrigin(program.origin) ? parentPath : repoPath) + normalized(joined);
        }),
      })),
    })),
  };
}

/**
 * sorted puts every map in name order, so the lock reads (and diffs) the
 * same however it was declared; and makes it exactly what a read of the
 * lock gives back (labels are for messages, and don't travel).
 */
function sorted(manifest: Manifest): Manifest {
  return {
    ...manifest,
    installers: sortedMap(manifest.installers),
    programs: sortedMap(manifest.programs),
    scripts: sortedMap(manifest.scripts),
    machines: mapValues(sortedMap(manifest.machines), (_, machine) => ({
      ...machine,
      pm: sortedMap(machine.pm),
      scriptVariants: sortedMap(machine.scriptVariants),
      label: "",
    })),
    outdated: sortedMap(manifest.outdated),
    builtinInstallers: sortStrings([...manifest.builtinInstallers]),
  };
}

interface Pick {
  value: string;
  profile: string;
}

/**
 * flatten resolves `extends` lists into out: every machine becomes its
 * flattened self, downstream nothing knows profiles existed. A machine's
 * profiles are combined first — two of them setting a program's variant, a
 * script's arguments or variant, or a data key differently is an error, so
 * their order never changes the result — then the machine itself overrides
 * them (pm per key, scripts by name, data table by table, lists replace).
 * Profiles are validated through the machines extending them, and each one
 * alone too. Returns errors.
 */
function flatten(
  machineConfigs: ReadonlyMap<string, MachineConfig>,
  profiles: ReadonlyMap<string, MachineConfig>,
  out: Map<string, MachineConfig>,
): string[] {
  const errors: string[] = [];
  const flatProfiles = new Map<string, MachineConfig>();

  const flat = (config: MachineConfig, seen: string[]): MachineConfig => {
    const parents: { name: string; config: MachineConfig }[] = [];
    for (const name of config.extends) {
      const profile = profiles.get(name);
      if (profile === undefined) {
        errors.push(config.label + ": extends unknown profile '" + name + "'");
      } else if (seen.includes(name)) {
        errors.push("profile cycle: " + [...seen, name].join(" -> "));
      } else {
        let p = flatProfiles.get(name);
        if (p === undefined) {
          p = flat(profile, [...seen, name]);
          flatProfiles.set(name, p);
        }
        parents.push({ name, config: p });
      }
    }
    // program -> (variant, profile), script -> (entry, profile), script -> (variant, profile)
    const pm = new Map<string, Pick>();
    const scripts = new Map<string, Pick>();
    const variants = new Map<string, Pick>();
    let data: JSONObject = new Map();
    parents.forEach((p, index) => {
      for (const [program, variant] of p.config.pm) {
        const previous = pm.get(program);
        if (previous === undefined) {
          pm.set(program, { value: variant, profile: p.name });
        } else if (previous.value !== variant) {
          errors.push(
            config.label + ": profiles '" + previous.profile + "' and '" + p.name + "' map '" + program +
              "' differently ('" + previous.value + "' vs '" + variant + "')",
          );
        }
      }
      for (const entry of p.config.scripts) {
        const [script, args] = scriptEntry(entry);
        const previous = scripts.get(script);
        if (previous === undefined) {
          scripts.set(script, { value: entry, profile: p.name });
        } else if (scriptEntry(previous.value)[1] !== args) {
          errors.push(
            config.label + ": profiles '" + previous.profile + "' and '" + p.name + "' run '" + script + "' with different arguments",
          );
        }
      }
      for (const [script, variant] of p.config.scriptVariants) {
        const previous = variants.get(script);
        if (previous === undefined) {
          variants.set(script, { value: variant, profile: p.name });
        } else if (previous.value !== variant) {
          errors.push(
            config.label + ": profiles '" + previous.profile + "' and '" + p.name + "' run '" + script +
              "' as different variants ('" + previous.value + "' vs '" + variant + "')",
          );
        }
      }
      for (const earlier of parents.slice(0, index)) {
        for (const key of dataConflicts(earlier.config.data, p.config.data, "")) {
          errors.push(config.label + ": profiles '" + earlier.name + "' and '" + p.name + "' set data key '" + key + "' differently");
        }
      }
      data = mergeData(data, p.config.data);
    });
    const own = scriptArgs(config);
    const inheritedScripts: string[] = [];
    for (const entry of scripts.values()) {
      if (!own.has(scriptEntry(entry.value)[0])) inheritedScripts.push(entry.value);
    }
    const inherited = new Map<string, string>();
    for (const [script, v] of variants) {
      if (!own.has(script)) inherited.set(script, v.value);
    }
    return {
      ...config,
      pm: plus(
        mapValues(pm, (_, v) => v.value),
        config.pm,
      ),
      scripts: [...inheritedScripts, ...config.scripts],
      scriptVariants: plus(inherited, config.scriptVariants),
      data: mergeData(data, config.data),
    };
  };

  for (const [name, profile] of profiles) {
    if (!flatProfiles.has(name)) flatProfiles.set(name, flat(profile, [name]));
  }
  for (const [name, machine] of machineConfigs) out.set(name, flat(machine, []));
  return errors;
}

const dottedVersion = /^\d+(\.\d+)*$/;

/** validate throws the refusal listing every problem with an assembled manifest, if it has any. */
function validate(manifest: Manifest): void {
  const errors: string[] = [];
  const add = (e: string) => errors.push(e);

  const minToolVersion = manifest.meta.minToolVersion;
  if (minToolVersion !== undefined && !dottedVersion.test(minToolVersion)) {
    add("meta min-tool-version '" + minToolVersion + "' is not a dotted version number (e.g. \"0.2.0\")");
  }

  for (const [name, installer] of manifest.installers) {
    if (installer.check !== undefined && installer.regex === undefined) add("installers." + name + " has a check but no regex");
    if (installer.outdated !== undefined && installer.regex === undefined) {
      add("installers." + name + " has an outdated command but no regex");
    }
    if (installer.outdatedAll !== undefined && installer.regex === undefined) {
      add("installers." + name + " has an outdated-all command but no regex");
    }
    if (installer.params.includes("pkg")) add("installers." + name + " declares param 'pkg', which is always available");
    for (const required of installer.requires) {
      if (!manifest.programs.has(required)) add("installers." + name + " requires unknown program '" + required + "'");
    }
  }

  for (const [name, source] of manifest.outdated) {
    if (source.command === undefined || isBlank(source.command)) {
      add("outdated." + name + " needs a command (prints '<item> <current> <candidate>' lines)");
    }
  }

  for (const [name, program] of manifest.programs) {
    const own = program.outdated;
    if (own !== undefined) {
      if (isBlank(own.command)) add("programs." + name + ".outdated needs a command (prints the newest version)");
      if (program.version?.regex === undefined) {
        add(
          "programs." + name + ".outdated needs a version with a regex: the newest version is " +
            "read with the program's version regex",
        );
      }
    }
    for (const dep of program.dependsOn) {
      if (!manifest.programs.has(dep)) add("programs." + name + " depends-on unknown program '" + dep + "'");
    }
    for (const [key, variant] of program.install) {
      const at = "programs." + name + ".install." + key;
      for (const provided of variant.provides) {
        if (isBlank(provided.binary) || hasSpace(provided.binary) || provided.binary.includes("/")) {
          add(at + " provides '" + provided.binary + "': name a binary, not a path " + "(where it lands goes in `at`)");
        }
        if (provided.at !== undefined && (isBlank(provided.at) || provided.at.includes(":"))) {
          add(at + " provides '" + provided.binary + "' at '" + provided.at + "': " + "one folder, no ':'");
        }
      }
      for (const dep of variant.dependsOn) {
        if (!manifest.programs.has(dep)) add(at + " depends-on unknown program '" + dep + "'");
      }
      if (variant.installer !== undefined && !manifest.installers.has(variant.installer)) {
        add(at + " references unknown installer '" + variant.installer + "'");
        continue;
      }
      const installerName = variant.installer ?? key;
      const installer = manifest.installers.get(installerName);
      if (variant.command === undefined && installer?.install === undefined) {
        add(at + " resolves to no install command " + "(set a command, or use an installer with an install pattern)");
      }
      const check = variant.check ?? installer?.check;
      const regex = variant.regex ?? installer?.regex;
      if (variant.present && variant.regex !== undefined) add(at + " is a yes/no check and also sets a regex");
      if (variant.present && check === undefined) add(at + " is a yes/no check with no check command");
      if (!variant.present && variant.check !== undefined && regex === undefined) {
        add(at + " has a check but no regex " + "(give it one, or make it a yes/no check)");
      }
      if (variant.outdated !== undefined && regex === undefined) add(at + " has an outdated command but no regex");
      // Params are a contract between installer and variant: every
      // declared one must be supplied, and nothing else may be.
      const params = installer?.params ?? [];
      for (const missing of params) {
        if (!variant.with.has(missing)) add(at + " needs a value for '" + missing + "'");
      }
      for (const extra of variant.with.keys()) {
        if (params.includes(extra)) continue;
        if (installer === undefined) add(at + " sets '" + extra + "' but resolves to no installer");
        else add(at + " sets '" + extra + "', which installer '" + installerName + "' does not declare in params");
      }
    }
  }

  for (const [name, script] of manifest.scripts) {
    let ways: [string, ScriptStep][] = [["scripts." + name, script]];
    if (script.variants.size > 0) {
      if (script.file !== undefined || script.run !== undefined) {
        add("scripts." + name + " has variants, so its file or command belongs in each variant");
      }
      ways = [...script.variants].map(([key, variant]) => ["scripts." + name + "." + key, variant]);
    }
    for (const [label, step] of ways) {
      if ((step.file === undefined) === (step.run === undefined)) {
        add(label + " must define exactly one of a file or an inline command");
      }
      for (const ref of step.after) {
        let valid = false;
        const [p, isProgram] = cutPrefix(ref, "programs.");
        const [s, isScript] = cutPrefix(ref, "scripts.");
        if (isProgram) valid = manifest.programs.has(p);
        else if (isScript) valid = manifest.scripts.has(s);
        if (!valid) add(label + " after references unknown step '" + ref + "'");
      }
    }
    const modes = modeList(script);
    if (modes.length === 0) add("scripts." + name + " has an empty modes list (it could never run; omit modes for both surfaces)");
    for (const mode of modes) {
      if (mode !== "setup" && mode !== "maintain") add("scripts." + name + " has unknown mode '" + mode + "' (valid: setup, maintain)");
    }
  }

  for (const [machine, config] of manifest.machines) {
    const label = config.label === "" ? "machine '" + machine + "'" : config.label;
    const counts = new Map<string, number>();
    for (const entry of config.scripts) {
      const [n] = scriptEntry(entry);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    for (const [n, count] of counts) {
      if (count > 1) add(label + " runs script '" + n + "' more than once");
    }
    for (const [scriptName, args] of scriptArgs(config)) {
      const script = manifest.scripts.get(scriptName);
      const variant = config.scriptVariants.get(scriptName);
      if (script === undefined) {
        add(label + " runs unknown script '" + scriptName + "'");
      } else if (script.variants.size > 0 && variant === undefined) {
        add(label + " runs '" + scriptName + "' without saying which variant (has: " + sortedKeys(script.variants) + ")");
      } else if (variant !== undefined && !script.variants.has(variant)) {
        const has = sortedKeys(script.variants) || "none";
        add(label + " runs '" + scriptName + "' as '" + variant + "', which it doesn't have (has: " + has + ")");
      } else if (args !== "" && (variant !== undefined ? scriptVariant(script, variant) : script).file === undefined) {
        add(
          label + " passes arguments to script '" + scriptName + "', " + "which is an inline command — arguments require a file script",
        );
      }
    }
    for (const [programName, installKey] of config.pm) {
      const program = manifest.programs.get(programName);
      if (program === undefined) {
        add(label + " installs unknown program '" + programName + "'");
      } else if (!program.install.has(installKey)) {
        add(
          label + " installs '" + programName + "' via '" + installKey + "', but it can't be installed " +
            "that way (it can via: " + sortedKeys(program.install) + ")",
        );
      }
    }
  }

  // Every variant's edges count, its installer's requirements too: a
  // cycle that only one machine's mapping would walk is still a cycle.
  const programEdges = mapValues(manifest.programs, (name, program) => {
    const edges: string[] = [];
    for (const key of program.install.keys()) edges.push(...dependenciesOf(manifest, name, key));
    edges.push(...dependenciesOf(manifest, name, undefined));
    return distinct(edges);
  });
  const programCycle = findCycle(programEdges);
  if (programCycle !== undefined) add("dependency cycle among programs: " + programCycle.join(" -> "));
  const scriptEdges = mapValues(manifest.scripts, (_, s) => {
    const refs = [...s.after];
    for (const v of s.variants.values()) refs.push(...v.after);
    const edges: string[] = [];
    for (const ref of refs) {
      const [n, ok] = cutPrefix(ref, "scripts.");
      if (ok) edges.push(n);
    }
    return distinct(edges);
  });
  const scriptCycle = findCycle(scriptEdges);
  if (scriptCycle !== undefined) add("ordering cycle among scripts: " + scriptCycle.join(" -> "));

  // A core step waiting on a later one would wait for the whole core phase
  // to end: refused, never moved (later is on the declaration, so this holds
  // on every machine). Every variant's edges count, as above. The core step
  // is named first, `<kind> '<name>'`: the declaration to change.
  const laterProgram = (name: string) => (manifest.programs.get(name)?.later ?? "") !== "";
  for (const [name, deps] of programEdges) {
    if (laterProgram(name)) continue;
    for (const dep of deps) {
      if (manifest.programs.has(dep) && laterProgram(dep)) {
        add("program '" + name + "' depends on program '" + dep + "', which is later: mark " + name + " later too, or drop later from " + dep);
      }
    }
  }
  for (const [name, s] of manifest.scripts) {
    if (s.later !== "") continue;
    const refs = [...s.after];
    for (const v of s.variants.values()) refs.push(...v.after);
    // Messages name both sides as `<kind> '<name>'`, the core one first:
    // that's where an editor places an error without a position.
    for (const ref of distinct(refs)) {
      let kind = "";
      let n = "";
      const [p, isProgram] = cutPrefix(ref, "programs.");
      const [sc, isScript] = cutPrefix(ref, "scripts.");
      if (isProgram && manifest.programs.has(p) && laterProgram(p)) {
        kind = "program";
        n = p;
      } else if (isScript && manifest.scripts.has(sc) && manifest.scripts.get(sc)!.later !== "") {
        kind = "script";
        n = sc;
      }
      if (kind !== "") {
        add("script '" + name + "' runs after " + kind + " '" + n + "', which is later: mark " + name + " later too, or drop later from " + n);
      }
    }
  }

  if (errors.length > 0) throw invalid(errors);
}

function sortedKeys<V>(m: ReadonlyMap<string, V>): string {
  return [...m.keys()].sort(compareStrings).join(", ");
}

/** findCycle is one cycle as a list of node names, or undefined if the graph is acyclic. */
function findCycle(edges: ReadonlyMap<string, string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): string[] | undefined => {
    if (done.has(node)) return undefined;
    if (visiting.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    visiting.add(node);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (edges.has(next)) {
        const cycle = visit(next);
        if (cycle !== undefined) return cycle;
      }
    }
    stack.pop();
    visiting.delete(node);
    done.add(node);
    return undefined;
  };

  for (const node of sortStrings([...edges.keys()])) {
    const cycle = visit(node);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}
