import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  dataLines,
  decodeLock,
  encodeLock,
  installerLibrary,
  installerLibraryNames,
  isSortedStrings,
  jsonEqual,
  jsonString,
  type JSONValue,
  floatNumber,
  type Lock,
  type MachineConfig,
  type Manifest,
  ManifestException,
  mapFS,
  mapOf,
  newInstaller,
  newInstallVariant,
  newMachineConfig,
  newManifest,
  newMeta,
  newOutdatedSource,
  newParentLayout,
  newProgram,
  newRepoLayout,
  newScriptStep,
  resolveInstall,
  runsIn,
  scriptArgs,
  type InstallVariant,
  type Installer,
  type Program,
  type ScriptStep,
} from "../model/index.ts";
import { contains, custom, data, fsWith, install, machine, pm, profile, programs, via } from "./testhelpers.ts";
import { assemble, assembleWithoutFiles, checkFiles, installOrder, type ManifestDraft, newManifestDraft, scriptOrder } from "./assemble.ts";

// What assemble makes of a repo's declarations: validation, profile
// flattening (contract 2), data, `file:` paths, the built-ins. Drafts are
// built by hand, as the front end would fill them (and as a lock could hold
// mistakes no front end writes).

function withState(d: ManifestDraft): ManifestDraft {
  if (d.manifest.layout.state !== "") return d;
  return { ...d, manifest: { ...d.manifest, layout: { ...d.manifest.layout, state: "state" } } };
}

function inRepo(d: ManifestDraft, ...files: string[]): Manifest {
  return assemble(withState(d), fsWith(...files), undefined);
}

function errorOf(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("assembled; wanted a refusal");
}

function refusal(d: ManifestDraft, ...files: string[]): string {
  const err = errorOf(() => assemble(withState(d), fsWith(...files), undefined));
  expect(err).toBeInstanceOf(ManifestException);
  return err.message;
}

/** draftRefusal is a draft no front end could write (unknown names, missing regexes), as a lock could hold one. */
function draftRefusal(manifest: Partial<Manifest>, ...profiles: [string, MachineConfig][]): string {
  const m = newManifest({ ...manifest, layout: newRepoLayout({ state: "state" }) });
  return errorOf(() => assembleWithoutFiles(newManifestDraft({ manifest: m, profiles: mapOf(...profiles) }))).message;
}

/** draft is a ManifestDraft of the manifest's fields given. */
function draft(m: Partial<Manifest>, rest: Partial<ManifestDraft> = {}): ManifestDraft {
  return newManifestDraft({ manifest: newManifest(m), ...rest });
}

const p = newProgram;
const v = newInstallVariant;
const step = newScriptStep;
const inst = newInstaller;

// ─── programs and installers ───────────────────────────────────────────

