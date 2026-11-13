import { expect, test } from "bun:test";
import type { ProgramState } from "../coremodel/coremodel.ts";
import { custom, example, manifestOf, pm, variants, via } from "../coretest/coretest.ts";
import { exit, newRunner, type Runner, stdout } from "../exec/fakeexec/fakeexec.ts";
import { checkFor, fileLine, forMachine, type Manifest, newInstallVariant, sortStrings, toolPathOf } from "../../model/index.ts";
import { ResolutionException } from "./errors.ts";
import {
  type InstallEngine,
  type InstallItem,
  type InstallOutcome,
  installs,
  newInstallEngine,
  outcomeSuccess,
  type PlanItem,
} from "./installengine.ts";
import { contains, refused, repoFrame } from "./testhelpers.ts";
import { newVersionChecker } from "./versionchecker.ts";

type cs = ProgramState;

function installEngine(runner?: Runner): InstallEngine {
  const r = runner ?? newRunner();
  return newInstallEngine(r, newVersionChecker(r, repoFrame), repoFrame);
}

const yes = () => true;
const no = () => false;

function states(...entries: [string, cs][]): Map<string, cs> {
  return new Map(entries);
}

function installed(v: string): cs {
  return { status: "installed", version: v };
}

function plan(
  m: Manifest,
  machine: string,
  requested: string[] | undefined,
  current: Map<string, cs>,
  available: (b: string) => boolean,
): Promise<PlanItem[]> {
  return installEngine().plan(m, machine, requested, current, available);
}

function planRefusal(
  m: Manifest,
  machine: string,
  requested: string[] | undefined,
  current: Map<string, cs>,
  available: (b: string) => boolean,
): Promise<string> {
  return refused(ResolutionException, () => installEngine().plan(m, machine, requested, current, available));
}

function programsOf(items: readonly PlanItem[]): string[] {
  return items.map((item) => item.program);
}

function versionOf(state: cs | undefined): string {
  return state?.version ?? "<nil>";
}

function install(item: Partial<InstallItem> & { program: string; installKey: string; command: string }): InstallItem {
  return { kind: "install", origin: "", sudo: false, ...item };
}

test("plan uses machine mapping skips installed and expands deps", async () => {
  const current = states(["git", installed("2.46.0")], ["ripgrep", { status: "missing" }]);
  const got = await plan(example(), "laptop", ["ripgrep"], current, yes);
  // ripgrep depends on git: git first (already installed), then ripgrep via laptop's dnf mapping.
  expect(got).toEqual([
    { kind: "installed", program: "git", version: "2.46.0" },
    install({ program: "ripgrep", installKey: "dnf", command: "sudo dnf install -y ripgrep", sudo: true }),
  ]);
});

test("plan picks different keys per machine", async () => {
  const m = example();
  const laptop = await plan(m, "laptop", ["git"], new Map(), yes);
  const macbook = await plan(m, "macbook", ["git"], new Map(), yes);
  expect((laptop[0] as InstallItem).command).toBe("sudo dnf install -y git");
  expect((macbook[0] as InstallItem).command).toBe("brew install git");
});

test("plan resolves custom script keys", async () => {
  const got = await plan(example(), "laptop", ["rustup"], new Map(), yes);
  expect(got).toEqual([install({ program: "rustup", installKey: "script", command: "curl -sSf https://sh.rustup.rs | sh -s -- -y" })]);
});

