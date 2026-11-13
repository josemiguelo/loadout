import { expect, test } from "bun:test";
import { newRunner, stdout } from "../exec/fakeexec/fakeexec.ts";
import type { ProcessRunner } from "../exec/index.ts";
import { type Part, partPrograms, partScripts, newStatusEngine } from "./statusengine.ts";
import { laptop, repoFrame, statusManifest } from "./testhelpers.ts";
import { newVersionChecker } from "./versionchecker.ts";

/** gated holds every command containing match until open is called. */
function gated(inner: ProcessRunner, match: string): { runner: ProcessRunner; open: () => void } {
  const gate = Promise.withResolvers<void>();
  return {
    runner: {
      async capture(c) {
        if (c.line.includes(match)) await gate.promise;
        return inner.capture(c);
      },
      inherit: (c) => inner.inherit(c),
    },
    open: () => gate.resolve(),
  };
}

test("each part lands on its own without waiting for the others", async () => {
  const inner = newRunner().onCommand("git --version", stdout("git version 2.55.0")).onCommand("test -d $HOME/.dotfiles");
  const { runner, open } = gated(inner, "test -d");
  const engine = newStatusEngine(newVersionChecker(runner, repoFrame), runner, repoFrame, undefined);

  const parts: Part[] = [];
  const programsIn = Promise.withResolvers<void>();
  const done = engine.refreshParts(statusManifest(), laptop, undefined, new Map(), (p) => {
    parts.push(p);
    if (p.kind === partPrograms) programsIn.resolve();
  });

  // The scripts' check is held: programs must land anyway.
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("programs waited for the scripts")), 5000);
  });
  await Promise.race([programsIn.promise, timeout]);
  clearTimeout(timer);
  expect(parts.length).toBe(1);
  expect(parts[0]!.kind).toBe(partPrograms);
  expect(parts[0]!.programs.has("git")).toBe(true);

  open();
  const state = await done;
  expect(parts.length).toBe(2); // programs and scripts, once each (no configs here)
  expect(parts[1]!.kind).toBe(partScripts);
  expect(parts[1]!.scripts.get("dotfiles")!.status).toBe("done");
  expect(state.scripts.get("dotfiles")!.status).toBe("done"); // the whole observation is still returned
});