describe("programs and installers", () => {
  test("unknown names in a draft are named", () => {
    contains(
      draftRefusal({ programs: programs(["a", p({ install: custom("true"), dependsOn: ["nope"] })]) }),
      "programs.a depends-on unknown program 'nope'",
    );
    contains(
      draftRefusal({ programs: programs(["kitty", p({ install: install(["copr", v({ command: "x", dependsOn: ["dnf-plugins-core"] })]) })]) }),
      "programs.kitty.install.copr depends-on unknown program 'dnf-plugins-core'",
    );
    contains(
      draftRefusal({ programs: programs(["a", p({ install: install(["x", v({ installer: "phantom" })]) })]) }),
      "references unknown installer 'phantom'",
    );
    contains(
      draftRefusal({ machines: mapOf(["m", newMachineConfig({ pm: pm("ghost", "dnf") })]) }),
      "machine 'm' installs unknown program 'ghost'",
    );
    contains(draftRefusal({ machines: mapOf(["m", newMachineConfig({ scripts: ["ghost"] })]) }), "machine 'm' runs unknown script 'ghost'");
    contains(
      draftRefusal({ scripts: mapOf(["s", step({ run: "true", after: ["programs.ghost"] })]) }),
      "scripts.s after references unknown step 'programs.ghost'",
    );
    contains(
      draftRefusal({ installers: mapOf(["dnf", inst({ install: "x {pkg}", requires: ["ghost"] })]) }),
      "installers.dnf requires unknown program 'ghost'",
    );
  });

  test("a cycle only one variant walks is still a cycle", () => {
    const a = p({ dependsOn: ["b"], install: custom("a") });
    const b = p({ install: install(["custom", v({ command: "b" })], ["other", v({ command: "b2", dependsOn: ["a"] })]) });
    contains(draftRefusal({ programs: programs(["a", a], ["b", b]) }), "dependency cycle among programs: a -> b -> a");
  });

  test("an installer's requirements count toward cycles, but not its own", () => {
    const brew = inst({ install: "brew install {pkg}", requires: ["setup-brew"] });
    // setup-brew through brew is exempt from brew's own rule...
    assembleWithoutFiles(
      draft({
        layout: newRepoLayout({ state: "state" }),
        installers: mapOf(["brew", brew]),
        programs: programs(["setup-brew", p({ install: via("brew") })]),
      }),
    );
    // ...but needing a brew program closes a loop.
    const setup = p({ dependsOn: ["curl"], install: custom("x") });
    const curl = p({ install: via("brew") });
    contains(
      draftRefusal({ installers: mapOf(["brew", brew]), programs: programs(["setup-brew", setup], ["curl", curl]) }),
      "dependency cycle among programs",
    );
  });

  test("a machine installing through a variant the program lacks is named", () => {
    const message = refusal(
      draft({ programs: programs(["git", p({ install: via("dnf") })]), machines: mapOf(machine("m", { pm: pm("git", "brew") })) }),
    );
    contains(message, "machine 'm' installs 'git' via 'brew', but it can't be installed that way (it can via: dnf)");
  });

  test("installer defaults apply pkg and overrides", () => {
    const manifest = inRepo(
      draft({
        installers: mapOf([
          "brew-cask",
          inst({ probe: "brew", install: "brew install --cask {pkg}", check: "brew list --cask --versions {pkg}", regex: "(.*)" }),
        ]),
        programs: programs(
          ["toolbox", p({ install: install(["linux", v({ command: "brew tap x/y && brew install --cask toolbox-linux" })], ["brew-cask", v()]) })],
          ["toolbox-linux-cask", p({ install: install(["brew-cask", v({ pkg: "toolbox-linux" })]) })],
        ),
      }),
    );
    const cask = resolveInstall(manifest, "toolbox", "brew-cask");
    expect(cask.command).toBe("brew install --cask toolbox");
    expect(cask.check!.command).toBe("brew list --cask --versions toolbox");
    expect(cask.probe).toBe("brew");
    expect(resolveInstall(manifest, "toolbox-linux-cask", "brew-cask").command).toBe("brew install --cask toolbox-linux");
    // A custom variant has no installer: no probe, no derived check.
    expect(resolveInstall(manifest, "toolbox", "linux").probe).toBeUndefined();
  });

  test("a variant check without regex keeps its installer's regex", () => {
    const dnf = inst({ install: "sudo dnf install -y {pkg}", check: "rpm -q {pkg}", regex: "([0-9.]+)", probe: "dnf" });
    const manifest = assembleWithoutFiles(
      draft({
        layout: newRepoLayout({ state: "state" }),
        installers: mapOf(["dnf", dnf]),
        programs: programs(["zlib-devel", p({ install: install(["dnf", v({ check: "rpm -q --whatprovides zlib-devel" })]) })]),
      }),
    );
    const r = resolveInstall(manifest, "zlib-devel", "dnf");
    expect([r.command, r.check!.command, r.check!.regex, r.probe]).toEqual([
      "sudo dnf install -y zlib-devel",
      "rpm -q --whatprovides zlib-devel",
      "([0-9.]+)",
      "dnf",
    ]);
  });

  test("checks need a regex unless they are yes/no", () => {
    contains(draftRefusal({ installers: mapOf(["bad", inst({ install: "x {pkg}", check: "q {pkg}" })]) }), "installers.bad has a check but no regex");
    contains(
      draftRefusal({ programs: programs(["a", p({ install: install(["manual", v({ command: "x", check: "q" })]) })]) }),
      "programs.a.install.manual has a check but no regex",
    );
    contains(
      draftRefusal({
        programs: programs(["a", p({ install: install(["manual", v({ command: "x", check: "q", present: true, regex: "(.*)" })]) })]),
      }),
      "programs.a.install.manual is a yes/no check and also sets a regex",
    );
    // The yes/no form: no regex, no version.
    const manifest = inRepo(
      draft({ programs: programs(["a", p({ install: install(["custom", v({ command: "x", check: "test -f /etc/a", present: true })]) })]) }),
    );
    const c = resolveInstall(manifest, "a", "custom").check;
    expect(c).toBeDefined();
    expect(c!.regex).toBeUndefined();
  });

  test("a variant with no command is refused", () => {
    contains(refusal(draft({ programs: programs(["a", p({ install: via("custom") })]) })), "programs.a.install.custom resolves to no install command");
  });

  const coprInstaller = (): Installer => inst({ params: ["copr"], install: "dnf copr enable {copr} && dnf install {pkg}" });

  test("installer params substitute into every pattern", () => {
    const manifest = inRepo(
      draft({
        installers: mapOf([
          "copr",
          inst({
            params: ["copr"],
            install: "sudo dnf copr enable -y {copr} && sudo dnf install -y {pkg}",
            check: "rpm -q {pkg} && echo {copr}",
            regex: "(.*)",
          }),
        ]),
        programs: programs(["kitty", p({ install: install(["copr", v({ with: pm("copr", "solopasha/kitty") })]) })]),
      }),
    );
    const r = resolveInstall(manifest, "kitty", "copr");
    expect(r.command).toBe("sudo dnf copr enable -y solopasha/kitty && sudo dnf install -y kitty");
    expect(r.check!.command).toBe("rpm -q kitty && echo solopasha/kitty");
  });

  test("a missing or undeclared param is an error", () => {
    const withCopr = (variant: InstallVariant) =>
      draft({ installers: mapOf(["copr", coprInstaller()]), programs: programs(["kitty", p({ install: install(["copr", variant]) })]) });
    contains(refusal(withCopr(v())), "needs a value for 'copr'");
    contains(refusal(withCopr(v({ with: pm("copr", "x", "extra", "y") }))), "sets 'extra', which installer 'copr' does not declare in params");
    contains(
      refusal(draft({ programs: programs(["kitty", p({ install: install(["custom", v({ command: "x", with: pm("copr", "y") })]) })]) })),
      "sets 'copr' but resolves to no installer",
    );
    contains(
      refusal(draft({ installers: mapOf(["bad", inst({ params: ["pkg"], install: "x {pkg}" })]) })),
      "installers.bad declares param 'pkg', which is always available",
    );
  });

  test("install order puts dependencies first", () => {
    const manifest = inRepo(
      draft({
        programs: programs(
          ["git", p({ install: via("dnf") })],
          ["ripgrep", p({ dependsOn: ["git"], install: via("dnf") })],
          ["rustup", p({ install: custom("x") })],
        ),
      }),
    );
    expect(installOrder(manifest, ["ripgrep"], new Map())).toEqual(["git", "ripgrep"]);
    expect(installOrder(manifest, undefined, new Map())).toEqual(["git", "ripgrep", "rustup"]);
  });

  test("install order follows the mapped variant and its installer", () => {
    const manifest = inRepo(
      draft(
        {
          programs: programs(
            ["setup-brew", p({ install: custom("x") })],
            ["dnf-plugins-core", p({ install: via("dnf") })],
            ["kitty", p({ install: install(["brew", v()], ["copr", v({ command: "x", dependsOn: ["dnf-plugins-core"] })]) })],
          ),
        },
        { requires: mapOf(["brew", ["setup-brew"]]) },
      ),
    );
    expect(installOrder(manifest, ["kitty"], pm("kitty", "brew"))).toEqual(["setup-brew", "kitty"]);
    expect(installOrder(manifest, ["kitty"], pm("kitty", "copr"))).toEqual(["dnf-plugins-core", "kitty"]);
  });
});

