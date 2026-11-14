// The coretest module builds the core tests' manifests the way a repo's
// declarations do: a ManifestDraft through assembleWithoutFiles, so
// built-ins, flattening and validation are the production path (contract
// 10). TEST-ONLY. A draft that doesn't assemble throws, failing the test.

import { assembleWithoutFiles, newManifestDraft } from "../../assemble/index.ts";
import {
  type Installer,
  type InstallVariant,
  type MachineConfig,
  type Manifest,
  newInstaller,
  newInstallVariant,
  newMachineConfig,
  newOutdatedSource,
  newProgram,
  newRepoLayout,
  newScriptStep,
  newVersionCheck,
  type OutdatedSource,
  type Program,
  type RepoLayout,
  type ScriptStep,
  type VersionCheck,
} from "../../model/index.ts";

/** Draft is what a test declares; every declaration's origin is the root unless it says otherwise. */
export class Draft {
  readonly d = newManifestDraft();

  /** meta names the repo and its floor ("" = none). */
  meta(name: string, minToolVersion: string): void {
    this.d.manifest.meta = { ...this.d.manifest.meta, name, minToolVersion: minToolVersion === "" ? undefined : minToolVersion };
  }

  /** layout sets the layout (state "state" when it says none). */
  layout(layout: Partial<RepoLayout>): void {
    this.d.manifest.layout = newRepoLayout(layout);
  }

  /** installer declares an installer; its regex defaults to defaultRegex, as a front end's does. */
  installer(name: string, i: Partial<Installer>): void {
    this.d.manifest.installers.set(name, newInstaller({ ...i, regex: i.regex ?? defaultRegex }));
  }

  /** requires adds programs to what installer requires (`brew.requires(setup)`). */
  requires(installer: string, ...programs: string[]): void {
    this.d.requires.set(installer, [...(this.d.requires.get(installer) ?? []), ...programs]);
  }

  /** program declares a program. */
  program(name: string, p: Partial<Program>): void {
    this.d.manifest.programs.set(name, newProgram(p));
  }

  /** script declares a script. */
  script(name: string, s: Partial<ScriptStep>): void {
    this.d.manifest.scripts.set(name, newScriptStep(s));
  }

  /** outdated declares a custom `outdated` source. */
  outdated(name: string, o: Partial<OutdatedSource>): void {
    this.d.manifest.outdated.set(name, newOutdatedSource(o));
  }

  /** machine declares a machine. */
  machine(name: string, c: Partial<MachineConfig>): void {
    this.d.manifest.machines.set(name, newMachineConfig({ ...c, label: "machine '" + name + "'" }));
  }
}

/** defaultRegex is a front end's version regex when an installer names none: the first dotted number in the output. */
export const defaultRegex = String.raw`([0-9]+\.[0-9][0-9.]*)`;

/** manifestOf is the manifest build declares, assembled without the `file:` checks. */
export function manifestOf(build: (b: Draft) => void): Manifest {
  const b = new Draft();
  build(b);
  if (b.d.manifest.layout.state === "") b.d.manifest.layout = { ...b.d.manifest.layout, state: "state" };
  return assembleWithoutFiles(b.d);
}

/** via is variants through each installer, as it is (`installVia(brew, dnf)`). */
export function via(...installers: string[]): Map<string, InstallVariant> {
  return new Map(installers.map((i) => [i, newInstallVariant()]));
}

/** variants is the variants given, in order. */
export function variants(...entries: [string, InstallVariant][]): Map<string, InstallVariant> {
  return new Map(entries);
}

/** custom is one variant named key running command (`custom(key) { command = … }`). */
export function custom(key: string, command: string): Map<string, InstallVariant> {
  return variants([key, newInstallVariant({ command })]);
}

/** pm is a machine's mapping from program, key pairs. */
export function pm(...pairs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < pairs.length; i += 2) out.set(pairs[i]!, pairs[i + 1]!);
  return out;
}

/** version is a program's version check (`version(command, regex)`). */
export function version(command: string, regex: string): VersionCheck {
  return newVersionCheck({ command, regex });
}

/**
 * example is the shared fixture (EXAMPLE_MANIFEST): three installers of its
 * own (replacing the built-ins of their names, so commands stay short), git
 * and ripgrep through them, rustup by its own command, a dotfiles script no
 * machine runs, and two machines.
 */
export function example(): Manifest {
  return manifestOf((b) => {
    b.meta("example machines", "0.1.0");
    b.layout({ state: "state" });
    b.installer("brew", { probe: "brew", install: "brew install {pkg}" });
    b.installer("dnf", { probe: "dnf", install: "sudo dnf install -y {pkg}" });
    b.installer("apt", { probe: "apt-get", install: "sudo apt-get install -y {pkg}" });
    b.program("git", {
      description: "version control",
      install: via("brew", "dnf", "apt"),
      version: version("git --version", "git version ([0-9.]+)"),
    });
    b.program("ripgrep", {
      description: "fast grep",
      tags: ["cli"],
      dependsOn: ["git"],
      install: via("brew", "dnf"),
      version: version("rg --version", "ripgrep ([0-9][0-9a-zA-Z.-]*)"),
    });
    b.program("rustup", {
      description: "rust toolchain manager",
      version: version("rustup --version", "rustup ([0-9.]+)"),
      install: custom("script", "curl -sSf https://sh.rustup.rs | sh -s -- -y"),
    });
    b.script("dotfiles", {
      description: "clone and link dotfiles",
      file: "scripts/dotfiles.sh",
      check: "test -d $HOME/.dotfiles",
      after: ["programs.git"],
    });
    b.machine("laptop", { pm: pm("git", "dnf", "ripgrep", "dnf", "rustup", "script") });
    b.machine("macbook", { pm: pm("git", "brew", "ripgrep", "brew", "rustup", "script") });
  });
}
