import { expect, test } from "bun:test";
import { exit, newRunner, stderr } from "../exec/fakeexec/fakeexec.ts";
import { newGitClient } from "./git.ts";

test("a failed git command says what git said", async () => {
  const runner = newRunner().onCommand("git pull --rebase --autostash", exit(1), stderr("fatal: no remote\n"));
  await expect(newGitClient(runner, "/repo").pullRebase()).rejects.toThrow(/^git pull failed \(exit 1\): fatal: no remote$/);
  expect(runner.received()[0]!.cwd).toBe("/repo");
});

test("a commit stages each path and skips when nothing changed", async () => {
  let runner = newRunner().onCommand("git add 'state/m.json'").onCommand("git diff --cached --quiet");
  expect(await newGitClient(runner, "/repo").addCommit(["state/m.json"], "x")).toBe(false);
  runner = newRunner()
    .onCommand("git add 'state/m.json'")
    .onCommand("git diff --cached --quiet", exit(1))
    .onCommand(`git commit -m 'loadout: m'\\''s state'`);
  expect(await newGitClient(runner, "/repo").addCommit(["state/m.json"], "loadout: m's state")).toBe(true);
  expect(runner.executed()).toContain(`git commit -m 'loadout: m'\\''s state'`);
});