// ─── scripts ───────────────────────────────────────────────────────────

describe("scripts", () => {
  test("script modes default to both surfaces", () => {
    const manifest = inRepo(
      draft({
        scripts: mapOf(
          ["bootstrap", step({ run: "true", modes: ["setup"] })],
          ["tidy", step({ run: "true", modes: ["maintain"] })],
          ["everyday", step({ run: "true" })],
        ),
      }),
    );
    const sc = manifest.scripts;
    expect(runsIn(sc.get("bootstrap")!, "setup")).toBe(true);
    expect(runsIn(sc.get("bootstrap")!, "maintain")).toBe(false);
    expect(runsIn(sc.get("tidy")!, "setup")).toBe(false);
    expect(runsIn(sc.get("everyday")!, "setup")).toBe(true);
    expect(runsIn(sc.get("everyday")!, "maintain")).toBe(true);
    contains(draftRefusal({ scripts: mapOf(["s", step({ run: "x", modes: ["bogus"] })]) }), "unknown mode 'bogus'");
    contains(draftRefusal({ scripts: mapOf(["s", step({ run: "x", modes: [] })]) }), "empty modes list");
  });

  test("a script has exactly one of a file or a command", () => {
    const scripts = (s: ScriptStep) => draft({ scripts: mapOf(["s", s]) });
    contains(refusal(scripts(step({ file: "s.sh", run: "true" })), "s.sh"), "scripts.s must define exactly one of a file or an inline command");
    contains(refusal(scripts(step())), "scripts.s must define exactly one of a file or an inline command");
    contains(
      refusal(scripts(step({ run: "true", variants: mapOf(["a", step({ file: "a.sh" })]) })), "a.sh"),
      "scripts.s has variants, so its file or command belongs in each variant",
    );
  });

  test("arguments need a file script", () => {
    contains(
      refusal(draft({ scripts: mapOf(["inline", step({ run: "echo hi" })]), machines: mapOf(machine("m", { scripts: ["inline x"] })) })),
      "machine 'm' passes arguments to script 'inline', which is an inline command",
    );
  });

  test("a machine picks a variant the script has", () => {
    contains(
      draftRefusal({
        scripts: mapOf(["k", step({ run: "x" })]),
        machines: mapOf(["m", newMachineConfig({ scripts: ["k"], scriptVariants: pm("k", "zzz") })]),
      }),
      "machine 'm' runs 'k' as 'zzz', which it doesn't have (has: none)",
    );
    contains(
      draftRefusal({
        scripts: mapOf(["k", step({ variants: mapOf(["one", step({ run: "1" })], ["arch", step({ run: "2" })]) })]),
        machines: mapOf(["m", newMachineConfig({ scripts: ["k"] })]),
      }),
      "machine 'm' runs 'k' without saying which variant (has: arch, one)",
    );
  });

  test("running a script twice is an error", () => {
    contains(
      draftRefusal({ scripts: mapOf(["s", step({ file: "s.sh" })]), machines: mapOf(["m", newMachineConfig({ scripts: ["s a", "s b"] })]) }),
      "machine 'm' runs script 's' more than once",
    );
  });

  test("script order puts after first", () => {
    const manifest = inRepo(
      draft({
        programs: programs(["git", p({ install: via("dnf") })]),
        scripts: mapOf(
          ["a", step({ run: "x", after: ["scripts.c", "programs.git"] })],
          ["b", step({ run: "x" })],
          ["c", step({ run: "x" })],
        ),
      }),
    );
    expect(scriptOrder(manifest, undefined)).toEqual(["c", "a", "b"]);
    contains(
      draftRefusal({
        scripts: mapOf(
          ["a", step({ run: "x", after: ["scripts.b"] })],
          ["b", step({ variants: mapOf(["v", step({ run: "x", after: ["scripts.a"] })]) })],
        ),
      }),
      "ordering cycle among scripts: a -> b -> a",
    );
  });
});

