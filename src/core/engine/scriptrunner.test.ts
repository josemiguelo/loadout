import { afterEach, expect, test } from "bun:test";
import type { SystemInfo } from "../coremodel/coremodel.ts";
import { exit, newRunner, type Runner } from "../exec/fakeexec/fakeexec.ts";
import { frameOf } from "../exec/index.ts";
import { bunDirVar, fileLine, mapOf, newScriptStep, type ScriptStep, scriptVariant } from "../../model/index.ts";
import { newScriptRunner, type ScriptOutcome } from "./scriptrunner.ts";
import { repoFrame } from "./testhelpers.ts";

function runScript(fake: Runner, step: ScriptStep, force: boolean, args: string): Promise<ScriptOutcome> {
  return newScriptRunner(fake, repoFrame).run(step, force, args);
}

test("skips when check passes", async () => {
  const fake = newRunner().onCommand("test -d $HOME/.dotfiles");
  expect((await runScript(fake, newScriptStep({ file: "x.sh", check: "test -d $HOME/.dotfiles" }), false, "")).alreadyDone).toBe(true);
});

test("file check expands to sh and keeps args", async () => {
  const fake = newRunner().onCommand("set -- fedora; " + fileLine("scripts/x.sh", "check"));
  const step = newScriptStep({ file: "scripts/x.sh", check: "file:scripts/x.sh check" });
  expect((await runScript(fake, step, false, "fedora")).alreadyDone).toBe(true);
});

test("force ignores check", async () => {
  const fake = newRunner().onCommand("test -d $HOME/.dotfiles").onCommand("echo hi");
  const outcome = await runScript(fake, newScriptStep({ run: "echo hi", check: "test -d $HOME/.dotfiles" }), true, "");
  expect(outcome.alreadyDone).toBe(false);
  expect(outcome.state?.status).toBe("done");
});

test("runs script file through sh", async () => {
  const fake = newRunner().onCommand(fileLine("scripts/setup.sh", ""));
  const outcome = await runScript(fake, newScriptStep({ file: "scripts/setup.sh" }), false, "");
  expect(outcome.alreadyDone).toBe(false);
  expect(outcome.state?.status).toBe("done");
  expect(fake.executed()).toContain(fileLine("scripts/setup.sh", ""));
});

test("args reach file script and check", async () => {
  // Check receives args as positional params via `set --`; fails -> script runs.
  const fake = newRunner()
    .onCommand("set -- fedora; test -f $HOME/.ssh/$1", exit(1))
    .onCommand(fileLine("scripts/setup-ssh.sh", "fedora"));
  const outcome = await runScript(fake, newScriptStep({ file: "scripts/setup-ssh.sh", check: "test -f $HOME/.ssh/$1" }), false, "fedora");
  expect(outcome.alreadyDone).toBe(false);
  expect(fake.executed()).toContain(fileLine("scripts/setup-ssh.sh", "fedora"));
});

test("args check passing skips run", async () => {
  const fake = newRunner().onCommand("set -- fedora; test -f $HOME/.ssh/$1");
  const step = newScriptStep({ file: "scripts/setup-ssh.sh", check: "test -f $HOME/.ssh/$1" });
  expect((await runScript(fake, step, false, "fedora")).alreadyDone).toBe(true);
});

test("a script and its check run in the declaring directory with the loadout env", async () => {
  const fake = newRunner().onCommand(fileLine("plugins.sh", "check"), exit(1)).onCommand(fileLine("plugins.sh", ""));
  const system: SystemInfo = { machine: "m1", os: "macos", arch: "arm64" };
  const frame = frameOf("/repo", system, "configs", "", undefined, "");
  const step = newScriptStep({ file: "plugins.sh", check: "file:plugins.sh check", origin: "configs/tmux" });

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

  await newScriptRunner(fake, frame).run(newScriptStep({ file: "helper.sh", origin: "parent:lib" }), false, "");
  await newScriptRunner(fake, frame).run(newScriptStep({ file: "mine.sh", origin: "scripts" }), false, "");
  for (const command of fake.received()) {
    expect(command.env?.["PATH"]).toBe("/data/loadout/bin:/usr/bin");
    expect(command.env?.[bunDirVar]).toBe("/data/loadout/bin");
  }
});

test("in a child a parent's script runs in the parent with the parent's repo and a child's in the child", async () => {
  const fake = newRunner().onCommand(fileLine("helper.sh", "")).onCommand(fileLine("mine.sh", ""));
  const system: SystemInfo = { machine: "work", os: "macos", arch: "arm64" };
  const frame = frameOf("/child", system, "configs", "/parent", "dots", "");

  await newScriptRunner(fake, frame).run(newScriptStep({ file: "helper.sh", origin: "parent:maintenance/lib" }), false, "");
  await newScriptRunner(fake, frame).run(newScriptStep({ file: "mine.sh", origin: "scripts" }), false, "");
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

test("a two-mode check's arguments are forwarded", async () => {
  // A managing script's check is `file:x.sh check "$@"`: the machine's
  // arguments, set as positional params, reach the check mode.
  const fake = newRunner().onCommand("set -- id_ed25519; " + fileLine("x.sh", `check "$@"`));
  expect((await runScript(fake, newScriptStep({ file: "x.sh", check: `file:x.sh check "$@"` }), false, "id_ed25519")).alreadyDone).toBe(true);
});

test("a variant runs its own file and check", async () => {
  const fake = newRunner().onCommand(fileLine("arch.sh", "check"), exit(1)).onCommand(fileLine("arch.sh", ""));
  const step = scriptVariant(
    newScriptStep({
      description: "keyboard",
      sudo: true,
      variants: mapOf(
        ["arch", newScriptStep({ file: "arch.sh", check: "file:arch.sh check" })],
        ["fedora", newScriptStep({ file: "fedora.sh", check: "file:fedora.sh check" })],
      ),
    }),
    "arch",
  );
  expect((await runScript(fake, step, false, "")).alreadyDone).toBe(false);
  expect(fake.executed()).toEqual([fileLine("arch.sh", "check"), fileLine("arch.sh", "")]);
  expect(step.sudo).toBe(true);
});
