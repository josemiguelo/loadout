import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { installed, missing, newMachineState } from "../core/coremodel/coremodel.ts";
import { custom, defaultRegex, manifestOf, pm, version, via } from "../core/coretest/coretest.ts";
import { newDetection } from "../core/detect/detect.ts";
import { exit, newRunner, type Runner, stderr, stdout } from "../core/exec/fakeexec/fakeexec.ts";
import { dirFS, encodeLock, type Manifest, mapFS, newInstallVariant, newRepoLayout, sourcesHash } from "../model/index.ts";
import { typesFile, typesFiles } from "../compile/compile.ts";
import { VERSION } from "../version.ts";
import { type AppContext, newAppWith } from "./context.ts";
import { NoSuchItemError } from "./explain.ts";
import { latestRelease } from "./selfversion.ts";

// app's context: what the CLI and the home screen lean on.

const sources = ["loadout.ts"];

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** repo is a repo on disk whose lock (current with its sources) holds m. */
function repo(m: Manifest): string {
  const root = realpathSync(mkdtempSync(tmpdir() + "/loadout-app-"));
  put(root + "/loadout.ts", "\n");
  writeLock(root, m);
  return root;
}

function writeLock(root: string, m: Manifest): void {
  const withLayout = { ...m, layout: { ...m.layout, sources } };
  put(root + "/loadout.lock.json", encodeLock({ format: 0, toolVersion: VERSION, sources: sourcesHash(dirFS(root), sources), manifest: withLayout }));
}

function appOf(root: string, runner: Runner = newRunner()): AppContext {
  return newAppWith(root, "m1", false, runner, newDetection(runner, mapFS({})));
}