// ─── machines and profiles (contract 2) ────────────────────────────────

describe("machines and profiles", () => {
  test("profiles flatten into machines and are dropped", () => {
    const manifest = inRepo(
      draft(
        {
          programs: programs(["git", p({ install: via("dnf", "brew") })], ["kitty", p({ install: via("dnf") })]),
          scripts: mapOf(["dotfiles", step({ file: "dotfiles.sh" })], ["setup-ssh", step({ file: "ssh.sh" })]),
          machines: mapOf(machine("laptop", { extends: ["linux"], pm: pm("git", "brew"), scripts: ["setup-ssh laptopkey"] })),
        },
        {
          profiles: mapOf(
            profile("base", { pm: pm("git", "dnf", "kitty", "dnf"), scripts: ["dotfiles", "setup-ssh basekey"] }),
            profile("linux", { extends: ["base"] }),
          ),
        },
      ),
      "dotfiles.sh",
      "ssh.sh",
    );
    expect([...manifest.machines.keys()]).toEqual(["laptop"]);
    const laptop = manifest.machines.get("laptop")!;
    // Mappings merge per program, the machine wins; chains flatten through.
    expect(jsonString(new Map<string, JSONValue>(laptop.pm))).toBe(`{"git":"brew","kitty":"dnf"}`);
    // Scripts union; a machine's entry replaces the profile's by name (args too).
    const args = scriptArgs(laptop);
    expect([args.size, args.get("dotfiles"), args.get("setup-ssh")]).toEqual([2, "", "laptopkey"]);
    expect(laptop.extends).toEqual(["linux"]);
    expect(laptop.label).toBe("");
  });

  test("sibling profiles must agree, and the machine overrides them", () => {
    const agree = inRepo(
      draft(
        {
          programs: programs(["git", p({ install: via("dnf", "brew") })]),
          scripts: mapOf(["ssh", step({ file: "ssh.sh" })]),
          machines: mapOf(machine("m", { extends: ["a", "b"], pm: pm("git", "brew") })),
        },
        {
          profiles: mapOf(
            profile("a", { pm: pm("git", "dnf"), scripts: ["ssh one"] }),
            profile("b", { pm: pm("git", "dnf"), scripts: ["ssh one"] }),
          ),
        },
      ),
      "ssh.sh",
    );
    const mc = agree.machines.get("m")!;
    expect([mc.pm.get("git"), scriptArgs(mc).get("ssh"), mc.scripts.length]).toEqual(["brew", "one", 1]);

    const disagree = refusal(
      draft(
        {
          data: data(["omarchy", false]),
          programs: programs(["git", p({ install: via("dnf", "brew") })]),
          scripts: mapOf(
            ["ssh", step({ file: "ssh.sh" })],
            ["keyboard", step({ variants: mapOf(["one", step({ file: "k1.sh" })], ["two", step({ file: "k2.sh" })]) })],
          ),
          machines: mapOf(machine("m", { extends: ["a", "b"] })),
        },
        {
          profiles: mapOf(
            profile("a", { pm: pm("git", "dnf"), scripts: ["ssh one", "keyboard"], scriptVariants: pm("keyboard", "one"), data: data(["omarchy", true]) }),
            profile("b", { pm: pm("git", "brew"), scripts: ["ssh two", "keyboard"], scriptVariants: pm("keyboard", "two"), data: data(["omarchy", false]) }),
          ),
        },
      ),
      "ssh.sh",
      "k1.sh",
      "k2.sh",
    );
    contains(
      disagree,
      "machine 'm': profiles 'a' and 'b' map 'git' differently ('dnf' vs 'brew')",
      "machine 'm': profiles 'a' and 'b' run 'ssh' with different arguments",
      "machine 'm': profiles 'a' and 'b' run 'keyboard' as different variants ('one' vs 'two')",
      "machine 'm': profiles 'a' and 'b' set data key 'omarchy' differently",
    );
  });

  test("profile cycles and unknown profiles are named", () => {
    contains(draftRefusal({}, profile("p", { extends: ["q"] }), profile("q", { extends: ["p"] })), "profile cycle: p -> q -> p");
    contains(draftRefusal({ machines: mapOf(machine("m", { extends: ["laptop"] })) }), "machine 'm': extends unknown profile 'laptop'");
  });

  const flags = () =>
    data(["omarchy", false], ["tags", ["a"]], ["kitty", data(["opacity", floatNumber(0.85)], ["font", "mono"])]);

  test("data merges defaults, profiles and machine", () => {
    const manifest = inRepo(
      draft(
        {
          data: flags(),
          machines: mapOf(
            machine("m", { extends: ["omarchy"], data: data(["kitty", data(["opacity", floatNumber(0.9)])], ["tags", ["b"]]) }),
            machine("bare", {}),
          ),
        },
        { profiles: mapOf(profile("omarchy", { data: data(["omarchy", true], ["kitty", data(["font", "fira"])]) })) },
      ),
    );
    // Defaults under profile under machine; tables merge key by key, lists replace.
    const lines = dataLines(manifest.machines.get("m")!.data, "").map((l) => l.key + "=" + l.value);
    expect(lines).toEqual([`kitty.font="fira"`, "kitty.opacity=0.9", "omarchy=true", `tags=["b"]`]);
    // Every machine carries every declared key.
    expect(jsonEqual(manifest.data, manifest.machines.get("bare")!.data)).toBe(true);
    expect(manifest.data.get("omarchy")).toBe(false);
  });

  test("undeclared or mistyped data is an error", () => {
    const defaults = data(["work", false]);
    contains(
      draftRefusal({ data: defaults, machines: mapOf(machine("m", { data: data(["wrok", true]) })) }),
      "machine 'm': data key 'wrok' is not declared in the data schema",
    );
    contains(
      draftRefusal({ data: defaults, machines: mapOf(machine("m", { data: data(["work", "yes"]) })) }),
      "machine 'm': data key 'work' is a string, but the data schema declares a boolean",
    );
  });
});

