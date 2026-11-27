import { expect, test } from "bun:test";
import { type MachineState, type ScriptState, scriptStateEqual } from "../coremodel/coremodel.ts";
import { newRunner, type Runner, stdout } from "../exec/fakeexec/fakeexec.ts";
import { mapOf } from "../../model/index.ts";
import { newStatusEngine } from "./statusengine.ts";
import { laptop, repoFrame, statusManifest } from "./testhelpers.ts";
import { newVersionChecker } from "./versionchecker.ts";

function refresh(runner: Runner, previous: MachineState | undefined, runs: Map<string, ScriptState>): Promise<MachineState> {
  const engine = newStatusEngine(newVersionChecker(runner, repoFrame), runner, repoFrame, undefined);
  return engine.refresh(statusManifest(), laptop, previous, runs);
}

const history: ScriptState = { status: "done", lastRun: "2026-08-17T10:00:00Z", exitCode: 0 };

test("checked script observed as done even if never run by tool", async () => {
  const runner = newRunner().onCommand("git --version", stdout("git version 2.55.0")).onCommand("test -d $HOME/.dotfiles");
  const state = await refresh(runner, undefined, new Map());
  const d = state.scripts.get("dotfiles")!;
  expect(d.status).toBe("done");
  expect(d.lastRun).toBeUndefined();
});

test("checked script observed as pending when check fails", async () => {
  const state = await refresh(newRunner(), undefined, new Map());
  expect(state.scripts.get("dotfiles")!.status).toBe("pending");
});

test("scripts without opt-in are not observed", async () => {
  const state = await refresh(newRunner(), undefined, new Map());
  expect(state.scripts.has("not-opted-in")).toBe(false);
});

test("uncheckable script keeps run history only", async () => {
  const runner = newRunner();
  expect((await refresh(runner, undefined, new Map())).scripts.has("uncheckable")).toBe(false); // observed without history
  const withRun = await refresh(runner, undefined, mapOf(["uncheckable", history]));
  expect(scriptStateEqual(withRun.scripts.get("uncheckable")!, history)).toBe(true);
  // ...and it survives later refreshes via the previous state.
  const later = await refresh(runner, withRun, new Map());
  expect(scriptStateEqual(later.scripts.get("uncheckable")!, history)).toBe(true);
});

test("check overrides fresh run status but keeps history", async () => {
  // The tool just ran the script "successfully", but the check still fails.
  const state = await refresh(newRunner(), undefined, mapOf(["dotfiles", history]));
  const entry = state.scripts.get("dotfiles")!;
  expect(entry.status).toBe("pending");
  expect(entry.lastRun).toBe("2026-08-17T10:00:00Z");
  expect(entry.exitCode).toBe(0);
});
