import { expect, test } from "bun:test";
import { manifestOf, pm, variants, via } from "../coretest/coretest.ts";
import { forMachine, type Manifest, newInstallVariant, shownLine } from "../../model/index.ts";
import { UpgradeException } from "./errors.ts";
import { contains, refused } from "./testhelpers.ts";
import { planSourceItems, planUpgrade, stepLabel, upgradableInstallers } from "./upgradeengine.ts";

function upgradeManifest(): Manifest {
  return manifestOf((b) => {
    b.installer("pm", { install: "install {pkg}", upgrade: "pm upgrade -y", check: "pm show {pkg}", regex: "([0-9.]+)" });
    b.installer("rolling", { install: "roll {pkg}", upgrade: "roll -Syu", check: "roll -Q {pkg}", regex: "([0-9.]+)" });
    b.installer("manual", { install: "by hand {pkg}", check: "true", regex: "([0-9.]+)" });
    b.program("alpha", { install: via("pm") });
    b.program("bravo", { install: via("pm") });
    b.program("charlie", { install: via("rolling") });
    b.program("delta", { install: via("manual") });
    b.machine("m1", { pm: pm("alpha", "pm", "bravo", "pm", "charlie", "rolling", "delta", "manual") });
    b.machine("m2", { pm: pm("delta", "manual") });
  });
}

function upgradeRefusal(m: Manifest, machine: string, ...installers: string[]): Promise<string> {
  return refused(UpgradeException, () => planUpgrade(m, machine, installers));
}

test("an upgrade is always the whole mechanism", () => {
  // Two programs from one installer, one command — and the command is the
  // mechanism's own sweep, not a package list.
  const plan = planUpgrade(upgradeManifest(), "m1", ["pm"]);
  expect(plan.length).toBe(1);
  expect(plan[0]!.command).toBe("pm upgrade -y");
  expect(plan[0]!.covers).toEqual(["alpha", "bravo"]);
});

test("a provided tool's folder leads and one plain command from two files runs once", () => {
  const m = forMachine(
    manifestOf((b) => {
      b.installer("brewish", { probe: "brewish", install: "brewish install {pkg}", upgrade: "brewish upgrade", check: "brewish list {pkg}" });
      b.installer("brewish-tap", {
        probe: "brewish",
        install: "brewish install tap/{pkg}",
        upgrade: "brewish upgrade",
        check: "brewish list {pkg}",
        origin: "programs/brewish",
      });
      b.program("setup-brewish", {
        install: variants([
          "custom",
          newInstallVariant({ command: "install-brewish", provides: [{ binary: "brewish", at: "/opt/brewish/bin" }] }),
        ]),
      });
      b.program("alpha", { install: via("brewish") });
      b.program("bravo", { install: via("brewish-tap") });
      b.machine("m", { pm: pm("setup-brewish", "custom", "alpha", "brewish", "bravo", "brewish-tap") });
    }),
    "m",
  );
  const plan = planUpgrade(m, "m", ["brewish", "brewish-tap"]);
  expect(plan.length).toBe(1);
  expect(plan[0]!.installers).toEqual(["brewish", "brewish-tap"]);
  expect(plan[0]!.command).toBe(`PATH="\${LOADOUT_BUN_DIR:+$LOADOUT_BUN_DIR:}/opt/brewish/bin:$PATH"; export PATH; brewish upgrade`);
  expect(shownLine(plan[0]!.command)).toBe(`PATH="/opt/brewish/bin:$PATH"; export PATH; brewish upgrade`);
  expect(stepLabel(plan[0]!)).toBe("brewish");
});

test("naming a program points at its mechanism", async () => {
  contains(await upgradeRefusal(upgradeManifest(), "m1", "alpha"), "upgrades are whole-mechanism");
});

test("a mechanism this machine does not use is refused", async () => {
  // The safety property: `upgrade` can only run mechanisms this machine's
  // mapping actually installs through. Without it a repo that maps
  // nothing to brew could still run the real `brew upgrade`.
  contains(await upgradeRefusal(upgradeManifest(), "m2", "pm"), "not used by machine 'm2'");
});

test("an installer with no upgrade command is an error", async () => {
  contains(await upgradeRefusal(upgradeManifest(), "m1", "manual"), "declares no upgrade command");
});

test("only mechanisms this machine actually uses are offered", () => {
  const available = upgradableInstallers(upgradeManifest(), "m1");
  expect([...available.keys()]).toEqual(["pm", "rolling"]); // manual declares no upgrade
  expect(available.get("pm")).toEqual(["alpha", "bravo"]);
});

test("a custom source upgrades its items one at a time", () => {
  const m = manifestOf((b) => b.outdated("pins", { command: "list-pins", upgrade: "repin {item}" }));
  const plan = planSourceItems(m, "pins", ["golang", "nodejs"]);
  expect(plan.map((step) => step.command)).toEqual(["repin golang", "repin nodejs"]);
  expect(plan.map((step) => step.covers)).toEqual([["golang"], ["nodejs"]]);
  expect(stepLabel(plan[0]!)).toBe("pins: golang");
});

test("sudo declarations plan as usual", () => {
  const m = manifestOf((b) => {
    b.installer("omarchy-pkg", {
      install: "omarchy pkg add {pkg}",
      upgrade: "omarchy update -y",
      check: "pacman -Q {pkg}",
      regex: "([0-9.]+)",
      sudo: true,
    });
    b.program("zsh", { install: via("omarchy-pkg") });
    b.machine("m", { pm: pm("zsh", "omarchy-pkg") });
    b.outdated("pins", { command: "list-pins", upgrade: "repin {item}", sudo: true });
    b.outdated("plain", { command: "list", upgrade: "bump {item}" });
  });
  const step = planUpgrade(m, "m", ["omarchy-pkg"])[0]!;
  expect(step.command).toBe("omarchy update -y");
  expect(step.sudo).toBe(true);
  const pins = planSourceItems(m, "pins", ["golang"]);
  expect(pins[0]!.command).toBe("repin golang");
  expect(pins[0]!.sudo).toBe(true);
});

test("a source with no upgrade command is refused", async () => {
  const m = manifestOf((b) => b.outdated("pins", { command: "list-pins" }));
  contains(await refused(UpgradeException, () => planSourceItems(m, "pins", ["golang"])), "declares no upgrade command");
});