// ─── files and origins (contracts 4, 5) ────────────────────────────────

/** managedBy is a script managed by a repo script, as the front end writes one. */
function managedBy(script: string, origin: string): ScriptStep {
  return step({ file: script, check: "file:" + script + ' check "$@"', origin });
}

function dnfRepo(repofile: string, origin: string): Program {
  return p({ install: install(["dnf-repo", v({ with: pm("repofile", repofile) })]), origin });
}

describe("files and origins", () => {
  test("paths are relative to the declaring directory and stay in the repo", () => {
    const tmux = draft({ scripts: mapOf(["tmux-plugins", managedBy("plugins.sh", "configs/tmux")]) });
    contains(refusal(tmux, "plugins.sh"), "scripts.tmux-plugins: file 'plugins.sh' not found (relative to configs/tmux/)");
    expect(inRepo(tmux, "configs/tmux/plugins.sh").scripts.get("tmux-plugins")!.origin).toBe("configs/tmux");
    const escaping = draft({ scripts: mapOf(["x", step({ file: "../../../outside.sh", origin: "a/b" })]) });
    contains(refusal(escaping), "file '../../../outside.sh' leaves the repo");
    // `..` that stays inside the repo reaches a shared helper.
    const helper = draft({ scripts: mapOf(["x", step({ file: "../lib/helper.sh", origin: "a/b" })]) });
    expect(inRepo(helper, "a/lib/helper.sh").scripts.get("x")!.file).toBe("../lib/helper.sh");
  });

  test("every file: command is checked", () => {
    const message = refusal(
      draft({
        programs: programs([
          "tool",
          p({ install: install(["script", v({ command: "file:scripts/tool.sh install --verbose", check: "file:scripts/tool-check.sh", regex: "(.*)" })]) }),
        ]),
        scripts: mapOf(["setup", step({ run: "true", check: "file:scripts/setup.sh check" })]),
        outdated: mapOf(["pins", newOutdatedSource({ command: "file:pins.sh", upgrade: "file:pins.sh bump {item}" })]),
      }),
    );
    // The path is named alone, never its arguments.
    contains(
      message,
      "programs.tool.install.script: file 'scripts/tool.sh' not found",
      "programs.tool.install.script check: file 'scripts/tool-check.sh' not found",
      "scripts.setup.check: file 'scripts/setup.sh' not found",
      "outdated.pins: file 'pins.sh' not found",
      "outdated.pins.upgrade: file 'pins.sh' not found",
    );
  });

  test("an install runs where its command was written", () => {
    const manifest = inRepo(
      draft({
        installers: mapOf(["pm", inst({ install: "pm add {pkg}", check: "pm query {pkg}", regex: "(.*)", origin: "programs/installers" })]),
        programs: programs(
          ["jq", p({ install: via("pm"), origin: "programs/cli" })],
          ["odd", p({ install: install(["pm", v({ command: "make install" })]), origin: "programs/cli" })],
        ),
      }),
    );
    const jq = resolveInstall(manifest, "jq", "pm");
    const odd = resolveInstall(manifest, "odd", "pm");
    expect([jq.commandOrigin, jq.check!.origin, odd.commandOrigin, odd.check!.origin]).toEqual([
      "programs/installers",
      "programs/installers",
      "programs/cli",
      "programs/installers",
    ]);
  });

  test("a file: with value is a path next to its program", () => {
    const manifest = inRepo(
      draft({ programs: programs(["code", dnfRepo("file:repos/code.repo", "programs/apps")], ["teams", dnfRepo("https://example.com/teams.repo", "programs/apps")]) }),
      "programs/apps/repos/code.repo",
    );
    contains(resolveInstall(manifest, "code", "dnf-repo").command!, "--from-repofile=$LOADOUT_REPO/programs/apps/repos/code.repo");
    // Unmarked values (a URL) pass through as written.
    contains(resolveInstall(manifest, "teams", "dnf-repo").command!, "--from-repofile=https://example.com/teams.repo");
    contains(
      refusal(draft({ programs: programs(["code", dnfRepo("file:repos/code.repo", "programs/apps")]) })),
      "programs.code.install.dnf-repo.with.repofile: file 'repos/code.repo' not found (relative to programs/apps/)",
    );
    // A lock's value is a repo path, checked again on load.
    expect(checkFiles(manifest, fsWith(), undefined)).toEqual([
      "programs.code.install.dnf-repo.with.repofile: file 'programs/apps/repos/code.repo' not found (relative to the repo root)",
    ]);
  });
});