test("a variant's dependencies only come with that variant", async () => {
  // kitty from a COPR needs dnf-plugins-core first; kitty from pacman
  // needs nothing — and must not drag a dnf package into the plan.
  const m = manifestOf((b) => {
    b.program("dnf-plugins-core", { install: variants(["dnf", newInstallVariant({ command: "dnf install dnf-plugins-core" })]) });
    b.program("kitty", {
      install: variants(
        ["copr", newInstallVariant({ command: "dnf copr enable kitty", dependsOn: ["dnf-plugins-core"] })],
        ["pacman", newInstallVariant({ command: "pacman -S kitty" })],
      ),
    });
    b.machine("fedora", { pm: pm("kitty", "copr", "dnf-plugins-core", "dnf") });
    b.machine("arch", { pm: pm("kitty", "pacman") });
  });
  expect(programsOf(await plan(m, "fedora", ["kitty"], new Map(), yes))).toEqual(["dnf-plugins-core", "kitty"]);
  expect(programsOf(await plan(m, "arch", ["kitty"], new Map(), yes))).toEqual(["kitty"]);
});

function sudoOf(items: readonly PlanItem[]): Record<string, boolean> {
  return Object.fromEntries(installs(items).map((item) => [item.program, item.sudo]));
}

test("sudo declarations reach the plan", async () => {
  // `sudo` on an installer marks its installs; a variant's replaces it.
  const m = manifestOf((b) => {
    b.installer("omarchy-pkg", { install: "omarchy pkg add {pkg}", sudo: true });
    b.program("zsh", { install: via("omarchy-pkg") });
    b.program("plain", { install: custom("custom", "true") });
    b.machine("m", { pm: pm("zsh", "omarchy-pkg", "plain", "custom") });
  });
  expect(sudoOf(await plan(m, "m", ["zsh", "plain"], new Map(), yes))).toEqual({ zsh: true, plain: false });
});

function oneTool(command: string): Manifest {
  return manifestOf((b) => {
    b.program("tool", { install: custom("script", command) });
    b.machine("m", { pm: pm("tool", "script") });
  });
}

test("file install values run as repo scripts", async () => {
  const got = await plan(oneTool("file:scripts/install-tool.sh"), "m", undefined, new Map(), yes);
  expect(got).toEqual([install({ program: "tool", installKey: "script", command: fileLine("scripts/install-tool.sh", "") })]);
});

test("file install values pass arguments through", async () => {
  const got = await plan(oneTool("file:scripts/tool.sh install --verbose"), "m", undefined, new Map(), yes);
  expect(got).toEqual([install({ program: "tool", installKey: "script", command: fileLine("scripts/tool.sh", "install --verbose") })]);
});

test("a program's path comes first on the install command's PATH", async () => {
  const m = manifestOf((b) => {
    b.program("tool", { path: ["$HOME/.local/bin"], install: custom("custom", "file:install.sh") });
    b.machine("m", { pm: pm("tool", "custom") });
  });
  const item = (await plan(m, "m", undefined, new Map(), yes))[0] as InstallItem;
  expect(item.command).toBe(`PATH="\${LOADOUT_BUN_DIR:+$LOADOUT_BUN_DIR:}$HOME/.local/bin:$PATH"; export PATH; ` + fileLine("install.sh", ""));
});

test("an installer's requirement is planned first", async () => {
  const m = manifestOf((b) => {
    b.program("setup-brew", { install: custom("custom", "setup") });
    b.installer("brew", { install: "brew install {pkg}" });
    b.requires("brew", "setup-brew");
    b.program("jq", { install: via("brew") });
    b.machine("m", { pm: pm("setup-brew", "custom", "jq", "brew") });
    b.machine("bare", { pm: pm("jq", "brew") });
  });
  expect(programsOf(await plan(m, "m", ["jq"], new Map(), yes))).toEqual(["setup-brew", "jq"]);

  // The requirement is a dependency: a machine that doesn't install it can't install jq.
  contains(await planRefusal(m, "bare", undefined, new Map(), yes), "'setup-brew' is required as a dependency");
});

test("ties break by name", async () => {
  const m = manifestOf((b) => {
    b.program("zeta", { install: custom("custom", "z") });
    b.program("alpha", { install: custom("custom", "a") });
    b.machine("m", { pm: pm("zeta", "custom", "alpha", "custom") });
  });
  expect(programsOf(await plan(m, "m", ["zeta", "alpha"], new Map(), yes))).toEqual(["alpha", "zeta"]);
});

