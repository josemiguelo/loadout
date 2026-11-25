import { afterEach, expect, test } from "bun:test";
import type { SystemInfo } from "../coremodel/coremodel.ts";
import { exit, newRunner, type Runner } from "../exec/fakeexec/fakeexec.ts";
import { frameOf } from "../exec/index.ts";
import { bunDirVar, fileLine, moduleLine, newScriptStep, type ScriptStep } from "../../model/index.ts";
import { newScriptRunner, type ScriptOutcome } from "./scriptrunner.ts";
import { repoFrame } from "./testhelpers.ts";

function runScript(fake: Runner, step: ScriptStep, force: boolean, args: string): Promise<ScriptOutcome> {
  return newScriptRunner(fake, repoFrame).run(step, force, args);
}

test("skips when check passes", async () => {
  const fake = newRunner().onCommand("test -d $HOME/.dotfiles");
  expect((await runScript(fake, newScriptStep({ run: "file:x.sh", check: "test -d $HOME/.dotfiles" }), false, "")).alreadyDone).toBe(true);
});

test("a module's check and install get the options", async () => {
  const options = `'{"key":"a b"}'`;
  const fake = newRunner().onCommand(moduleLine("x.ts", "check 'x.rules.ts' " + options), exit(1)).onCommand(moduleLine("x.ts", "install 'x.rules.ts' " + options));
  expect((await runScript(fake, newScriptStep({ module: "x.ts", rules: "x.rules.ts" }), false, options)).alreadyDone).toBe(false);
  expect(fake.executed()).toEqual([moduleLine("x.ts", "check 'x.rules.ts' " + options), moduleLine("x.ts", "install 'x.rules.ts' " + options)]);
});

test("force ignores check", async () => {
  const fake = newRunner().onCommand("test -d $HOME/.dotfiles").onCommand("echo hi");
  const outcome = await runScript(fake, newScriptStep({ run: "echo hi", check: "test -d $HOME/.dotfiles" }), true, "");
  expect(outcome.alreadyDone).toBe(false);
  expect(outcome.state?.status).toBe("done");
});

test("runs script file through sh", async () => {
  const fake = newRunner().onCommand(fileLine("scripts/setup.sh", ""));
  const outcome = await runScript(fake, newScriptStep({ run: "file:scripts/setup.sh" }), false, "");
  expect(outcome.alreadyDone).toBe(false);
  expect(outcome.state?.status).toBe("done");
  expect(fake.executed()).toContain(fileLine("scripts/setup.sh", ""));
});

test("a script and its check run in the declaring directory with the loadout env", async () => {
  const fake = newRunner().onCommand(fileLine("plugins.sh", "check"), exit(1)).onCommand(fileLine("plugins.sh", ""));
  const system: SystemInfo = { machine: "m1", os: "macos", arch: "arm64" };
  const frame = frameOf("/repo", system, "configs", "", undefined, "");
  const step = newScriptStep({ run: "file:plugins.sh", check: "file:plugins.sh check", origin: "configs/tmux" });

  const outcome = await newScriptRunner(fake, frame).run(step, false, "");
  expect(outcome.alreadyDone).toBe(false);
  const received = fake.received();
  expect(received.length).toBe(2);
  for (const command of received) {
    expect(command.cwd).toBe("/repo/configs/tmux");
    expect(command.env).toEqual({
      LOADOUT_REPO: "/repo",
      LOADOUT_MACHINE: "m1",
      LOADOUT_OS: "macos",
      LOADOUT_CONFIGS: "/repo/configs",
      LOADOUT_FRAGMENT_DIR: "/repo/configs/tmux",
    });
  }
});

const savedPath = process.env["PATH"];
afterEach(() => {
  process.env["PATH"] = savedPath;
});

test("the bun folder goes first on PATH for every command of a child and its parent", async () => {
  process.env["PATH"] = "/usr/bin";
  const fake = newRunner().onCommand(fileLine("helper.sh", "")).onCommand(fileLine("mine.sh", ""));
  const system: SystemInfo = { machine: "work", os: "linux", arch: "x86_64" };
  const frame = frameOf("/child", system, undefined, "/parent", undefined, "/data/loadout/bin");

  await newScriptRunner(fake, frame).run(newScriptStep({ run: "file:helper.sh", origin: "parent:lib" }), false, "");
  await newScriptRunner(fake, frame).run(newScriptStep({ run: "file:mine.sh", origin: "scripts" }), false, "");
  for (const command of fake.received()) {
    expect(command.env?.["PATH"]).toBe("/data/loadout/bin:/usr/bin");
    expect(command.env?.[bunDirVar]).toBe("/data/loadout/bin");
  }
});

test("in a child a parent's script runs in the parent with the parent's repo and a child's in the child", async () => {
  const fake = newRunner().onCommand(fileLine("helper.sh", "")).onCommand(fileLine("mine.sh", ""));
  const system: SystemInfo = { machine: "work", os: "macos", arch: "arm64" };
  const frame = frameOf("/child", system, "configs", "/parent", "dots", "");

  await newScriptRunner(fake, frame).run(newScriptStep({ run: "file:helper.sh", origin: "parent:maintenance/lib" }), false, "");
  await newScriptRunner(fake, frame).run(newScriptStep({ run: "file:mine.sh", origin: "scripts" }), false, "");
  const [parents, childs] = fake.received();
  expect(parents!.cwd).toBe("/parent/maintenance/lib");
  expect(parents!.env).toEqual({
    LOADOUT_REPO: "/parent",
    LOADOUT_PARENT: "/parent",
    LOADOUT_MACHINE: "work",
    LOADOUT_OS: "macos",
    LOADOUT_CONFIGS: "/parent/dots",
    LOADOUT_FRAGMENT_DIR: "/parent/maintenance/lib",
  });
  expect(childs!.cwd).toBe("/child/scripts");
  expect(childs!.env?.["LOADOUT_REPO"]).toBe("/child");
  expect(childs!.env?.["LOADOUT_PARENT"]).toBe("/parent");
  expect(childs!.env?.["LOADOUT_CONFIGS"]).toBe("/child/configs");
});

test("a root-declared script runs in the repo root", async () => {
  const fake = newRunner().onCommand("true");
  await runScript(fake, newScriptStep({ run: "true" }), false, "");
  expect(fake.received()[0]!.cwd).toBe("/repo");
});

test("records failure", async () => {
  const fake = newRunner().onCommand("false", exit(1));
  const outcome = await runScript(fake, newScriptStep({ run: "false" }), false, "");
  expect(outcome.state?.status).toBe("failed");
  expect(outcome.state?.exitCode).toBe(1);
  expect(outcome.state?.lastRun).toBeDefined();
});
