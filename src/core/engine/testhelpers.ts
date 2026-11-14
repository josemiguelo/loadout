// The engine tests' shared helpers. TEST-ONLY.

import { expect } from "bun:test";
import type { SystemInfo } from "../coremodel/coremodel.ts";
import { manifestOf, pm, variants, version } from "../coretest/coretest.ts";
import { newCommandFrame } from "../exec/index.ts";
import { type Manifest, newInstallVariant } from "../../model/index.ts";

export const repoFrame = newCommandFrame("/repo", undefined, undefined);

export function contains(message: string, ...wants: string[]): void {
  for (const want of wants) expect(message).toContain(want);
}

/** refused is the message of what f throws (or rejects with), which must be a T. */
export async function refused(type: abstract new (...args: never[]) => Error, f: () => unknown): Promise<string> {
  let caught: unknown;
  try {
    await f();
  } catch (e) {
    caught = e;
  }
  if (caught === undefined) throw new Error("no refusal");
  expect(caught).toBeInstanceOf(type);
  return (caught as Error).message;
}

export function statusManifest(): Manifest {
  return manifestOf((b) => {
    b.program("git", {
      version: version("git --version", "git version ([0-9.]+)"),
      install: variants(["dnf", newInstallVariant({ command: "sudo dnf install -y git" })]),
    });
    b.script("dotfiles", { run: "echo setup", check: "test -d $HOME/.dotfiles" });
    b.script("uncheckable", { run: "echo once" });
    b.script("not-opted-in", { run: "echo never", check: "true" });
    b.machine("laptop", { pm: pm("git", "dnf"), scripts: ["dotfiles", "uncheckable"] });
  });
}

export const laptop: SystemInfo = { machine: "laptop", os: "linux", distro: "fedora", arch: "x86_64" };