// ─── a child repo's parent (contract 18) ───────────────────────────────

function inChild(d: ManifestDraft, ...files: string[]): Manifest {
  const repo: Record<string, string> = {};
  const parent: Record<string, string> = {};
  for (const f of files) {
    if (f.startsWith("parent:")) parent[f.slice("parent:".length)] = "#!/bin/sh\n";
    else repo[f] = "#!/bin/sh\n";
  }
  return assemble(withState(d), mapFS(repo), mapFS(parent));
}

describe("a child repo's parent", () => {
  test("a parent's files resolve in its checkout", () => {
    const d = draft({ scripts: mapOf(["helper", managedBy("helper.sh", "parent:maintenance/lib")], ["mine", managedBy("mine.sh", "scripts")]) });
    const manifest = inChild(d, "parent:maintenance/lib/helper.sh", "scripts/mine.sh");
    expect(manifest.scripts.get("helper")!.origin).toBe("parent:maintenance/lib");
    // The same file in the child's root is not the parent's.
    const err = errorOf(() => inChild(d, "maintenance/lib/helper.sh", "scripts/mine.sh"));
    contains(err.message, "scripts.helper: file 'helper.sh' not found (relative to parent:maintenance/lib/)");
  });

  test("a parent's file: with value is under LOADOUT_PARENT", () => {
    const d = draft({ programs: programs(["code", dnfRepo("file:repos/code.repo", "parent:programs/apps")]) });
    const manifest = inChild(d, "parent:programs/apps/repos/code.repo");
    // The built-in dnf-repo runs in the child: the path can't lean on LOADOUT_REPO.
    contains(resolveInstall(manifest, "code", "dnf-repo").command!, "--from-repofile=$LOADOUT_PARENT/programs/apps/repos/code.repo");
    const err = errorOf(() => inChild(d, "programs/apps/repos/code.repo"));
    contains(err.message, "programs.code.install.dnf-repo.with.repofile: file 'repos/code.repo' not found (relative to parent:programs/apps/)");
  });

  test("a lock without a parent says nothing of one", () => {
    const lock: Lock = { format: 0, toolVersion: "1.0.0", sources: "x", manifest: inRepo(newManifestDraft()) };
    expect(encodeLock(lock)).not.toContain("parent");
    const parent = newParentLayout({
      name: "dotfiles",
      path: "~/.local/share/chezmoi",
      state: "state",
      configs: "configs",
      sources: ["loadout.kt"],
      hash: "abc",
    });
    lock.manifest = { ...lock.manifest, layout: { ...lock.manifest.layout, parent } };
    const decoded = decodeLock(encodeLock(lock));
    expect(decoded.manifest.layout.parent).toEqual(parent);
  });
});