test("empty request plans everything", async () => {
  const got = programsOf(await plan(example(), "laptop", undefined, new Map(), yes));
  expect(sortStrings(got)).toEqual(["git", "ripgrep", "rustup"]);
});

test("fails when machine is not declared", async () => {
  contains(await planRefusal(example(), "unknown-box", undefined, new Map(), yes), "machine 'unknown-box' is not declared in the repo");
});

test("converge skips unmapped programs", async () => {
  const partial = manifestOf((b) => {
    b.program("a", { install: variants(["dnf", newInstallVariant({ command: "sudo dnf install -y a" })]) });
    b.program("b", { install: variants(["dnf", newInstallVariant({ command: "sudo dnf install -y b" })]) });
    b.machine("m", { pm: pm("a", "dnf") });
  });
  // b is not part of m's loadout: converge plans only a, no error.
  expect(programsOf(await plan(partial, "m", undefined, new Map(), yes))).toEqual(["a"]);
  // ...but explicitly requesting it is an error.
  contains(await planRefusal(partial, "m", ["b"], new Map(), yes), "program 'b' isn't installed on machine 'm'");
});

test("unmapped dependency of mapped program fails", async () => {
  const partial = manifestOf((b) => {
    b.program("base", { install: variants(["dnf", newInstallVariant({ command: "sudo dnf install -y base" })]) });
    b.program("tool", {
      dependsOn: ["base"],
      install: variants(["dnf", newInstallVariant({ command: "sudo dnf install -y tool" })]),
    });
    b.machine("m", { pm: pm("tool", "dnf") });
  });
  contains(await planRefusal(partial, "m", undefined, new Map(), yes), "required as a dependency", "'base'");
});

test("fails when mapped pm is not installed", async () => {
  contains(await planRefusal(example(), "laptop", ["ripgrep"], new Map(), no), "required binary 'dnf'", "not installed on machine 'laptop'");
});

test("probe provided by an earlier program in the plan", async () => {
  const pkg = { probe: "pkg", install: "pkg add {pkg}", check: "pkg info {pkg}" };
  const m = manifestOf((b) => {
    b.installer("pkg", pkg);
    b.installer("flat", { probe: "flat", install: "flat install {pkg}", check: "flat info {pkg}" });
    b.program("flat-runtime", { install: variants(["pkg", newInstallVariant({ provides: [{ binary: "flat" }] })]) });
    b.requires("flat", "flat-runtime");
    b.program("app", { install: via("flat") });
    b.machine("m", { pm: pm("flat-runtime", "pkg", "app", "flat") });
  });
  const onlyPkg = (b: string) => b === "pkg";

  // flat is missing, but flat-runtime installs it first.
  expect(programsOf(await plan(m, "m", ["app"], new Map(), onlyPkg))).toEqual(["flat-runtime", "app"]);

  // Already installed and still no binary: nothing in the plan provides it.
  contains(
    await planRefusal(m, "m", ["app"], states(["flat-runtime", installed("1.0")]), onlyPkg),
    "required binary 'flat' (needed to install app) is not installed",
  );

  // A provider later in the plan doesn't count, and the error says how to order it.
  const m2 = manifestOf((b) => {
    b.installer("pkg", pkg);
    b.program("first", { install: variants(["pkg", newInstallVariant({ probe: "flat" })]) });
    b.program("flat-runtime", {
      dependsOn: ["first"],
      install: variants(["pkg", newInstallVariant({ provides: [{ binary: "flat" }] })]),
    });
    b.machine("m", { pm: pm("first", "pkg", "flat-runtime", "pkg") });
  });
  contains(
    await planRefusal(m2, "m", undefined, new Map(), onlyPkg),
    "comes from 'flat-runtime', which would install after them",
    "needed to install first)",
  );
});

