import { expect, test } from "bun:test";
import { type ConfigState, configStateEqual, type MachineState, newMachineState } from "../coremodel/coremodel.ts";
import { manifestOf, pm, runs, via } from "../coretest/coretest.ts";
import { exit, newRunner, type Runner, stderr, stdout } from "../exec/fakeexec/fakeexec.ts";
import { mapOf } from "../../model/index.ts";
import { type ConfigEngine, newConfigEngine, newSingleConfigEngine } from "./configengine.ts";
import { ConfigException, ConfigNeedsSudoException } from "./errors.ts";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newStatusEngine, toolDownMessage } from "./statusengine.ts";
import { contains, laptop, refused, repoFrame } from "./testhelpers.ts";
import { newVersionChecker } from "./versionchecker.ts";

const cz = "chezmoi --source '/repo/configs' --no-pager";
const czManaged = cz + " managed --include files,symlinks";
const czStatus = cz + " status --include files,symlinks";

function configs(runner: Runner): ConfigEngine {
  return newSingleConfigEngine(runner, "/repo/configs");
}

const managedOut = ".config/tmux/tmux.conf\n.config/zsh/.zshrc\n.config/zsh/conf.d/a.zsh\n.config/starship.toml\n.zshenv\n.local/bin/x\n";

function applied(): ConfigState {
  return { status: "applied", files: [] };
}

function configEq(want: ConfigState, got: ConfigState | undefined): void {
  expect(got).toBeDefined();
  if (!configStateEqual(want, got!)) expect(got).toEqual(want);
}

test("units are a config folder or a top-level name", async () => {
  const runner = newRunner().onCommand(czManaged, stdout(managedOut));
  const units = await configs(runner).units();
  expect(units.map((u) => u.name)).toEqual([".local", ".zshenv", "starship.toml", "tmux", "zsh"]);
  expect(units[4]!.targets).toEqual([".config/zsh/.zshrc", ".config/zsh/conf.d/a.zsh"]);
});

test("a unit drifts when apply would change one of its files", async () => {
  const runner = newRunner()
    .onCommand(czManaged, stdout(managedOut))
    // Second column: apply would change it. First column alone: edited
    // here but already what the repo says, so nothing to apply.
    .onCommand(czStatus, stdout(" M .config/zsh/.zshrc\nM  .config/tmux/tmux.conf\n A .config/zsh/conf.d/a.zsh\n"));
  const observed = await configs(runner).observe(new Map());
  configEq({ status: "drifted", files: [".config/zsh/.zshrc", ".config/zsh/conf.d/a.zsh"] }, observed.get("zsh"));
  configEq(applied(), observed.get("tmux"));
  configEq(applied(), observed.get(".zshenv"));
  expect(observed.size).toBe(5);
});

test("only files edited here that apply would replace need a decision", async () => {
  const runner = newRunner().onCommand(czStatus, stdout("MM .config/zsh/.zshrc\n M .zshenv\nM  .config/tmux/tmux.conf\n"));
  const engine = configs(runner);
  expect(await engine.edited(undefined)).toEqual([".config/zsh/.zshrc"]);
  expect(await engine.edited([".zshenv"])).toEqual([]);
});

test("without chezmoi the units last seen are unknown", async () => {
  const engine = configs(newRunner()); // every command: exit 127
  const observed = await engine.observe(mapOf(["zsh", applied()]));
  expect([...observed.keys()]).toEqual(["zsh"]);
  configEq({ status: "unknown", files: [], reason: "chezmoi is not on PATH" }, observed.get("zsh"));
  expect(engine.lastReason()).toBe("chezmoi is not on PATH");
});

test("a chezmoi error is the reason in its own words", async () => {
  const runner = newRunner()
    .onCommand(czManaged, stdout(managedOut))
    .onCommand(czStatus, exit(1), stderr('chezmoi: .bad: template: dot_bad.tmpl:1:8: map has no entry for key "nope"\n'));
  const engine = configs(runner);
  const observed = await engine.observe(mapOf(["tmux", applied()]));
  expect(observed.get("tmux")!.status).toBe("unknown");
  contains(engine.lastReason()!, "chezmoi: .bad: template");

  // The next good answer clears it.
  runner.onCommand(czStatus);
  await engine.observe(observed);
  expect(engine.lastReason()).toBeUndefined();
});

async function applyLine(engine: ConfigEngine, targets: string[] | undefined, force: boolean): Promise<string> {
  return (await engine.applyCommand(targets, force)).line;
}

