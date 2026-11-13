// The port's own tests for what Go left to the integration suite: the
// converge pipeline's plan table and tallies, and sync's summary line.

import { expect, test } from "bun:test";
import { newMachineState } from "../core/coremodel/coremodel.ts";
import { echoSections, installFailures } from "./converge.ts";
import { streams } from "./spinner.ts";
import { leftToDo } from "./sync.ts";

function capture(f: () => void): string {
  let b = "";
  const saved = streams.stdout;
  streams.stdout = { write: (t) => void (b += t) };
  try {
    f();
  } finally {
    streams.stdout = saved;
  }
  return b;
}

test("the plan is one table across sections, an empty section left out", () => {
  const out = capture(() =>
    echoSections("m1", [
      {
        title: "",
        items: [
          { kind: "install", program: "ripgrep", installKey: "dnf", command: "sudo dnf install -y ripgrep", origin: "", sudo: true },
          { kind: "installed", program: "git", version: "2.46.0" },
          { kind: "installed", program: "jq" },
        ],
        extra: [{ name: "dotfiles-setup", label: "script" }],
      },
      { title: "Later, after everything above:", items: [], extra: [] },
    ]),
  );
  expect(out).toBe(
    "\nPlan for m1:\n" +
      "  + ripgrep         [dnf] sudo dnf install -y ripgrep\n" +
      "  = git             2.46.0\n" +
      "  = jq              installed\n" +
      "  ~ dotfiles-setup  script\n",
  );
});

test("install failures tell a failed install from a skipped one", () => {
  const { failed, skipped } = installFailures([
    { program: "ok", exitCode: 0, stateAfter: { status: "installed" }, skippedFor: "" },
    { program: "exit", exitCode: 1, stateAfter: { status: "missing" }, skippedFor: "" },
    { program: "still-missing", exitCode: 0, stateAfter: { status: "missing" }, skippedFor: "" },
    { program: "child", exitCode: -1, skippedFor: "exit" },
  ]);
  expect(failed).toEqual(["exit", "still-missing"]);
  expect(skipped).toEqual(["child (needs exit)"]);
});

test("sync's left to do counts missing programs and scripts not done, singular or plural", () => {
  expect(leftToDo(newMachineState())).toBe("");
  const state = newMachineState({
    programs: new Map([
      ["a", { status: "missing" }],
      ["b", { status: "installed" }],
    ]),
    scripts: new Map([
      ["s", { status: "pending" }],
      ["t", { status: "failed" }],
      ["u", { status: "done" }],
    ]),
  });
  expect(leftToDo(state)).toBe("1 program missing · 2 scripts not done");
});