test("a provided tool off PATH is found where it lands and runs from there", async () => {
  const m = forMachine(
    manifestOf((b) => {
      b.installer("pkg", { probe: "pkg", install: "pkg add {pkg}", check: "pkg info {pkg}" });
      b.installer("brewish", { probe: "brewish", install: "brewish install {pkg}", check: "brewish list {pkg}" });
      b.program("setup-brewish", {
        install: variants(
          ["linux", newInstallVariant({ command: "install-brewish", provides: [{ binary: "brewish", at: "/opt/brewish/bin" }] })],
          ["macos", newInstallVariant({ command: "install-brewish", provides: [{ binary: "brewish", at: "/opt/other/bin" }] })],
        ),
      });
      b.requires("brewish", "setup-brewish");
      b.program("tool", { install: via("brewish") });
      b.machine("m", { pm: pm("setup-brewish", "linux", "tool", "brewish") });
    }),
    "m",
  );

  // Only the mapped variant's folder counts.
  expect(m.toolPaths).toEqual(new Map([["brewish", ["/opt/brewish/bin"]]]));

  // Installed already, off PATH: found where it lands, and the install runs with it first on PATH.
  const current = states(["setup-brewish", { status: "installed" }]);
  const step = installs(await plan(m, "m", ["tool"], current, (b) => b === "/opt/brewish/bin/brewish"));
  expect(step.length).toBe(1);
  expect(step[0]!.command).toBe(`PATH="\${LOADOUT_BUN_DIR:+$LOADOUT_BUN_DIR:}/opt/brewish/bin:$PATH"; export PATH; brewish install tool`);

  // The check goes through it from there too.
  expect(checkFor(m, "tool", "brewish")?.path).toEqual(["/opt/brewish/bin"]);
  expect(toolPathOf(m, "brewish")).toEqual(["/opt/brewish/bin"]);
});

test("pm check skipped for installed programs and custom keys", async () => {
  // Everything installed -> no install items -> pm availability never consulted.
  const current = states(["git", installed("2.46.0")], ["ripgrep", installed("14.1.0")], ["rustup", installed("1.27.1")]);
  const got = await plan(example(), "laptop", undefined, current, () => {
    throw new Error("must not probe");
  });
  expect(installs(got).length).toBe(0);
  // Custom keys (script) are never probed either.
  const scriptOnly = await plan(example(), "laptop", ["rustup"], new Map(), no);
  expect(programsOf(installs(scriptOnly))).toEqual(["rustup"]);
});

test("installer mechanics resolve by mapped key", async () => {
  const m = manifestOf((b) => {
    b.installer("brew-cask", {
      probe: "brew",
      install: "brew install --cask {pkg}",
      check: "brew list --cask --versions {pkg}",
      regex: "([0-9.]+)",
    });
    b.program("toolbox", { install: variants(["brew-cask", newInstallVariant({ pkg: "toolbox-linux" })]) });
    b.machine("m", { pm: pm("toolbox", "brew-cask") });
  });
  // Probe: the variant inherits its installer's probe binary.
  const probed: string[] = [];
  await plan(m, "m", undefined, new Map(), (b) => {
    probed.push(b);
    return true;
  });
  expect(probed).toEqual(["brew"]);

  // Probe failure names the binary.
  contains(await planRefusal(m, "m", undefined, new Map(), no), "required binary 'brew'");

  // Post-install re-check uses the mapped key's check, not the default.
  const runner = newRunner()
    .onCommand("brew install --cask toolbox-linux")
    .onCommand("brew list --cask --versions toolbox-linux", stdout("toolbox-linux 3.5.0"));
  const p = await installEngine(runner).plan(m, "m", undefined, new Map(), yes);
  const outcomes = await installEngine(runner).execute(m, p);
  expect(outcomes.length).toBe(1);
  expect(outcomeSuccess(outcomes[0]!)).toBe(true);
  expect(versionOf(outcomes[0]!.stateAfter)).toBe("3.5.0");
});

