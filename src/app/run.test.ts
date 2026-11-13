import { afterEach, expect, test } from "bun:test";
import { newDetection } from "../core/detect/detect.ts";
import { newRunner } from "../core/exec/fakeexec/fakeexec.ts";
import { mapFS } from "../model/index.ts";
import { type AppContext, newAppWith } from "./context.ts";
import { selfArgv, shQuote } from "./run.ts";
import { ActionHandOff, ActionNone, PaneScripts } from "./screen.ts";

function appOf(repoRoot: string, machineOverride = "", verbose = false): AppContext {
  const runner = newRunner();
  return newAppWith(repoRoot, machineOverride, verbose, runner, newDetection(runner, mapFS({})));
}

const pager = process.env.PAGER;
afterEach(() => {
  if (pager === undefined) delete process.env.PAGER;
  else process.env.PAGER = pager;
});

test("run command is the child loadout with the handoff env", () => {
  process.env.PAGER = "less";
  const a = appOf("/repo", "m1");
  const cmd = a.childCommand("/bin/loadout", "install", ["a b", "--yes"]);
  expect(cmd.argv).toEqual(["/bin/loadout", "--repo", "/repo", "--machine", "m1", "install", "a b", "--yes"]);
  for (const [k, v] of Object.entries({ LOADOUT_HANDOFF: "1", PAGER: "cat", GIT_PAGER: "cat" })) {
    expect(cmd.env?.[k]).toBe(v);
  }
  expect(cmd.cwd).toBeUndefined();
});

test("run command runs closed's command", () => {
  const a = appOf("/repo");
  const cmd = a.runCommand({ action: ActionHandOff, handoff: { kind: PaneScripts, args: ["s1"] } });
  expect(cmd?.argv.slice(1)).toEqual(["--repo", "/repo", "run", "s1", "--force"]);
  expect(a.runCommand({ action: ActionNone })).toBeUndefined();
});

test("quoting survives spaces and single quotes", () => {
  for (const [input, want] of Object.entries({ plain: "'plain'", "a b": "'a b'", "it's": `'it'\\''s'` })) {
    expect(shQuote(input)).toBe(want);
  }
});

test("self argv carries the global options", () => {
  const got = selfArgv({ repoRoot: "repo", machineOverride: "m1", verbose: true }, "/bin/loadout", "run", "x");
  expect(got).toEqual(["/bin/loadout", "--repo", "repo", "--machine", "m1", "-v", "run", "x"]);
});