// The cache and the bun wrapper (written by any frame) go to temp folders.
let cacheHome = "";
const savedCache = process.env.XDG_CACHE_HOME;
const savedData = process.env.XDG_DATA_HOME;
beforeEach(() => {
  cacheHome = mkdtempSync(tmpdir() + "/loadout-cache-");
  process.env.XDG_CACHE_HOME = cacheHome;
  process.env.XDG_DATA_HOME = mkdtempSync(tmpdir() + "/loadout-data-");
});
afterEach(() => {
  if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedCache;
  if (savedData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedData;
});

test("the layout is read once, until reloadLayout", () => {
  const m = manifestOf((b) => b.machine("m1", {}));
  const root = repo({ ...m, layout: newRepoLayout({ state: "state" }) });
  const a = appOf(root);
  const store = a.stateStore();
  expect(store.pathFor("m1")).toBe(root + "/state/m1.json");
  writeLock(root, { ...m, layout: newRepoLayout({ state: "moved" }) });
  expect(a.stateStore()).toBe(store);
  a.reloadLayout();
  expect(a.stateStore().pathFor("m1")).toBe(root + "/moved/m1.json");
});

test("reading the layout puts the SDKs' types in the repo, rewriting stale ones", () => {
  const m = manifestOf((b) => b.machine("m1", {}));
  const root = repo({ ...m, layout: newRepoLayout({ state: "state" }) });
  const index = root + "/" + typesFile;
  put(index, "// an older loadout's\n");
  appOf(root).layout();
  for (const f of typesFiles) expect(readFileSync(root + "/" + f.path, "utf8")).toBe(f.content);
  expect(readFileSync(index, "utf8")).toContain('declare module "loadout" {');
});

test("a layout that can't be read fails every use the same way", () => {
  const a = appOf("/nonexistent/repo");
  expect(() => a.layout()).toThrow("no loadout.lock.json in /nonexistent/repo — run: loadout compile");
  expect(() => a.stateStore()).toThrow("no loadout.lock.json");
  expect(a.hasConfigs()).toBe(false);
  expect(a.fleetWarnings()).toEqual([]);
  expect(() => a.canonicalRoot()).toThrow("lstat /nonexistent: no such file or directory");
});

test("every frame puts loadout itself first on PATH as bun", async () => {
  const saved = process.env.LOADOUT_BUN;
  delete process.env.LOADOUT_BUN;
  try {
    const m = manifestOf((b) => b.machine("m1", {}));
    const a = appOf(repo({ ...m, layout: newRepoLayout({ state: "state" }) }));
    const folder = process.env.XDG_DATA_HOME + "/loadout/bin";
    expect(a.bunDir()).toBe(folder);
    const command = (await a.frame({ machine: "m1", os: "linux", arch: "x86_64" })).command("x", "");
    expect(command.env?.["PATH"]?.startsWith(folder + ":")).toBe(true);
    expect(readFileSync(folder + "/bun", "utf8")).toContain("BUN_BE_BUN=1 exec '" + process.execPath + "'");
  } finally {
    if (saved !== undefined) process.env.LOADOUT_BUN = saved;
  }
});

test("the outdated report orders rows by installer declaration, then release, then sources", async () => {
  const m = manifestOf((b) => {
    b.installer("dnf", { probe: "dnf", install: "dnf install {pkg}", check: "rpm -q {pkg}", outdatedAll: "dnf-outdated", upgrade: "sudo dnf upgrade -y" });
    b.installer("flatpak", { probe: "flatpak", install: "flatpak install {pkg}", check: "flatpak info {pkg}", outdatedAll: "flatpak-outdated" });
    b.program("git", { install: via("dnf") });
    b.program("rg", { install: via("dnf") });
    b.program("slack", { install: new Map([["flatpak", newInstallVariant({ pkg: "com.slack.Slack" })]]) });
    b.program("mytool", {
      install: new Map([["own", newInstallVariant({ command: "x", check: "mytool --version", regex: defaultRegex, outdated: "mytool-latest" })]]),
    });
    b.program("plain", { install: custom("own", "y"), version: version("plain --version", defaultRegex) });
    b.program("gone", { install: via("dnf") });
    b.outdated("pins", { command: "pins-check" });
    b.outdated("broken", { command: "broken-check" });
    b.machine("m1", { pm: pm("git", "dnf", "rg", "dnf", "slack", "flatpak", "mytool", "own", "plain", "own", "gone", "dnf") });
  });
  const root = repo(m);
  const runner = newRunner()
    .onCommand("dnf-outdated", stdout("git 2.41-1.fc40\nrg 14.0\nkernel 6.9\n"), exit(100))
    .onCommand("flatpak-outdated", stdout("com.slack.Slack 4.2\n"))
    .onCommand("mytool-latest", stdout("1.1\n"))
    .onCommand("pins-check", stdout("x 1 2 moved https://example.com/c\n"))
    .onCommand("broken-check", exit(2), stderr("boom\n"));
  const a = appOf(root, runner);
  const observed = newMachineState({
    machine: "m1",
    programs: new Map([
      ["git", { status: installed, version: "2.40" }],
      ["rg", { status: installed, version: "14.0" }],
      ["slack", { status: installed, version: "4.1" }],
      ["mytool", { status: installed, version: "1.0" }],
      ["plain", { status: installed, version: "1.0" }],
      ["gone", { status: missing }],
    ]),
  });
  const report = await a.outdatedReport(a.loadManifest(), a.detectSystem(), observed, true);
  expect(report.updates).toEqual([
    { name: "git", current: "2.40", candidate: "2.41", source: "dnf", note: "" },
    { name: "slack", current: "4.1", candidate: "4.2", source: "flatpak", note: "" },
    { name: "mytool", current: "1.0", candidate: "1.1", source: "own", note: "" },
    { name: "x", current: "1", candidate: "2", source: "pins", note: "moved", link: "https://example.com/c" },
  ]);
  expect(report.tools).toEqual([
    { tool: "dnf", installers: ["dnf"], total: 3, declared: ["git"], others: ["kernel"], command: "sudo dnf upgrade -y" },
    { tool: "flatpak", installers: ["flatpak"], total: 1, declared: ["slack"], others: [], command: undefined },
  ]);
  expect(report.errors).toEqual([{ label: "broken", reason: "exited 2: boom" }]);
  expect(report.unchecked).toEqual(["plain"]);
});

test("explain shows a program's variants, marks this machine's, and stops at an unknown name", async () => {
  const m = manifestOf((b) => {
    b.installer("dnf", { probe: "dnf", install: "dnf install {pkg}" });
    b.program("git", { description: "vcs", install: via("dnf"), version: version("git --version", defaultRegex) });
    b.script("dots", { file: "dots.sh" });
    b.machine("m1", { pm: pm("git", "dnf"), scripts: ["dots --all"] });
  });
  const root = repo(m);
  put(root + "/dots.sh", "#!/bin/sh\n");
  const a = appOf(root);
  const explained = await a.explain(["git", "dots"]);
  expect(explained.map((n) => n.name)).toEqual(["git", "dots"]);
  const git = explained[0]!.items[0]!;
  expect(git.kind).toBe("program");
  expect(git.description).toBe("vcs");
  expect(git.rows).toEqual([
    { label: "version", value: "git --version  =~ /" + defaultRegex + "/", machine: "" },
    { label: "install.dnf", value: "dnf install git  [installer: dnf (repo)]", machine: "m1" },
    { label: "probe.dnf", value: "dnf", machine: "" },
  ]);
  expect(git.notes).toEqual([]);
  expect(explained[1]!.items[0]!.rows).toEqual([
    { label: "file", value: "dots.sh", machine: "" },
    { label: "enabled", value: "yes (m1, args: --all)", machine: "" },
  ]);
  try {
    await a.explain(["git", "nope"]);
    throw new Error("explained an unknown name");
  } catch (e) {
    expect(e).toBeInstanceOf(NoSuchItemError);
    expect((e as NoSuchItemError).message).toBe("no program or script named 'nope'");
    expect((e as NoSuchItemError).explained.map((n) => n.name)).toEqual(["git"]);
  }
});

test("the latest release is cached for 6h, and a stale cache beats nothing", async () => {
  const curl = "curl -fsSL --max-time 5 'https://api.github.com/repos/josemiguelo/loadout/releases/latest'";
  const online = newRunner().onCommand(curl, stdout('{"tag_name": "v9.1.0"}'));
  expect(await latestRelease(online, true)).toBe("9.1.0");
  const offline = newRunner();
  expect(await latestRelease(offline, true)).toBe("9.1.0");
  expect(offline.executed()).toEqual([]);
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(cacheHome + "/loadout/latest-release", old, old);
  expect(await latestRelease(offline, true)).toBe("9.1.0");
  expect(offline.executed()).toEqual([curl]);
});
