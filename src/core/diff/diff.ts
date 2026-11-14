// The diff module compares the fleet: manifest × states -> DiffReport. Pure.

import { distinct, type Manifest, sortStrings } from "../../model/index.ts";
import type { MachineState } from "../coremodel/coremodel.ts";

/**
 * InstallKind is what a machine's state says of a program. "unknown": no
 * state entry for this program (stale state file or check failed to parse).
 */
export type InstallKind = "unknown" | "installed" | "missing";

/** unknown: no state entry for this program (stale state file or check failed to parse). */
export const unknown: InstallKind = "unknown";
export const installed: InstallKind = "installed";
export const missing: InstallKind = "missing";

/** InstallState is one program on one machine; version only when installed. */
export interface InstallState {
  kind: InstallKind;
  version?: string;
}

/** ProgramRow is one program across the machines. */
export interface ProgramRow {
  program: string;
  perMachine: Map<string, InstallState>;
}

/** drift says two or more machines report distinct installed versions. */
export function drift(r: ProgramRow): boolean {
  const versions: string[] = [];
  for (const s of r.perMachine.values()) {
    if (s.kind === installed && s.version !== undefined) versions.push(s.version);
  }
  return distinct(versions).length > 1;
}

/** incomplete says at least one machine is missing this program. */
export function incomplete(r: ProgramRow): boolean {
  for (const s of r.perMachine.values()) if (s.kind === missing) return true;
  return false;
}

/**
 * ConfigKind is what a machine's state says of a config unit. "unknown": no
 * state entry: the unit isn't on this machine, or chezmoi couldn't answer.
 */
export type ConfigKind = "unknown" | "applied" | "drifted";

/** configUnknown: no state entry: the unit isn't on this machine, or chezmoi couldn't answer. */
export const configUnknown: ConfigKind = "unknown";
export const configApplied: ConfigKind = "applied";
export const configDrifted: ConfigKind = "drifted";

/** ConfigCell is one unit on one machine; files (how many drifted) only when drifted, else 0. */
export interface ConfigCell {
  kind: ConfigKind;
  files: number;
}

/** ConfigRow is one config unit across the machines. */
export interface ConfigRow {
  unit: string;
  perMachine: Map<string, ConfigCell>;
}

/** drifted says at least one machine's files differ from the repo. */
export function drifted(r: ConfigRow): boolean {
  for (const c of r.perMachine.values()) if (c.kind === configDrifted) return true;
  return false;
}

/** DiffReport is the fleet compared. */
export interface DiffReport {
  machines: string[];
  rows: ProgramRow[];
  /** configs is every config unit any compared machine reports; empty without configs. */
  configs: ConfigRow[];
}

/** hasDrift says some program's versions differ between machines. */
export function hasDrift(r: DiffReport): boolean {
  return r.rows.some(drift);
}

/** hasMissing says some machine is missing some program. */
export function hasMissing(r: DiffReport): boolean {
  return r.rows.some(incomplete);
}

/** hasConfigDrift says some machine's configs differ from the repo. */
export function hasConfigDrift(r: DiffReport): boolean {
  return r.configs.some(drifted);
}

/** diff compares states against manifest's programs. */
export function diff(manifest: Manifest, states: readonly MachineState[]): DiffReport {
  const machines: string[] = [];
  const byMachine = new Map<string, MachineState>();
  for (const s of states) {
    machines.push(s.machine);
    byMachine.set(s.machine, s);
  }
  sortStrings(machines);

  const rows: ProgramRow[] = [];
  for (const program of sortStrings([...manifest.programs.keys()])) {
    const per = new Map<string, InstallState>();
    for (const machine of machines) {
      const entry = byMachine.get(machine)?.programs.get(program);
      let cell: InstallState = { kind: unknown };
      if (entry?.status === "installed") cell = { kind: installed, version: entry.version };
      else if (entry?.status === "missing") cell = { kind: missing };
      per.set(machine, cell);
    }
    rows.push({ program, perMachine: per });
  }

  const units = sortStrings(distinct(states.flatMap((s) => [...s.configs.keys()])));
  const configs: ConfigRow[] = [];
  for (const unit of units) {
    const per = new Map<string, ConfigCell>();
    for (const machine of machines) {
      const entry = byMachine.get(machine)?.configs.get(unit);
      let cell: ConfigCell = { kind: configUnknown, files: 0 };
      if (entry?.status === "applied") cell = { kind: configApplied, files: 0 };
      else if (entry?.status === "drifted") cell = { kind: configDrifted, files: entry.files.length };
      per.set(machine, cell);
    }
    configs.push({ unit, perMachine: per });
  }
  return { machines, rows, configs };
}
