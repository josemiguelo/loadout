import { distinct, expandFilePrefix, type Manifest, mapValues, resolveInstall, shellLine, sortedStrings, sortStrings, toolPathOf } from "../../model/index.ts";
import { UpgradeException } from "./errors.ts";
import { commandNeedsSudo } from "./sudo.ts";
import { bullets } from "./text.ts";

/**
 * UpgradeStep is one upgrade command and every mechanism it covers. dnf,
 * dnf-repo and dnf-copr all run `dnf upgrade -y`: that's ONE transaction,
 * not three.
 */
export interface UpgradeStep {
  installers: string[];
  command: string;
  /** covers is the machine's programs these mechanisms install — what you'll see move. */
  covers: string[];
  /** sweep is true for a whole-mechanism sweep; false for one custom-source item. */
  sweep: boolean;
  /** tool is the tool the sweep's mechanisms all drive (their shared probe), when they do. */
  tool?: string;
  /** origin is where command runs: its declaring file's repo-relative directory. */
  origin: string;
  /** program is true for a program's own upgrade (covers is that program alone), not an installer's or a source's. */
  program: boolean;
  /** sudo says command needs sudo's password: it runs sudo, or its installer or source says so. */
  sudo: boolean;
}

/**
 * stepLabel is what to call s on screen: a sweep is the TOOL it drives
 * when its mechanisms share one — a user knows "dnf", not that the manifest
 * splits it into dnf/dnf-repo/dnf-copr — else the mechanisms; a per-item
 * step is the source AND the item, since "pins" alone doesn't say which pin
 * failed.
 */
export function stepLabel(s: UpgradeStep): string {
  if (!s.sweep && s.installers[0] === s.covers[0]) return s.covers[0]!;
  if (!s.sweep) return s.installers[0] + ": " + s.covers[0];
  if (s.tool !== undefined) return s.tool;
  return s.installers.join(", ");
}

// Moving installed programs to newer versions is the one verb that does
// that. Converging installs what's MISSING and never touches a version
// that's already there (contract 15); this is the separate, explicit ask.
//
// Upgrades are always WHOLE-MECHANISM: `dnf upgrade -y`, not `dnf upgrade
// -y code`. Partial upgrades are unsupported on Arch, discouraged on
// Fedora, and pointless everywhere else — the package manager resolves its
// own transaction, so asking for one package moves whatever that implies
// anyway. Picking a program in the UI means "upgrade the mechanism it came
// from".
//
// A planner only: it decides WHAT runs and refuses
// what mustn't. `loadout upgrade` runs the steps on the terminal (sudo may
// prompt there); the home screen plans with it too, to describe each step
// and refuse before handing off. Verification is not here either:
// re-observe everything the way `status` does and diff the versions.

/**
 * upgradableInstallers is the installers this machine's mapping uses that
 * can upgrade themselves, each with its programs, sorted.
 */
export function upgradableInstallers(manifest: Manifest, machine: string): Map<string, string[]> {
  const config = manifest.machines.get(machine);
  const byInstaller = new Map<string, string[]>();
  for (const [program, key] of config?.pm ?? []) {
    const mechanism = resolveInstall(manifest, program, key).upgradeWith;
    if (mechanism === undefined) continue;
    byInstaller.set(mechanism.installer, [...(byInstaller.get(mechanism.installer) ?? []), program]);
  }
  return mapValues(byInstaller, (_, programs) => sortedStrings(programs));
}

function cannotUpgrade(...errors: string[]): UpgradeException {
  return new UpgradeException("cannot upgrade:\n" + bullets(errors));
}

/**
 * planSourceItems is one step per item of a custom `outdated` source.
 * Unlike a package mechanism, these update one at a time: each row is a pin
 * in a file or a clone of its own, so nothing is shared and one failure
 * doesn't take the rest with it.
 */
export function planSourceItems(manifest: Manifest, source: string, items: readonly string[]): UpgradeStep[] {
  const declared = manifest.outdated.get(source);
  if (declared?.upgrade === undefined) throw cannotUpgrade("outdated source '" + source + "' declares no upgrade command");
  return items.map((item) => {
    const command = shellLine(declared.upgrade!, declared.path).replaceAll("{item}", item);
    return {
      installers: [source],
      command,
      covers: [item],
      sweep: false,
      origin: declared.origin,
      program: false,
      sudo: declared.sudo || commandNeedsSudo(command),
    };
  });
}