test("apply names absolute targets and forces only when asked", async () => {
  const engine = configs(newRunner().onCommand(cz + " target-path", stdout("/home/me\n")));
  expect(await applyLine(engine, undefined, false)).toBe(cz + " apply --no-tty");
  expect(await applyLine(engine, [".config/zsh/.zshrc", "it's"], true)).toBe(
    cz + ` apply --no-tty --force '/home/me/.config/zsh/.zshrc' '/home/me/it'\\''s'`,
  );
});

test("a chezmoi that can't answer is a refusal", async () => {
  await refused(ConfigException, () => configs(newRunner()).units());
});

// ─── a child repo: its parent's source and its own (contract 18) ──

const parentCz = "chezmoi --source '/dots/configs' --no-pager";
const childCz = "chezmoi --source '/work/configs' --no-pager";

const loadoutEnv = { LOADOUT_REPO: "/work", LOADOUT_MACHINE: "work" };

function both(runner: Runner): ConfigEngine {
  return newConfigEngine(
    runner,
    [
      { dir: "/dots/configs", label: "parent dots" },
      { dir: "/work/configs", label: "" },
    ],
    loadoutEnv,
  );
}

function twoSources(parentManaged: string, childManaged: string, parentStatus: string, childStatus: string): Runner {
  return newRunner()
    .onCommand(parentCz + " managed --include files,symlinks", stdout(parentManaged))
    .onCommand(childCz + " managed --include files,symlinks", stdout(childManaged))
    .onCommand(parentCz + " status --include files,symlinks", stdout(parentStatus))
    .onCommand(childCz + " status --include files,symlinks", stdout(childStatus))
    .onCommand(parentCz + " target-path", stdout("/home/u\n"))
    .onCommand(childCz + " target-path", stdout("/home/u\n"));
}

test("a unit spans both sources and drifts when either would", async () => {
  const runner = twoSources(".config/zsh/.zshrc\n.zshenv\n", ".config/zsh/conf.d/zz-work.zsh\n", "", " M .config/zsh/conf.d/zz-work.zsh\n");
  const engine = both(runner);
  const units = await engine.units();
  expect(units[1]!.name).toBe("zsh");
  expect(units[1]!.targets).toEqual([".config/zsh/.zshrc", ".config/zsh/conf.d/zz-work.zsh"]);
  const observed = await engine.observe(new Map());
  configEq({ status: "drifted", files: [".config/zsh/conf.d/zz-work.zsh"] }, observed.get("zsh"));
  expect(observed.get(".zshenv")!.status).toBe("applied");
  // chezmoi sees the repo and machine loadout runs as.
  for (const c of runner.received()) expect([c.line, c.env]).toEqual([c.line, loadoutEnv]);
});

test("a file both sources manage is unknown and apply refuses it", async () => {
  const engine = both(twoSources(".config/git/config\n.zshenv\n", ".config/git/config\n", "", ""));
  const git = (await engine.observe(new Map())).get("git")!;
  expect(git.status).toBe("unknown");
  expect(git.reason).toBe(".config/git/config is managed by parent dots and this repo — a file belongs to one repo");
  contains(await refused(ConfigException, () => engine.applyCommand([".config/git/config"], false)), "a file belongs to one repo");
  await refused(ConfigException, () => engine.applyCommand(undefined, false));
  // A target only one repo manages still applies.
  expect(await applyLine(engine, [".zshenv"], false)).toBe(parentCz + " apply --no-tty '/home/u/.zshenv'");
});

test("apply runs each source on its own targets, the parent's first", async () => {
  const engine = both(twoSources(".zshenv\n", ".config/work/x\n", "", ""));
  expect(await applyLine(engine, undefined, false)).toBe(parentCz + " apply --no-tty && " + childCz + " apply --no-tty");
  expect(await applyLine(engine, [".config/work/x", ".zshenv"], true)).toBe(
    parentCz + " apply --no-tty --force '/home/u/.zshenv' && " + childCz + " apply --no-tty --force '/home/u/.config/work/x'",
  );
  expect((await engine.applyCommand(undefined, false)).env).toEqual(loadoutEnv);
});

// The refresh says once what couldn't answer: a tool its checks go through, and chezmoi.
test("a refresh names the tools and configs that could not answer", async () => {
  const m = manifestOf((b) => {
    b.installer("pm", { probe: "pm", install: "pm add {packageName}", check: "pm query {packageName}" });
    b.program("bat", { install: via("pm") });
    b.script("dotfiles", { run: "echo setup", check: "test -d $HOME/.dotfiles" });
    b.machine("laptop", { pm: pm("bat", "pm"), scripts: runs("dotfiles") });
  });
  const runner = newRunner();
  const checks = newVersionChecker(runner, repoFrame);
  const engine = newStatusEngine(checks, runner, repoFrame, configs(runner));
  const previous: MachineState = newMachineState({ configs: mapOf(["zsh", applied()]) });
  const state = await engine.refresh(m, laptop, previous, new Map());
  expect(state.configs.get("zsh")!.status).toBe("unknown");
  expect(engine.lastConfigsDown()).toBe("chezmoi is not on PATH");
  expect(engine.lastScriptDetail()).toEqual(new Map([["dotfiles", "sh: command not found"]]));
  // bat's check goes through pm, which isn't there.
  const down = engine.lastToolsDown();
  expect(down.length).toBe(1);
  expect(toolDownMessage(down[0]!)).toBe("pm is not on PATH — 1 program(s) not checked");
  expect(down[0]!.programs).toEqual(["bat"]);
});

