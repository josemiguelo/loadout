import { expect, test } from "bun:test";
import { machineStateEqual, newMachineState, osFamilyFromID } from "./coremodel.ts";

// These pin the equality the state store's writeIfChanged relies on
// (contract 8).

test("state equality reads schema 0 as the current one and maps in any order", () => {
  const a = newMachineState({
    schemaVersion: 0,
    machine: "m",
    programs: new Map([
      ["git", { status: "installed", version: "2.0" }],
      ["jq", { status: "missing" }],
    ]),
    configs: new Map([["tmux", { status: "drifted", files: [".tmux.conf"] }]]),
  });
  const b = newMachineState({
    schemaVersion: 1,
    machine: "m",
    programs: new Map([
      ["jq", { status: "missing" }],
      ["git", { status: "installed", version: "2.0" }],
    ]),
    configs: new Map([["tmux", { status: "drifted", files: [".tmux.conf"] }]]),
  });
  expect(machineStateEqual(a, b)).toBe(true);
  expect(machineStateEqual(a, { ...b, programs: new Map([["git", { status: "installed", version: "2.1" }]]) })).toBe(false);
  expect(machineStateEqual(a, { ...b, configs: new Map([["tmux", { status: "drifted", files: [] }]]) })).toBe(false);
  expect(machineStateEqual(a, { ...b, scripts: new Map([["s", { status: "done", exitCode: 0 }]]) })).toBe(false);
});

test("an os family is linux or macos, else none", () => {
  expect([osFamilyFromID("linux"), osFamilyFromID("macos"), osFamilyFromID("windows")]).toEqual(["linux", "macos", ""]);
});
