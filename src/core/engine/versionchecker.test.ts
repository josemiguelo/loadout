import { expect, test } from "bun:test";
import type { ProgramState } from "../coremodel/coremodel.ts";
import { example, manifestOf, variants, version, via } from "../coretest/coretest.ts";
import { exit, newRunner, stderr, stdout } from "../exec/fakeexec/fakeexec.ts";
import { newCommandFrame, type ProcessRunner } from "../exec/index.ts";
import { checkFor, fileLine, mapValues, newInstallVariant, newVersionCheck, type VersionCheck } from "../../model/index.ts";
import { newVersionChecker } from "./versionchecker.ts";

const noFrame = newCommandFrame("", undefined, undefined);

const ripgrepCheck = version("rg --version", "ripgrep ([0-9][0-9a-zA-Z.-]*)");

function check(runner: ProcessRunner, vc: VersionCheck | undefined): Promise<ProgramState> {
  return newVersionChecker(runner, noFrame).check(vc);
}

function versionOf(state: ProgramState): string {
  return state.version ?? "<none>";
}

test("installed with version", async () => {
  const runner = newRunner().onCommand("rg --version", stdout("ripgrep 14.1.0\nfeatures: -simd128\n"));
  const state = await check(runner, ripgrepCheck);
  expect(state.status).toBe("installed");
  expect(versionOf(state)).toBe("14.1.0");
});

test("missing when command fails", async () => {
  // The check IS the program (no probe): command not found = not installed.
  expect((await check(newRunner(), ripgrepCheck)).status).toBe("missing");
});

test("a check through a tool that is not there is unknown not missing", async () => {
  // brew off PATH once reported every brew program missing. The check
  // asks THROUGH brew (probe set), so a 127 is brew's absence, not bat's.
  const viaBrew = newVersionCheck({ command: "brew list --versions bat", regex: "([0-9.]+)", probe: "brew" });
  const gone = await check(newRunner(), viaBrew);
  expect(gone.status).toBe("unknown");
  expect(gone.reason).toBe("sh: command not found");

  // brew present and saying no is a real missing, with what it said.
  const runner = newRunner().onCommand("brew list --versions bat", exit(1), stderr("Error: No such keg: bat"));
  const missing = await check(runner, viaBrew);
  expect(missing.status).toBe("missing");
  expect(missing.reason).toBe("Error: No such keg: bat");
});

test("resolved checks carry their installer's probe", () => {
  const manifest = manifestOf((b) => {
    b.installer("pm", { probe: "pm", install: "pm install {pkg}", check: "pm query {pkg}", regex: "([0-9.]+)" });
    b.program("bat", { install: via("pm") });
    b.program("rg", {
      version: version("rg --version", "([0-9.]+)"),
      install: variants(["pm", newInstallVariant({ check: "rg --version", regex: "([0-9.]+)" })]),
    });
  });
  // A check through the mechanism knows the tool it asks through...
  expect(checkFor(manifest, "bat", "pm")?.probe).toBe("pm");
  // ...even when the variant overrides the command: it's still asked
  // through the mechanism the variant is keyed by.
  expect(checkFor(manifest, "rg", "pm")?.probe).toBe("pm");
  // The program's own version carries none: it IS the program.
  expect(checkFor(manifest, "rg", undefined)?.probe).toBeUndefined();
});

test("installed without version when regex does not match", async () => {
  const state = await check(newRunner().onCommand("rg --version", stdout("something unexpected")), ripgrepCheck);
  expect(state.status).toBe("installed");
  expect(state.version).toBeUndefined();
});

test("unknown when no version check declared", async () => {
  expect((await check(newRunner(), undefined)).status).toBe("unknown");
});

test("file check commands run as repo scripts", async () => {
  const runner = newRunner().onCommand(fileLine("scripts/ver.sh", "check"), stdout("tool 2.0"));
  expect(versionOf(await check(runner, version("file:scripts/ver.sh check", "tool ([0-9.]+)")))).toBe("2.0");
});

test("reads version from stderr when stdout empty", async () => {
  const runner = newRunner().onCommand("rg --version", stderr("ripgrep 13.0.0"));
  expect(versionOf(await check(runner, ripgrepCheck))).toBe("13.0.0");
});

test("check all checks every program", async () => {
  const manifest = example();
  const runner = newRunner()
    .onCommand("git --version", stdout("git version 2.46.0"))
    .onCommand("rg --version", stdout("ripgrep 14.1.0"));
  // rustup unregistered -> exit 127 -> missing
  const checks = mapValues(manifest.programs, (_, p) => p.version);
  const results = await newVersionChecker(runner, noFrame).checkAll(checks);
  expect(results.get("git")!.status).toBe("installed");
  expect(versionOf(results.get("git")!)).toBe("2.46.0");
  expect(results.get("ripgrep")!.status).toBe("installed");
  expect(results.get("rustup")!.status).toBe("missing");
  // in the checks' order
  expect([...results.keys()]).toEqual(["git", "ripgrep", "rustup"]);
});

test("a yes/no check records installed with no version", async () => {
  const runner = newRunner().onCommand("test -f /etc/dnf/dnf.conf", stdout("anything 1.2.3"));
  const state = await check(runner, newVersionCheck({ command: "test -f /etc/dnf/dnf.conf" }));
  expect(state.status).toBe("installed");
  expect(state.version).toBeUndefined();
  // ...and a failing one is missing, as any check.
  expect((await check(newRunner(), newVersionCheck({ command: "test -f /nope" }))).status).toBe("missing");
});

test("a program's path comes first for its check", async () => {
  const runner = newRunner().onCommand(
    `PATH="\${LOADOUT_BUN_DIR:+$LOADOUT_BUN_DIR:}$HOME/.local/bin:$PATH"; export PATH; ngrok version`,
    stdout("ngrok version 3.4.0"),
  );
  const vc = newVersionCheck({ command: "ngrok version", regex: "([0-9.]+)", path: ["$HOME/.local/bin"] });
  expect(versionOf(await check(runner, vc))).toBe("3.4.0");
});