// ─── a root source: tool folders' root/, applied to / (contract 17) ──

const rootArgs =
  "chezmoi --source '/repo/.root' --destination '/' --config /dev/null --config-format toml" +
  " --persistent-state '/var/lib/loadout/chezmoistate.boltdb' --cache '/var/cache/loadout/chezmoi' --no-pager";
// Both sides pin one umask: chezmoi computes a file's mode from it.
const rootCz = "umask 022 && " + rootArgs;
const sudoRootCz = `sudo sh -c 'umask 022 && exec env "$@"' sh HOME='/home/u' LOADOUT_REPO='/repo' LOADOUT_MACHINE='laptop' ` + rootArgs;

function withRoot(runner: Runner, there: string[] = ["/etc", "/etc/udev"]): ConfigEngine {
  return newConfigEngine(
    runner,
    [
      { dir: "/repo/configs", label: "" },
      {
        dir: "/repo/.root",
        label: "",
        root: {
          destination: "/",
          state: "/var/lib/loadout/chezmoistate.boltdb",
          cache: "/var/cache/loadout/chezmoi",
          sudo: true,
          home: "/home/u",
          toolOf: (rel) => (rel.startsWith("etc/udev") ? "keychron" : "t2"),
          exists: (p) => there.includes(p),
        },
      },
    ],
    { LOADOUT_REPO: "/repo", LOADOUT_MACHINE: "laptop" },
  );
}

const rootManaged = JSON.stringify({
  "etc/udev/rules.d/50-k.rules": { absolute: "/etc/udev/rules.d/50-k.rules", sourceRelative: "etc/udev/rules.d/50-k.rules" },
  "etc/modprobe.d/t2.conf": { absolute: "/etc/modprobe.d/t2.conf", sourceRelative: "etc/modprobe.d/t2.conf" },
});
const rootDirs = JSON.stringify({
  etc: { absolute: "/etc", sourceRelative: "etc" },
  "etc/udev": { absolute: "/etc/udev", sourceRelative: "etc/udev" },
  "etc/udev/rules.d": { absolute: "/etc/udev/rules.d", sourceRelative: "etc/udev/rules.d" },
  "etc/modprobe.d": { absolute: "/etc/modprobe.d", sourceRelative: "private_modprobe.d" },
});

function rootRunner(rootStatus: string): Runner {
  return newRunner()
    .onCommand(czManaged, stdout(".zshenv\n"))
    .onCommand(czStatus, stdout(""))
    .onCommand(rootCz + " managed --include files,symlinks --path-style all --format json", stdout(rootManaged))
    .onCommand(rootCz + " managed --include dirs --path-style all --format json", stdout(rootDirs))
    .onCommand(rootCz + " status --include files,symlinks", stdout(rootStatus))
    .onCommand(rootCz + " status --exclude dirs", stdout(rootStatus))
    .onCommand(rootCz + " status --exclude dirs '/etc/udev/rules.d/50-k.rules'", stdout(rootStatus));
}

test("a root source's units are the tools its files came from, its targets absolute", async () => {
  const engine = withRoot(rootRunner(" A etc/udev/rules.d/50-k.rules\n"));
  const units = await engine.units();
  expect(units.map((u) => [u.name, u.targets])).toEqual([
    [".zshenv", [".zshenv"]],
    ["/keychron", ["/etc/udev/rules.d/50-k.rules"]],
    ["/t2", ["/etc/modprobe.d/t2.conf"]],
  ]);
  const observed = await engine.observe(new Map());
  configEq({ status: "drifted", files: ["/etc/udev/rules.d/50-k.rules"] }, observed.get("/keychron"));
  configEq(applied(), observed.get("/t2"));
});