/**
 * planProgramUpgrades is one step per program that declares its own
 * `upgrade` (its `outdated` block), run once for that program alone, like
 * one custom-source item. A program this machine doesn't map is refused, as
 * an installer is.
 */
export function planProgramUpgrades(manifest: Manifest, machine: string, programs: readonly string[]): UpgradeStep[] {
  const config = manifest.machines.get(machine);
  const steps: UpgradeStep[] = [];
  for (const name of distinct(programs)) {
    const program = manifest.programs.get(name);
    const command = program?.outdated?.upgrade;
    if (program === undefined || command === undefined) throw cannotUpgrade("'" + name + "' declares no upgrade command");
    if (!config?.pm.has(name)) throw cannotUpgrade("'" + name + "' is not used by machine '" + machine + "'");
    steps.push({
      installers: [name],
      command: expandFilePrefix(command),
      covers: [name],
      sweep: false,
      origin: program.origin,
      program: true,
      sudo: commandNeedsSudo(command),
    });
  }
  return steps;
}

/**
 * planUpgrade is one step per named installer;
 * unknown or non-upgrading ones are errors.
 */
export function planUpgrade(manifest: Manifest, machine: string, installers: readonly string[]): UpgradeStep[] {
  const available = upgradableInstallers(manifest, machine);
  interface Located {
    command: string;
    origin: string;
  }
  const errors: string[] = [];
  const order: Located[] = [];
  const mechanisms = new Map<string, string[]>();
  const keyOf = (at: Located) => at.command + "\x00" + at.origin;
  for (const name of distinct(installers)) {
    const installer = manifest.installers.get(name);
    if (!available.has(name) || installer?.upgrade === undefined) {
      if (installer !== undefined && installer.upgrade !== undefined) {
        // Refusing this is the safety property: loadout only upgrades
        // mechanisms THIS machine's loadout uses, so a repo that maps
        // nothing to brew can never run it.
        errors.push("installer '" + name + "' is not used by machine '" + machine + "' — nothing here installs through it");
      } else if (installer !== undefined) {
        errors.push("installer '" + name + "' declares no upgrade command");
      } else if (manifest.programs.has(name)) {
        errors.push(
          "'" + name + "' is a program — upgrades are whole-mechanism, so name its " +
            "installer instead (see `loadout explain " + name + "`)",
        );
      } else {
        errors.push("unknown installer '" + name + "'");
      }
      continue;
    }
    const command = installer.upgrade;
    // Only a repo script depends on where it runs: the same plain
    // command from two files is still one transaction.
    const origin = expandFilePrefix(command) !== command ? installer.origin : "";
    const at: Located = { command: shellLine(command, toolPathOf(manifest, name)), origin };
    const key = keyOf(at);
    if (!mechanisms.has(key)) order.push(at);
    mechanisms.set(key, [...(mechanisms.get(key) ?? []), name]);
  }
  if (errors.length > 0) throw cannotUpgrade(...errors);
  // Same command (from the same directory, for a repo script) = same
  // transaction: run it once, name every mechanism it covers.
  return order.map((at) => {
    const names = mechanisms.get(keyOf(at))!;
    let covers: string[] = [];
    let probes: string[] = [];
    let sudo = commandNeedsSudo(at.command);
    for (const n of names) {
      covers.push(...(available.get(n) ?? []));
      const installer = manifest.installers.get(n)!;
      probes.push((installer.probe ?? "") + "\x00" + (installer.probe !== undefined ? "1" : "0"));
      sudo = sudo || installer.sudo;
    }
    covers = sortStrings(distinct(covers));
    probes = distinct(probes);
    const step: UpgradeStep = { installers: names, command: at.command, covers, sweep: true, origin: at.origin, program: false, sudo };
    const probe = manifest.installers.get(names[0]!)!.probe;
    if (probes.length === 1 && probe !== undefined) step.tool = probe;
    return step;
  });
}
