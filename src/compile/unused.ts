// What compile warns about: declarations no machine uses, and transitional
// scripts every machine has done.

import type { ManifestDraft } from "../assemble/index.ts";
import { compareStrings, dependenciesOf, distinct, type MachineConfig, type Manifest, scriptEntry, sortStrings, sortedStrings } from "../model/index.ts";

/**
 * unusedWarnings is what no machine uses, for `loadout compile` to warn
 * about: a program no machine installs, a script none runs (or a variant
 * none picks), a profile none extends, a repo installer that installs
 * nothing in use. A way to install a program that no machine picks is
 * reported only when some machine uses that installer for other programs (a
 * profile that installs everything via dnf but this one): a true claim about
 * an installer nobody uses (a scaffold's ripgrep via apt, a COPR kept for a
 * future Fedora machine) is what a program's install list is for. Declaring something and
 * forgetting to use it is otherwise silent. A profile marked spare keeps what
 * it uses from being reported, and a spare mark on something that is used is
 * reported too, so the marks stay true.
 *
 * inherited is a child repo's parent's declarations (declaredNames): their
 * use is the parent's compile's business. Sorted.
 */
export function unusedWarnings(
  draft: ManifestDraft,
  manifest: Manifest,
  spares: ReadonlyMap<string, string>,
  inherited: readonly string[],
): string[] {
  const profiles = draft.profiles;

  // Profiles some machine reaches, through extends chains.
  const reached = new Set<string>();
  const reach = (names: readonly string[]): void => {
    for (const name of names) {
      if (reached.has(name)) continue;
      reached.add(name);
      const p = profiles.get(name);
      if (p !== undefined) reach(p.extends);
    }
  };
  for (const machine of draft.manifest.machines.values()) reach(machine.extends);

  // Everything a spare profile (and what it extends) says counts as used.
  const closure = (name: string, seen: Set<string>): MachineConfig[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    const config = profiles.get(name);
    if (config === undefined) return [];
    const out = [config];
    for (const e of config.extends) out.push(...closure(e, seen));
    return out;
  };
  const users: { who: string; config: MachineConfig }[] = [];
  for (const [name, config] of manifest.machines) users.push({ who: "machine '" + name + "'", config });
  for (const name of profiles.keys()) {
    if (!spares.has("profile '" + name + "'")) continue;
    for (const config of closure(name, new Set())) users.push({ who: "profile '" + name + "'", config });
  }

  // Programs in use, with the variant each user picks; dependencies too.
  const picks = new Map<string, Set<string>>(); // program -> variants picked
  const usedPrograms = new Map<string, string>(); // program -> who installs it
  const installerUsers = new Map<string, Set<string>>(); // installer -> who installs through it
  const installerOf = (program: string, key: string): string | undefined => {
    const v = manifest.programs.get(program)?.install.get(key);
    if (v === undefined) return undefined;
    return v.installer ?? key;
  };
  const addTo = (m: Map<string, Set<string>>, key: string, value: string): void => {
    let set = m.get(key);
    if (set === undefined) m.set(key, (set = new Set()));
    set.add(value);
  };
  for (const u of users) {
    const seen = new Set<string>();
    const pending = [...u.config.pm.keys()];
    while (pending.length > 0) {
      const program = pending.shift()!;
      if (seen.has(program)) continue;
      seen.add(program);
      if (!usedPrograms.has(program)) usedPrograms.set(program, u.who);
      const key = u.config.pm.get(program);
      if (key !== undefined) {
        addTo(picks, program, key);
        const installer = installerOf(program, key);
        if (installer !== undefined) addTo(installerUsers, installer, u.who);
      }
      pending.push(...dependenciesOf(manifest, program, key));
    }
  }
  const usedScripts = new Map<string, string>();
  const scriptPicks = new Map<string, Set<string>>();
  for (const u of users) {
    for (const entry of u.config.scripts) {
      const [name] = scriptEntry(entry);
      if (!usedScripts.has(name)) usedScripts.set(name, u.who);
    }
    for (const [script, variant] of u.config.scriptVariants) addTo(scriptPicks, script, variant);
  }

  const warnings: string[] = [];
  const isInherited = (key: string): boolean => inherited.some((it) => key === it || key.startsWith(it + " "));
  const unused = (key: string, message: string): void => {
    if (!spares.has(key) && !isInherited(key)) {
      warnings.push(message + ` — if it's kept on purpose, mark it spare: "…"`);
    }
  };
  const staleSpare = (key: string, by: string): void => {
    if (spares.has(key) && !isInherited(key)) warnings.push(key + " is marked spare, but " + by + " uses it");
  };

  for (const name of profiles.keys()) {
    if (reached.has(name)) staleSpare("profile '" + name + "'", "a machine");
    else unused("profile '" + name + "'", "profile '" + name + "' isn't extended by any machine");
  }
  for (const [name, program] of manifest.programs) {
    const who = usedPrograms.get(name);
    if (who === undefined) {
      unused("program '" + name + "'", "program '" + name + "' isn't installed on any machine");
      continue;
    }
    staleSpare("program '" + name + "'", who);
    if (program.install.size <= 1) continue;
    for (const key of program.install.keys()) {
      const spareKey = "program '" + name + "' via '" + key + "'";
      if (picks.get(name)?.has(key)) {
        staleSpare(spareKey, "a machine");
        continue;
      }
      const installer = installerOf(name, key);
      const others = installer === undefined ? [] : [...(installerUsers.get(installer) ?? [])];
      if (others.length === 0) continue;
      sortStrings(others);
      const more = others.length > 1 ? ` (and ${others.length - 1} more)` : "";
      unused(spareKey, "program '" + name + "': " + others[0] + more + " installs other programs via '" + key + "', but not " + name);
    }
  }
  for (const [name, script] of manifest.scripts) {
    const who = usedScripts.get(name);
    if (who === undefined) {
      unused("script '" + name + "'", "script '" + name + "' isn't run on any machine");
      continue;
    }
    staleSpare("script '" + name + "'", who);
    for (const variant of script.variants.keys()) {
      const spareKey = "script '" + name + "' as '" + variant + "'";
      if (scriptPicks.get(name)?.has(variant)) staleSpare(spareKey, "a machine");
      else unused(spareKey, "script '" + name + "': no machine runs it as '" + variant + "'");
    }
  }
  for (const name of manifest.installers.keys()) {
    if (manifest.builtinInstallers.includes(name)) continue;
    if (installerUsers.has(name)) staleSpare("installer '" + name + "'", "a program a machine installs");
    else unused("installer '" + name + "'", "installer '" + name + "' installs nothing a machine uses");
  }
  return sortStrings(warnings);
}

/**
 * transitionalWarnings is the transitional scripts every machine that runs
 * them reports done, for `loadout compile` to say they can be deleted. done
 * is each machine's scripts whose state says done; a machine without a state
 * file has done nothing. A script no machine runs is left to unusedWarnings.
 */
export function transitionalWarnings(
  manifest: Manifest,
  transitional: readonly string[],
  done: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const out: string[] = [];
  for (const name of sortedStrings(distinct(transitional))) {
    const runners: string[] = [];
    for (const [machine, config] of manifest.machines) {
      if (config.scripts.some((entry) => scriptEntry(entry)[0] === name)) runners.push(machine);
    }
    runners.sort(compareStrings);
    if (runners.length === 0) continue;
    if (runners.every((r) => done.get(r)?.has(name) ?? false)) {
      out.push("script '" + name + "' is done on every machine that runs it (" + runners.join(", ") + "): it's transitional, so delete it");
    }
  }
  return out;
}
