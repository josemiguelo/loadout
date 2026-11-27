import { expect, test } from "bun:test";
import { type MachineState, newMachineState, type ProgramState } from "../coremodel/coremodel.ts";
import { example } from "../coretest/coretest.ts";
import { type DiffReport, diff, drift, drifted, hasConfigDrift, hasDrift, hasMissing, incomplete, type ProgramRow } from "./diff.ts";

const installed = (v: string): ProgramState => ({ status: "installed", version: v });
const missing: ProgramState = { status: "missing" };

function state(machine: string, ...programs: [string, ProgramState][]): MachineState {
  return newMachineState({
    machine,
    os: "linux",
    arch: "x86_64",
    toolVersion: "0.1.0",
    updatedAt: "2026-08-14T12:00:00Z",
    programs: new Map(programs),
  });
}

function row(r: DiffReport, program: string): ProgramRow {
  const p = r.rows.find((p) => p.program === program);
  if (p === undefined) throw new Error(program);
  return p;
}

test("detects drift, missing and unknown", () => {
  const laptop = state("laptop", ["git", installed("2.46.0")], ["ripgrep", installed("14.1.0")], ["rustup", missing]);
  const desktop = state("desktop", ["git", installed("2.43.0")], ["ripgrep", installed("14.1.0")]);
  // no rustup entry at all on desktop -> unknown

  const report = diff(example(), [laptop, desktop]);
  expect(report.machines).toEqual(["desktop", "laptop"]);
  expect(report.rows.map((r) => r.program)).toEqual(["git", "ripgrep", "rustup"]);

  const git = row(report, "git");
  expect(drift(git)).toBe(true);
  expect(incomplete(git)).toBe(false);
  const ripgrep = row(report, "ripgrep");
  expect(drift(ripgrep)).toBe(false);
  expect(incomplete(ripgrep)).toBe(false);
  const rustup = row(report, "rustup");
  expect(drift(rustup)).toBe(false);
  expect(incomplete(rustup)).toBe(true);
  expect(rustup.perMachine.get("desktop")!.kind).toBe("unknown");
  expect(rustup.perMachine.get("laptop")!.kind).toBe("missing");

  expect(hasDrift(report)).toBe(true);
  expect(hasMissing(report)).toBe(true);
});

test("a clean report has no flags", () => {
  const all: [string, ProgramState][] = [["git", installed("2.46.0")], ["ripgrep", installed("14.1.0")], ["rustup", installed("1.27.1")]];
  const report = diff(example(), [state("a", ...all), state("b", ...all)]);
  expect(hasDrift(report)).toBe(false);
  expect(hasMissing(report)).toBe(false);
  expect(report.configs.length).toBe(0);
});

test("config units compare per machine", () => {
  const a: MachineState = {
    ...state("a"),
    configs: new Map([
      ["zsh", { status: "drifted", files: [".config/zsh/.zshrc", ".zshenv"] }],
      ["mise", { status: "applied", files: [] }],
    ]),
  };
  const b: MachineState = { ...state("b"), configs: new Map([["zsh", { status: "applied", files: [] }]]) };

  const report = diff(example(), [a, b]);
  expect(report.configs[0]!.unit).toBe("mise");
  expect(report.configs[1]!.unit).toBe("zsh");
  const zsh = report.configs[1]!;
  expect(zsh.perMachine.get("a")).toEqual({ kind: "drifted", files: 2 });
  expect(zsh.perMachine.get("b")).toEqual({ kind: "applied", files: 0 });
  // A unit one machine doesn't have (ignored there) is no drift.
  const mise = report.configs[0]!;
  expect(mise.perMachine.get("b")).toEqual({ kind: "unknown", files: 0 });
  expect(drifted(mise)).toBe(false);
  expect(hasConfigDrift(report)).toBe(true);
});
