import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type MachineState, machineStateEqual, newMachineState, type ProgramState } from "../coremodel/coremodel.ts";
import { decode, encode } from "./codec.ts";
import { newStateStore, type StateStore, writeIfChanged } from "./store.ts";

const tempDir = () => mkdtempSync(tmpdir() + "/loadout-state-");

function sampleState(machine: string, rgVersion: string | undefined): MachineState {
  const rg: ProgramState = rgVersion === undefined ? { status: "missing" } : { status: "installed", version: rgVersion };
  return newMachineState({
    machine,
    os: "linux",
    distro: "fedora",
    arch: "x86_64",
    toolVersion: "0.1.0",
    updatedAt: "2026-08-14T12:00:00Z",
    programs: new Map([["ripgrep", rg]]),
  });
}

const read = (path: string) => readFileSync(path, "utf8");

const write = (store: StateStore, state: MachineState) => store.write(state);

test("round-trips state", () => {
  const store = newStateStore(tempDir(), "state", false);
  write(store, sampleState("laptop", "14.1.0"));
  const loaded = store.read("laptop");
  expect(loaded !== undefined && machineStateEqual(loaded, sampleState("laptop", "14.1.0"))).toBe(true);
  expect(store.read("ghost")).toBeUndefined();
});

test("a state file from an earlier loadout reads and writes back byte for byte", () => {
  const text = read(import.meta.dir + "/testdata/machine.json");
  expect(encode(decode(text))).toBe(text);
});

test("a parent's store is read, never written", () => {
  const root = tempDir();
  write(newStateStore(root, "state", false), sampleState("laptop", "14.1.0"));
  const parent = newStateStore(root, "state", true);
  expect([...parent.readAll().keys()]).toEqual(["laptop"]);
  expect(() => parent.write(sampleState("work", "14.1.0"))).toThrow();
  expect(readdirSync(root + "/state")).toEqual(["laptop.json"]);
});

test("readAll returns all machines", () => {
  const store = newStateStore(tempDir(), "state", false);
  write(store, sampleState("laptop", "14.1.0"));
  write(store, sampleState("desktop", undefined));
  const all = store.readAll();
  expect([...all.keys()]).toEqual(["desktop", "laptop"]);
  expect(all.get("desktop")!.programs.get("ripgrep")!.status).toBe("missing");
});

test("readAll on an empty repo is empty", () => {
  const store = newStateStore(tempDir(), "state", false);
  expect(store.readAll().size).toBe(0);
  expect(store.lastWarnings()).toEqual([]);
});

test("newer-schema state files are skipped with a warning", () => {
  const root = tempDir();
  const store = newStateStore(root, "state", false);
  write(store, sampleState("laptop", "14.1.0"));
  const future = `{"schemaVersion": 99, "machine": "future", "os": "linux", "arch": "x86_64",
                    "toolVersion": "9.9.9", "updatedAt": "2027-01-01T00:00:00Z"}`;
  writeFileSync(root + "/state/future.json", future);
  expect([...store.readAll().keys()]).toEqual(["laptop"]);
  const w = store.lastWarnings();
  expect(w.length).toBe(1);
  expect(w[0]).toBe(
    "state/future.json was written by a newer loadout (schema 99 > 1) — ignoring it; upgrade loadout to see this machine",
  );
  expect(store.read("future")).toBeUndefined();
  expect(store.lastWarnings().length).not.toBe(0);
  store.read("laptop");
  expect(store.lastWarnings()).toEqual([]);
});

test("configs are left out when empty and round-trip when present", () => {
  const root = tempDir();
  const store = newStateStore(root, "state", false);
  write(store, sampleState("plain", "14.1.0"));
  expect(read(root + "/state/plain.json")).not.toContain("configs");
  const withConfigs: MachineState = {
    ...sampleState("dotted", "14.1.0"),
    configs: new Map([
      ["tmux", { status: "applied", files: [] }],
      ["zsh", { status: "drifted", files: [".config/zsh/.zshrc"] }],
    ]),
  };
  write(store, withConfigs);
  expect(read(root + "/state/dotted.json")).toContain(`"drifted"`);
  const got = store.read("dotted");
  expect(got !== undefined && machineStateEqual(got, withConfigs)).toBe(true);
});