test("a root source applies as root in two passes, leaving folders already there alone", async () => {
  const engine = withRoot(rootRunner(" A etc/udev/rules.d/50-k.rules\n"));
  expect(await engine.rootNeedsSudo(undefined)).toBe(true);
  const apply = await engine.applyCommand(["/etc/udev/rules.d/50-k.rules"], false);
  expect(apply.line).toBe(
    "( sudo mkdir -p '/var/lib/loadout' '/var/cache/loadout/chezmoi'" +
      // Pass 1: the folders not there yet, and the one whose source name carries an attribute.
      " && " + sudoRootCz + " apply --no-tty --include dirs '/etc/udev/rules.d' '/etc/modprobe.d'" +
      // Pass 2: everything else, without folders.
      " && " + sudoRootCz + " apply --no-tty --exclude dirs '/etc/udev/rules.d/50-k.rules'" +
      // The state left readable even when a pass failed, and the apply's own exit kept.
      "; rc=$?; if [ -e '/var/lib/loadout/chezmoistate.boltdb' ]; then sudo chmod 0755 '/var/lib/loadout'; sudo chmod 0644 '/var/lib/loadout/chezmoistate.boltdb'; fi; exit $rc )",
  );
});

test("the state stays readable after a failed apply, and the exit is the apply's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rootapply-"));
  const state = join(dir, "state");
  writeFileSync(state, "");
  chmodSync(state, 0o600);
  const line = "( false; rc=$?; if [ -e '" + state + "' ]; then chmod 0644 '" + state + "'; fi; exit $rc ) && echo next";
  const r = Bun.spawnSync(["sh", "-c", line]);
  expect(r.exitCode).toBe(1);
  expect(r.stdout.toString()).toBe("");
  expect((statSync(state).mode & 0o777).toString(8)).toBe("644");
  rmSync(dir, { recursive: true, force: true });
});

test("apply's own flags (--dry-run, --verbose) go to both root passes", async () => {
  const engine = withRoot(rootRunner(" A etc/udev/rules.d/50-k.rules\n"));
  const line = (await engine.applyCommand(["/etc/udev/rules.d/50-k.rules"], false, ["--dry-run", "-v"])).line;
  expect(line).toContain(" apply --no-tty '--dry-run' '-v' --include dirs ");
  expect(line).toContain(" apply --no-tty '--dry-run' '-v' --exclude dirs ");
});

test("a root source with nothing to do isn't applied, so nothing asks for sudo", async () => {
  const engine = withRoot(rootRunner(""), ["/etc", "/etc/udev", "/etc/udev/rules.d", "/etc/modprobe.d"]);
  expect(await engine.rootNeedsSudo(undefined)).toBe(false);
  expect((await engine.applyCommand(undefined, false)).line).toBe(cz + " apply --no-tty");
});

test("a root target this user can't read is observed with sudo when that needs no password", async () => {
  const runner = rootRunner("")
    .onCommand(rootCz + " status --include files,symlinks", stderr("chezmoi: open /etc/sudoers.d/x: permission denied"), exit(1))
    .onCommand("sudo -n true", stdout(""))
    .onCommand(sudoRootCz.replace(/^sudo /, "sudo -n ") + " status --include files,symlinks", stdout(" M etc/modprobe.d/t2.conf\n"));
  const observed = await withRoot(runner).observe(new Map());
  configEq({ status: "drifted", files: ["/etc/modprobe.d/t2.conf"] }, observed.get("/t2"));
});

test("a root source that needs sudo's password leaves the other units observed, and its own unknown", async () => {
  const runner = rootRunner("")
    .onCommand(czStatus, stdout(" M .zshenv\n"))
    .onCommand(rootCz + " status --include files,symlinks", stderr("chezmoi: open /etc/sudoers.d/x: permission denied"), exit(1))
    .onCommand("sudo -n true", stderr("sudo: a password is required"), exit(1));
  const engine = withRoot(runner);
  const observed = await engine.observe(mapOf(["/t2", applied()], [".zshenv", applied()]));
  configEq({ status: "drifted", files: [".zshenv"] }, observed.get(".zshenv"));
  expect(observed.get("/t2")?.status).toBe("unknown");
  expect(observed.get("/t2")?.reason).toContain("permission denied (it needs sudo)");
  expect(engine.lastReason()).toContain("(it needs sudo)");
  // Applying asks for the password: the command can tell.
  await expect(engine.edited(undefined)).rejects.toBeInstanceOf(ConfigNeedsSudoException);
});

test("a root source's template error is chezmoi's answer, never retried as root", async () => {
  const runner = rootRunner("").onCommand(rootCz + " status --include files,symlinks", stderr("chezmoi: template: x:1: boom"), exit(1));
  const observed = await withRoot(runner).observe(mapOf(["/t2", applied()]));
  expect(observed.get("/t2")?.reason).toBe("chezmoi: template: x:1: boom");
  expect(runner.executed().some((c) => c.startsWith("sudo"))).toBe(false);
});