test("execute runs installs and rechecks versions", async () => {
  const runner = newRunner().onCommand("sudo dnf install -y ripgrep").onCommand("rg --version", stdout("ripgrep 14.1.0"));
  const m = example();
  let p = await installEngine(runner).plan(m, "laptop", ["ripgrep"], new Map(), yes);
  let outcomes = await installEngine(runner).execute(m, p);

  expect(outcomes.map((o) => o.program)).toEqual(["git", "ripgrep"]);
  // git (ripgrep's dependency) fails (unregistered command), so ripgrep isn't tried.
  expect(outcomeSuccess(outcomes[0]!)).toBe(false);
  expect(outcomes[1]!.skippedFor).toBe("git");

  // With git already there, ripgrep installs and is checked again.
  p = await installEngine(runner).plan(m, "laptop", ["ripgrep"], states(["git", installed("2.46.0")]), yes);
  outcomes = await installEngine(runner).execute(m, p);
  expect(outcomes.length).toBe(1);
  expect(outcomeSuccess(outcomes[0]!)).toBe(true);
  expect(versionOf(outcomes[0]!.stateAfter)).toBe("14.1.0");
});

test("execute skips what a failed install was needed for", async () => {
  // a fails; b needs a, c needs b (so c is skipped for b, which never ran);
  // d needs nothing and still installs.
  const m = manifestOf((b) => {
    b.program("a", { install: custom("custom", "install-a") });
    b.program("b", { dependsOn: ["a"], install: custom("custom", "install-b") });
    b.program("c", { dependsOn: ["b"], install: custom("custom", "install-c") });
    b.program("d", { install: custom("custom", "install-d") });
    b.machine("m", { pm: pm("a", "custom", "b", "custom", "c", "custom", "d", "custom") });
  });
  const runner = newRunner().onCommand("install-a", exit(1)).onCommand("install-b").onCommand("install-c").onCommand("install-d");
  const p = await installEngine(runner).plan(m, "m", undefined, new Map(), yes);
  const skips: Record<string, string> = {};
  const outcomes = await installEngine(runner).execute(m, p, undefined, (item, dep) => {
    skips[item.program] = dep;
  });

  const got: Record<string, string> = {};
  for (const o of outcomes) {
    if (o.skippedFor !== "") got[o.program] = "skipped for " + o.skippedFor;
    else if (outcomeSuccess(o)) got[o.program] = "installed";
    else got[o.program] = "failed";
  }
  expect(got).toEqual({ a: "failed", b: "skipped for a", c: "skipped for b", d: "installed" });
  expect(skips).toEqual({ b: "a", c: "b" });
  for (const line of runner.executed()) {
    expect(line.includes("install-b") || line.includes("install-c")).toBe(false);
  }
  expect(runner.executed().some((line) => line.includes("install-d"))).toBe(true);
});

test("execute after skips what an earlier phase failed", async () => {
  // setup-new-machine's later phase: ripgrep's dependency git failed in the
  // core phase, so ripgrep isn't tried; with git done earlier, it is.
  const runner = newRunner().onCommand("sudo dnf install -y ripgrep").onCommand("rg --version", stdout("ripgrep 14.1.0"));
  const m = example();
  const p = await installEngine(runner).plan(m, "laptop", ["ripgrep"], states(["git", installed("2.46.0")]), yes);
  const failedGit: InstallOutcome[] = [{ program: "git", exitCode: 1, skippedFor: "" }];
  let outcomes = await installEngine(runner).executeAfter(m, p, failedGit);
  // only the new outcomes
  expect(outcomes.map((o) => o.program)).toEqual(["ripgrep"]);
  expect(outcomes[0]!.skippedFor).toBe("git");

  const ok: InstallOutcome[] = [{ program: "git", exitCode: 0, stateAfter: installed("2.46.0"), skippedFor: "" }];
  outcomes = await installEngine(runner).executeAfter(m, p, ok);
  expect(outcomes.length).toBe(1);
  expect(outcomeSuccess(outcomes[0]!)).toBe(true); // ripgrep after a good git
});