test("written JSON uses lowercase status names", () => {
  const root = tempDir();
  write(newStateStore(root, "state", false), sampleState("laptop", "14.1.0"));
  const text = read(root + "/state/laptop.json");
  expect(text).toContain(`"installed"`);
  expect(text).not.toContain("INSTALLED");
});

test("an unreadable state file warns instead of crashing", () => {
  const root = tempDir();
  mkdirSync(root + "/state");
  writeFileSync(root + "/state/m1.json", "{ this is not json");
  writeFileSync(root + "/state/m2.json", "{ also broken");
  const store = newStateStore(root, "state", false);

  // read: a crash here reaches the user as a stack trace (contract 9).
  expect(store.read("m1")).toBeUndefined();
  const w = store.lastWarnings();
  expect(w.length).toBe(1);
  expect(w[0]).toContain("state/m1.json");
  // readAll: silence here would make the machine vanish from `diff`.
  expect(store.readAll().size).toBe(0);
  expect(store.lastWarnings().length).toBe(2);
});

test("updatedAt moves only when something else changed", () => {
  const store = newStateStore(tempDir(), "state", false);
  const first = sampleState("laptop", "14.1.0");
  write(store, first);
  const again = { ...sampleState("laptop", "14.1.0"), updatedAt: "2026-08-15T00:00:00Z" };
  const kept = store.writeChanged(first, again);
  expect(kept.updatedAt).toBe(first.updatedAt);
  expect(store.read("laptop")!.updatedAt).toBe(first.updatedAt);
  const moved = { ...sampleState("laptop", "14.2.0"), updatedAt: "2026-08-15T00:00:00Z" };
  expect(store.writeChanged(first, moved).updatedAt).toBe(moved.updatedAt);
  expect(store.read("laptop")!.updatedAt).toBe(moved.updatedAt);
});

test("compile writes only under the repo root and only what changed", async () => {
  const root = tempDir();
  const target = root + "/configs/.chezmoidata/loadout.json";
  writeIfChanged(root, target, "{}\n");
  expect(read(target)).toBe("{}\n");
  const before = statSync(target).mtimeMs;
  await Bun.sleep(10);
  writeIfChanged(root, target, "{}\n");
  expect(statSync(target).mtimeMs).toBe(before);
  expect(() => writeIfChanged(root, root + "/../parent/loadout.lock.json", "x")).toThrow("compile writes only under the repo root");
});

test("file errors are worded with the operation and the path", () => {
  if (process.getuid?.() === 0) return;
  const root = tempDir();
  mkdirSync(root + "/state");
  chmodSync(root + "/state", 0o000);
  try {
    const store = newStateStore(root, "state", false);
    expect(store.readAll().size).toBe(0);
    expect(store.lastWarnings()).toEqual([`state is not readable (open ${root}/state: permission denied)`]);
  } finally {
    chmodSync(root + "/state", 0o755);
  }
  mkdirSync(root + "/state/d.json");
  const store = newStateStore(root, "state", false);
  store.readAll();
  expect(store.lastWarnings()[0]).toBe(
    `state/d.json is not readable state (read ${root}/state/d.json: is a directory) — ignoring it; it is regenerated by \`loadout status\` on that machine`,
  );
});

test("a decode error names the missing field and where", () => {
  expect(() => decode(`{"machine": "m", "os": "linux", "arch": "x", "toolVersion": "1"}`)).toThrow(
    "Field 'updatedAt' is required for type with serial name 'loadout.core.model.MachineState', but it was missing at path: $",
  );
  expect(() =>
    decode(`{"machine": "m", "os": "linux", "arch": "x", "toolVersion": "1", "updatedAt": "t", "programs": {"rg": {"status": "gone"}}}`),
  ).toThrow("unknown status 'gone' at element: $.programs.rg.status");
  expect(() =>
    decode(`{"machine": "m", "os": "linux", "arch": "x", "toolVersion": "1", "updatedAt": "t", "scripts": {"s": {"status": "done", "exitCode": "1"}}}`),
  ).toThrow("Expected an int at element: $.scripts.s.exitCode");
});
