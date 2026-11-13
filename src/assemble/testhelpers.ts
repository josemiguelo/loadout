// The assemble tests' shared builders (Go's helpers in assemble_test.go).
// TEST-ONLY.

import { expect } from "bun:test";
import {
  type InstallVariant,
  type JSONObject,
  type JSONValue,
  type MachineConfig,
  mapFS,
  mapOf,
  newInstallVariant,
  newMachineConfig,
  type Program,
  type RepoFS,
} from "../model/index.ts";

/** fsWith is a repo holding files, each a tiny shell script. */
export function fsWith(...files: string[]): RepoFS {
  return mapFS(Object.fromEntries(files.map((f) => [f, "#!/bin/sh\n"])));
}

export function contains(message: string, ...wants: string[]): void {
  for (const want of wants) expect(message).toContain(want);
}

export function programs(...entries: [string, Program][]): Map<string, Program> {
  return mapOf(...entries);
}

export function install(...entries: [string, InstallVariant][]): Map<string, InstallVariant> {
  return mapOf(...entries);
}

export function custom(command: string): Map<string, InstallVariant> {
  return install(["custom", newInstallVariant({ command })]);
}

export function via(...names: string[]): Map<string, InstallVariant> {
  return new Map(names.map((n) => [n, newInstallVariant()]));
}

export function machine(name: string, c: Partial<MachineConfig>): [string, MachineConfig] {
  return [name, newMachineConfig({ ...c, label: "machine '" + name + "'" })];
}

export function profile(name: string, c: Partial<MachineConfig>): [string, MachineConfig] {
  return [name, newMachineConfig({ ...c, label: "profile '" + name + "'" })];
}

export function pm(...pairs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < pairs.length; i += 2) out.set(pairs[i]!, pairs[i + 1]!);
  return out;
}

export function data(...entries: [string, JSONValue][]): JSONObject {
  return mapOf(...entries);
}