test("the lock round-trips", () => {
  const manifest = inRepo(
    draft({ programs: programs(["jq", p({ install: via("brew") })]), machines: mapOf(machine("m", { pm: pm("jq", "brew") })) }),
  );
  const text = encodeLock({ format: 0, toolVersion: "3.0.0", sources: "abc", manifest });
  expect(encodeLock(decodeLock(text))).toBe(text);
});

// ─── built-ins (contract 13) ───────────────────────────────────────────

describe("built-ins", () => {
  test("built-ins resolve without being declared", () => {
    const manifest = inRepo(draft({ programs: programs(["ripgrep", p({ install: via("dnf") })]) }));
    const r = resolveInstall(manifest, "ripgrep", "dnf");
    expect([r.command, r.check!.command, r.probe]).toEqual(["sudo dnf install -y ripgrep", "rpm -q ripgrep", "dnf"]);
    expect(manifest.builtinInstallers).toContain("dnf");
    expect(isSortedStrings(manifest.builtinInstallers)).toBe(true);
    expect(isSortedStrings([...manifest.installers.keys()])).toBe(true);
  });

  test("a repo installer replaces the built-in of the same name", () => {
    const manifest = inRepo(
      draft({
        installers: mapOf(["dnf", inst({ probe: "dnf", install: "sudo dnf5 install -y {pkg}" })]),
        programs: programs(["ripgrep", p({ install: via("dnf") })]),
      }),
    );
    expect(resolveInstall(manifest, "ripgrep", "dnf").command).toBe("sudo dnf5 install -y ripgrep");
    // Replaced outright, not merged: the built-in's oracle is gone with it.
    expect(manifest.builtinInstallers).not.toContain("dnf");
    expect(manifest.installers.get("dnf")!.outdatedAll).toBeUndefined();
    expect(manifest.builtinInstallers).toContain("brew");
  });

  test("a requirement on a built-in keeps it built in", () => {
    const manifest = inRepo(
      draft(
        {
          programs: programs(
            ["setup-dnf", p({ install: install(["dnf", v({ command: "file:setup-dnf.sh install", check: "file:setup-dnf.sh check", present: true })]) })],
            ["curl", p({ install: via("dnf") })],
          ),
        },
        { requires: mapOf(["dnf", ["setup-dnf"]]) },
      ),
      "setup-dnf.sh",
    );
    expect(manifest.installers.get("dnf")!.requires).toEqual(["setup-dnf"]);
    expect(manifest.builtinInstallers).toContain("dnf");
    contains(refusal(newManifestDraft({ requires: mapOf(["ghost", ["x"]]) })), "requires on unknown installer 'ghost'");
  });

  test("the shipped library is usable", () => {
    const installers = installerLibrary();
    for (const name of ["dnf", "apt", "pacman", "omarchy", "omarchy-aur", "brew", "brew-cask", "flatpak"]) {
      expect(installers.has(name)).toBe(true);
    }
    for (const [name, i] of installers) {
      expect([name, i.probe !== undefined]).toEqual([name, true]);
      expect([name, i.install?.includes("{pkg}")]).toEqual([name, true]);
      expect([name, i.check?.includes("{pkg}")]).toEqual([name, true]);
      // A batch oracle always wins over the per-pkg one: both would ship dead config.
      expect([name, i.outdated]).toEqual([name, undefined]);
    }
    expect(installerLibraryNames()).toEqual(["dnf", "brew", "brew-cask", "flatpak", "dnf-repo", "dnf-copr", "pacman", "omarchy", "omarchy-aur", "apt"]);
  });

  test("the shipped mechanisms share their sweeps", () => {
    // `upgrade` dedupes steps by command: the dnf mechanisms must spell
    // theirs identically, and refresh (the oracle reads a local cache).
    const installers = installerLibrary();
    for (const name of ["dnf", "dnf-repo", "dnf-copr"]) expect(installers.get(name)!.upgrade).toBe("sudo dnf upgrade --refresh -y");
    // Omarchy's update upgrades repo and AUR packages alike, never a bare pacman -Syu.
    for (const name of ["omarchy", "omarchy-aur"]) {
      const i = installers.get(name)!;
      expect([i.upgrade, i.probe]).toEqual(["omarchy update -y", "omarchy"]);
    }
    expect(installers.get("omarchy")!.install).toBe("omarchy pkg add {pkg}");
    expect(installers.get("omarchy-aur")!.install).toBe("omarchy pkg aur add {pkg}");
  });
});

