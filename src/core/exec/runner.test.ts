import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { takeInterrupt, trapInterrupts } from "../platform/platform.ts";
import { InterruptedByUser, line, success } from "./exec.ts";
import { newCommandFrame } from "./frame.ts";
import { newShellRunner } from "./runner.ts";

// The real runner: `sh -c`, the frame's cwd and env, a signal's -1.

test("the shell runs the line in its directory with its variables", async () => {
  const dir = realpathSync(mkdtempSync(tmpdir() + "/loadout-exec-"));
  const r = await newShellRunner().capture({ line: `pwd -P; echo "$LOADOUT_X"; echo oops >&2; exit 3`, cwd: dir, env: { LOADOUT_X: "x" } });
  expect(r).toEqual({ exitCode: 3, stdout: dir + "\nx\n", stderr: "oops\n" });
});

test("a child killed by a signal reports minus one", async () => {
  const r = await newShellRunner().capture(line("kill -TERM $$", ""));
  expect(r.exitCode).toBe(-1);
  expect(await newShellRunner().inherit(line("kill -TERM $$", ""))).toBe(-1);
});

test("a missing directory is a failure not a crash", async () => {
  const r = await newShellRunner().capture({ line: "true", cwd: "/nonexistent/loadout" });
  expect(success(r)).toBe(false);
  expect(r.stderr).toBe("chdir /nonexistent/loadout: no such file or directory");
});

test("a frame runs a parent's declaration in the parent", () => {
  const bare = newCommandFrame("", undefined, undefined).command("x", "programs");
  expect(bare.cwd).toBe("");
  expect(Object.keys(bare.env ?? {}).length).toBe(0);
  const frame = newCommandFrame("/child", { A: "child" }, { root: "/parent", env: { A: "parent" } });
  const p = frame.command("x", "parent:");
  expect([p.cwd, p.env?.["A"], p.env?.["LOADOUT_FRAGMENT_DIR"]]).toEqual(["/parent", "parent", "/parent"]);
  const c = frame.command("x", "lib");
  expect([c.cwd, c.env?.["A"]]).toEqual(["/child/lib", "child"]);
});

test("Ctrl-C during a hand-off stops the command too", async () => {
  trapInterrupts(true);
  try {
    // The terminal's Ctrl-C reaches loadout and its child alike.
    await expect(newShellRunner().inherit(line("kill -INT $PPID; kill -INT $$", ""))).rejects.toBeInstanceOf(InterruptedByUser);
    expect(takeInterrupt()).toBe(false);
  } finally {
    trapInterrupts(false);
  }
});
