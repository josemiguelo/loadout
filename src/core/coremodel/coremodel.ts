// Package coremodel is what the binary observes, as opposed to what the lock
// declares: a machine's state file
// and the system it runs on.

import { slicesEqual } from "../../model/index.ts";

/** schemaVersion is the highest state-file schema this build understands. */
export const schemaVersion = 1;

/** MachineState is `<state>/<machine>.json`: what one machine last observed. */
export interface MachineState {
  /** schemaVersion is the file's schema; 0 is written as schemaVersion. */
  schemaVersion: number;
  machine: string;
  os: string;
  distro?: string;
  arch: string;
  toolVersion: string;
  /** updatedAt is the ISO-8601 UTC timestamp of the last state refresh. */
  updatedAt: string;
  programs: Map<string, ProgramState>;
  scripts: Map<string, ScriptState>;
  /**
   * configs is the config units (`layout configs`), keyed by unit name. Left
   * out of the file when empty, so a repo without configs writes what it
   * always did.
   */
  configs: Map<string, ConfigState>;
}

/** newMachineState is a MachineState with every field not given at its zero value. */
export function newMachineState(s: Partial<MachineState> = {}): MachineState {
  return {
    schemaVersion: 0,
    machine: "",
    os: "",
    arch: "",
    toolVersion: "",
    updatedAt: "",
    programs: new Map(),
    scripts: new Map(),
    configs: new Map(),
    ...s,
  };
}

/** ConfigState is one config unit as chezmoi reported it. */
export interface ConfigState {
  status: ConfigStatus;
  /** files is the targets `chezmoi apply` would change, relative to the destination (drifted). */
  files: string[];
  /** reason is why chezmoi couldn't answer (unknown). Text for a person; never parsed. */
  reason?: string;
}

/** ConfigStatus is a config unit's verdict. */
export type ConfigStatus = "applied" | "drifted" | "unknown";

export const configApplied: ConfigStatus = "applied";
export const configDrifted: ConfigStatus = "drifted";
export const configUnknown: ConfigStatus = "unknown";

/** ProgramState is one program as its version check saw it. */
export interface ProgramState {
  status: ProgramStatus;
  version?: string;
  /**
   * reason is why the check couldn't answer (unknown: "brew: command not
   * found") or what the tool said when it said no (missing, when it said
   * anything). Text for a person; never parsed.
   */
  reason?: string;
}

/**
 * ProgramStatus is a program's verdict. "unknown": the program declares no
 * version check, or the check couldn't run.
 */
export type ProgramStatus = "installed" | "missing" | "unknown";

export const installed: ProgramStatus = "installed";
export const missing: ProgramStatus = "missing";
/** unknown: the program declares no version check, or the check couldn't run. */
export const unknown: ProgramStatus = "unknown";

/** ScriptState is one script's verdict and its last run by loadout. */
export interface ScriptState {
  status: ScriptStatus;
  lastRun?: string;
  exitCode?: number;
}

/** ScriptStatus is a script's verdict. */
export type ScriptStatus = "done" | "failed" | "pending";

export const done: ScriptStatus = "done";
export const failed: ScriptStatus = "failed";
export const pending: ScriptStatus = "pending";

/** OsFamily is the operating system, as LOADOUT_OS and state files name it; "" is none. */
export type OsFamily = "linux" | "macos" | "";

export const linux: OsFamily = "linux";
export const macOS: OsFamily = "macos";

/** osFamilyFromID is the family id names, or "" when none. */
export function osFamilyFromID(id: string): OsFamily {
  return id === "linux" || id === "macos" ? id : "";
}

/** SystemInfo is the machine loadout runs on. */
export interface SystemInfo {
  machine: string;
  os: OsFamily;
  distro?: string;
  arch: string;
}

/** machineStateEqual is value equality: maps compare by content, in any order. */
export function machineStateEqual(s: MachineState, o: MachineState): boolean {
  return (
    schema(s.schemaVersion) === schema(o.schemaVersion) &&
    s.machine === o.machine &&
    s.os === o.os &&
    s.distro === o.distro &&
    s.arch === o.arch &&
    s.toolVersion === o.toolVersion &&
    s.updatedAt === o.updatedAt &&
    mapsEqual(s.programs, o.programs, programStateEqual) &&
    mapsEqual(s.scripts, o.scripts, scriptStateEqual) &&
    mapsEqual(s.configs, o.configs, configStateEqual)
  );
}

/** programStateEqual is value equality. */
export function programStateEqual(p: ProgramState, o: ProgramState): boolean {
  return p.status === o.status && p.version === o.version && p.reason === o.reason;
}

/** scriptStateEqual is value equality. */
export function scriptStateEqual(s: ScriptState, o: ScriptState): boolean {
  return s.status === o.status && s.lastRun === o.lastRun && s.exitCode === o.exitCode;
}

/** configStateEqual is value equality. */
export function configStateEqual(c: ConfigState, o: ConfigState): boolean {
  return c.status === o.status && slicesEqual(c.files, o.files) && c.reason === o.reason;
}

function schema(v: number): number {
  return v === 0 ? schemaVersion : v;
}

function mapsEqual<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>, eq: (x: V, y: V) => boolean): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w === undefined || !eq(v, w)) return false;
  }
  return true;
}