test("meta version is a dotted number", () => {
  contains(refusal(draft({ meta: newMeta({ name: "x", minToolVersion: "soon" }) })), "meta min-tool-version 'soon' is not a dotted version number");
  contains(errorOf(() => assemble(newManifestDraft(), fsWith(), undefined)).message, "layout state is missing");
  contains(
    refusal(draft({ layout: newRepoLayout({ state: "st*te", configs: "../c" }) })),
    "layout 'st*te' is a directory, not a glob",
    "layout '../c' leaves the repo (..)",
  );
});

test("the refusal lists every error", () => {
  const message = draftRefusal({ programs: programs(["a", p({ dependsOn: ["x", "y"], install: custom("true") })]) });
  expect(message).toBe("Invalid manifest:\n  - programs.a depends-on unknown program 'x'\n  - programs.a depends-on unknown program 'y'");
});

test("the real lock reassembles to itself", () => {
  const text = readFileSync(import.meta.dir + "/testdata/loadout.lock.json", "utf8");
  const lock = decodeLock(text);
  // The lock as a draft: built-ins taken out again, their requirements kept.
  const d = newManifestDraft({ manifest: { ...lock.manifest, installers: new Map(lock.manifest.installers), builtinInstallers: [] } });
  for (const name of lock.manifest.builtinInstallers) {
    const req = lock.manifest.installers.get(name)?.requires ?? [];
    if (req.length > 0) d.requires.set(name, req);
    d.manifest.installers.delete(name);
  }
  // Machines are flat already: what they extend adds nothing.
  for (const config of lock.manifest.machines.values()) {
    for (const name of config.extends) d.profiles.set(name, newMachineConfig({ label: "profile '" + name + "'" }));
  }
  lock.manifest = assembleWithoutFiles(d);
  expect(encodeLock(lock) === text).toBe(true);
});
