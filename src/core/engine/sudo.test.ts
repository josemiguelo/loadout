import { expect, test } from "bun:test";
import { manifestOf, pm, variants, via } from "../coretest/coretest.ts";
import { newRunner } from "../exec/fakeexec/fakeexec.ts";
import { type Manifest, newInstallVariant, newScriptStep, type ScriptStep } from "../../model/index.ts";
import { installs, newInstallEngine } from "./installengine.ts";
import { newScriptRunner } from "./scriptrunner.ts";
import { commandNeedsSudo } from "./sudo.ts";
import { repoFrame } from "./testhelpers.ts";
import { planUpgrade } from "./upgradeengine.ts";
import { newVersionChecker } from "./versionchecker.ts";

// Which steps need sudo's password: what makes a run ask for it upfront.

test("a command needs sudo only when it runs sudo", () => {
  const cases: Record<string, boolean> = {
    "sudo pacman -S --noconfirm kitty": true,
    "cd /tmp && sudo -E make install": true,
    "x=1; sudo tee /etc/x.conf": true,
    "script -q pseudo-tty": false,
    "sudoku --solve": false,
    "omarchy pkg add kitty": false,
    "sh 'setup.sh' install": false,
  };
  for (const [command, want] of Object.entries(cases)) expect([command, commandNeedsSudo(command)]).toEqual([command, want]);
});

function sudoManifest(): Manifest {
  return manifestOf((b) => {
    b.installer("sneaky", { install: "helper add {pkg}", upgrade: "helper update", sudo: true });
    b.installer("plain", { install: "plain add {pkg}", upgrade: "plain update" });
    b.program("visible", { install: variants(["pacman", newInstallVariant({ command: "sudo pacman -S visible" })]) });
    b.program("declared", { install: via("sneaky") });
    b.program("opted-out", { install: variants(["sneaky", newInstallVariant({ sudo: false })]) });
    b.program("own-script", { install: variants(["plain", newInstallVariant({ command: "sh setup.sh", sudo: true })]) });
    b.program("none", { install: via("plain") });
    b.machine("m", { pm: pm("visible", "pacman", "declared", "sneaky", "opted-out", "sneaky", "own-script", "plain", "none", "plain") });
  });
}

test("an install needs sudo when its command runs it or its variant or installer says so", async () => {
  const runner = newRunner();
  const plan = await newInstallEngine(runner, newVersionChecker(runner, repoFrame), repoFrame).plan(
    sudoManifest(),
    "m",
    ["visible", "declared", "opted-out", "own-script", "none"],
    new Map(),
    () => true,
  );
  const sudo = Object.fromEntries(installs(plan).map((item) => [item.program, item.sudo]));
  expect(sudo).toEqual({ visible: true, declared: true, "opted-out": false, "own-script": true, none: false });
});

test("an upgrade needs sudo when its installer says so", () => {
  const steps = planUpgrade(sudoManifest(), "m", ["sneaky", "plain"]);
  const sudo = Object.fromEntries(steps.map((step) => [step.command, step.sudo]));
  expect(sudo).toEqual({ "helper update": true, "plain update": false });
});

test("a script needs sudo when it says so or its command runs it", () => {
  const runner = newScriptRunner(newRunner(), repoFrame);
  const cases: [ScriptStep, boolean][] = [
    [newScriptStep({ file: "x.sh", sudo: true }), true],
    [newScriptStep({ run: "sudo systemctl enable --now x" }), true],
    [newScriptStep({ file: "x.sh" }), false],
    [newScriptStep({ run: "systemctl --user enable x" }), false],
  ];
  for (const [step, want] of cases) expect([step, runner.needsSudo(step, "")]).toEqual([step, want]);
});

test("a script is pending unless its check passes", async () => {
  const fake = newRunner().onCommand("test -f done");
  const runner = newScriptRunner(fake, repoFrame);
  const pending = (step: ScriptStep, force: boolean) => runner.pending(step, force, "");
  expect(await pending(newScriptStep({ file: "x.sh", check: "test -f done" }), false)).toBe(false); // a passing check is not pending
  expect(await pending(newScriptStep({ file: "x.sh", check: "test -f done" }), true)).toBe(true); // force is pending
  expect(await pending(newScriptStep({ file: "x.sh", check: "test -f missing" }), false)).toBe(true); // a failing check is pending
  expect(await pending(newScriptStep({ file: "x.sh" }), false)).toBe(true); // no check is pending
});
