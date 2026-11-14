import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import {
  chezmoiDataFiles,
  dirFS,
  encodeLock,
  isJSONObject,
  isRefusal,
  type JSONObject,
  jsonString,
  ManifestException,
  type Manifest,
  newMachineConfig,
  newParentLayout,
  newRepoLayout,
  parseJSON,
  renderChezmoiData,
  sourcesHash,
  ToolTooOldException,
} from "../../model/index.ts";
import { VERSION } from "../../version.ts";
import { custom, manifestOf, pm } from "../coretest/coretest.ts";
import { ConfigException, ResolutionException, UpgradeException } from "../engine/errors.ts";
import { InterruptedByUser } from "../exec/exec.ts";
import { GitException } from "../git/git.ts";
import { loadRepo, parentChanged, parentRoot, readLayout, toolTooOld } from "./loader.ts";

// The lock reader: the only way the binary sees a repo's manifests.

const sources = ["loadout.ts", "programs/**/*.loadout.ts"];

const tempDir = () => mkdtempSync(tmpdir() + "/loadout-loader-");

function manifest(minToolVersion: string): Manifest {
  const m = manifestOf((b) => {
    b.meta("test", minToolVersion);
    b.program("git", { install: custom("custom", "file:install-git.sh") });
    b.machine("m", { pm: pm("git", "custom") });
  });
  return { ...m, layout: newRepoLayout({ state: "state", configs: "configs", sources }) };
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const hash = (root: string, globs: string[]) => sourcesHash(dirFS(root), globs);

interface RepoOpts {
  manifest?: Manifest;
  toolVersion?: string;
  files?: string[];
}

/** repo is a repo whose lock is current with its sources, with files on disk. */
function repo(o: RepoOpts = {}): string {
  const root = tempDir();
  const m = o.manifest ?? manifest("");
  put(root + "/loadout.ts", "repo {}\n");
  put(root + "/programs/cli.loadout.ts", "\n");
  for (const f of o.files ?? ["install-git.sh"]) put(root + "/" + f, "#!/bin/sh\n");
  put(root + "/loadout.lock.json", encodeLock({ format: 0, toolVersion: o.toolVersion ?? VERSION, sources: hash(root, sources), manifest: m }));
  // What compile writes beside the configs.
  if (m.layout.configs !== undefined) {
    for (const [path, text] of chezmoiDataFiles(m, m.layout.configs)) put(root + "/" + path, text);
  }
  return root;
}

function refusal(root: string): string {
  try {
    loadRepo(root, "");
  } catch (e) {
    if (!isRefusal(e)) throw new Error(`not a refusal: ${String(e)}`);
    return e.message;
  }
  throw new Error("loaded");
}

function contains(message: string, ...wants: string[]): void {
  for (const want of wants) expect(message).toContain(want);
}

const load = (root: string, home: string) => loadRepo(root, home);

function versions(): [major: number, minor: number, patch: number] {
  const [a, b, c] = VERSION.split(".").map(Number);
  return [a!, b!, c!];
}

test("a current lock loads", () => {
  const root = repo();
  const lockOf = (m: Manifest) => encodeLock({ format: 0, toolVersion: "", sources: "", manifest: m });
  expect(lockOf(load(root, ""))).toBe(lockOf(manifest("")));
  const layout = readLayout(root);
  expect([layout.state, layout.configs, layout.sources]).toEqual(["state", "configs", sources]);
});

test("the templates' data must match the lock", () => {
  const missing = repo();
  rmSync(missing + "/configs/.chezmoidata/loadout.json");
  contains(refusal(missing), "configs/.chezmoidata/loadout.json is missing — run: loadout compile");

  const edited = repo();
  put(edited + "/configs/.chezmoidata/loadout.json", "{}\n");
  contains(refusal(edited), "configs/.chezmoidata/loadout.json doesn't match loadout.lock.json — run: loadout compile");
});

test("the partial must be loadout's", () => {
  const missing = repo();
  rmSync(missing + "/configs/.chezmoitemplates/loadout/machine");
  contains(refusal(missing), "configs/.chezmoitemplates/loadout/machine is missing — run: loadout compile");

  const edited = repo();
  put(edited + "/configs/.chezmoitemplates/loadout/machine", "{{ .chezmoi.hostname }}\n");
  contains(refusal(edited), "configs/.chezmoitemplates/loadout/machine doesn't match loadout.lock.json");
});

test("the templates' data holds the defaults and every machine", () => {
  const m = { ...manifest(""), data: new Map([["work", false]]) };
  const tree = parseJSON(renderChezmoiData(m)) as JSONObject;
  const loadout = tree.get("loadout") as JSONObject;
  expect([...loadout.keys()]).toEqual(["defaults", "machines"]);
  expect(jsonString((loadout.get("defaults") as JSONObject).get("work")!)).toBe("false");
  const machines = loadout.get("machines");
  expect(isJSONObject(machines) && [...machines.keys()]).toEqual(["m"]);
});

test("no lock says to compile", () => {
  const root = tempDir();
  contains(refusal(root), "no loadout.lock.json in " + root + " — run: loadout compile");
});

test("an edit the lock hasn't seen is refused", () => {
  const root = repo();
  put(root + "/programs/cli.loadout.ts", "# edited\n");
  contains(refusal(root), "the manifests changed since loadout.lock.json was written — run: loadout compile");

  // A new source file counts too.
  const added = repo();
  put(added + "/programs/new.loadout.ts", "\n");
  contains(refusal(added), "run: loadout compile");

  // Files no source glob matches don't.
  const other = repo();
  put(other + "/README.md", "hi\n");
  load(other, "");
});

test("a newer lock format says to upgrade", () => {
  const root = repo();
  const path = root + "/loadout.lock.json";
  put(path, readFileSync(path, "utf8").replace(`"format": 1`, `"format": 2`));
  contains(refusal(root), "lock format 2", "run: loadout self-upgrade");
});

test("a lock from a newer minor is refused and a newer patch is not", () => {
  const [major, minor, patch] = versions();
  const newer = `${major}.${minor + 1}.0`;
  contains(refusal(repo({ toolVersion: newer })), `loadout.lock.json was compiled by loadout ${newer} (you have ${VERSION})`, "run: loadout self-upgrade");
  load(repo({ toolVersion: `${major}.${minor}.${patch + 1}` }), "");
  load(repo({ toolVersion: "0.1.0" }), "");
});

test("a newer minor's field is refused by version, not by the field", () => {
  const [major, minor] = versions();
  const newer = `${major}.${minor + 1}.0`;
  const root = repo({ toolVersion: newer });
  const path = root + "/loadout.lock.json";
  put(path, readFileSync(path, "utf8").replace(`"manifest": {`, `"manifest": {\n    "fromTheFuture": true,`));
  contains(refusal(root), "was compiled by loadout " + newer, "run: loadout self-upgrade");
});

// ─── a child repo's parent (contract 18) ─────────────────────────

const parentSources = ["loadout.ts"];

/**
 * child is a child repo whose parent, at ~/dots, declares a script whose
 * file is there; it returns the child's root and $HOME.
 */
function child(): [root: string, home: string] {
  const home = tempDir();
  const parentDir = home + "/dots";
  put(parentDir + "/loadout.ts", "repo {}\n");
  put(parentDir + "/lib/helper.sh", "#!/bin/sh\n");
  const parent = newParentLayout({ name: "dotfiles", path: "~/dots", state: "state", sources: parentSources, hash: hash(parentDir, parentSources) });
  const m = manifestOf((b) => {
    b.meta("child", "");
    b.script("helper", { file: "helper.sh", check: `file:helper.sh check "$@"`, origin: "parent:lib" });
    b.machine("work", newMachineConfig({ scripts: ["helper"] }));
  });
  const root = tempDir();
  put(root + "/loadout.ts", "repo {}\n");
  const withLayout = { ...m, layout: newRepoLayout({ state: "state", sources, parent }) };
  put(root + "/loadout.lock.json", encodeLock({ format: 0, toolVersion: VERSION, sources: hash(root, sources), manifest: withLayout }));
  return [root, home];
}

function childRefusal(root: string, home: string): string {
  try {
    loadRepo(root, home);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("loaded");
}

test("a child loads with its parent at its path", () => {
  const [root, home] = child();
  expect(load(root, home).scripts.get("helper")!.origin).toBe("parent:lib");
  expect(parentRoot(root, readLayout(root), home)).toBe(realpathSync(home + "/dots"));
  expect(parentChanged(root, home)).toBe(false);
});

test("a parent edit the child hasn't compiled is refused", () => {
  const [root, home] = child();
  put(home + "/dots/loadout.ts", "# edited\n");
  contains(childRefusal(root, home), "parent dotfiles: the manifests changed since loadout.lock.json was written — run: loadout compile");
  expect(parentChanged(root, home)).toBe(true);
});

test("a missing parent or parent file is named", () => {
  const [gone, home] = child();
  rmSync(home + "/dots", { recursive: true });
  contains(childRefusal(gone, home), "parent dotfiles is not at ~/dots — clone it there");

  const [noFile, home2] = child();
  rmSync(home2 + "/dots/lib/helper.sh");
  contains(childRefusal(noFile, home2), "scripts.helper: file 'helper.sh' not found (relative to parent:lib/)");
});

test("the repo's version floor is enforced", () => {
  contains(refusal(repo({ manifest: manifest("999.0.0") })), "requires loadout >= 999.0.0", "run: loadout self-upgrade");
  load(repo({ manifest: manifest(VERSION) }), "");
});

test("a too-old binary is its own refusal naming the version needed", () => {
  const [major, minor] = versions();
  const tooOld = (root: string) => {
    try {
      loadRepo(root, "");
    } catch (e) {
      return e instanceof ToolTooOldException ? e.required : `not too old: ${String(e)}`;
    }
    return "loaded";
  };
  expect(tooOld(repo({ manifest: manifest("999.0.0") }))).toBe("999.0.0");
  const newer = `${major}.${minor + 1}`;
  expect(tooOld(repo({ toolVersion: newer + ".3" }))).toBe(newer + ".0");
  expect(toolTooOld(repo({ manifest: manifest("999.0.0") }))).toBe(true);
  expect(toolTooOld(repo())).toBe(false);
  expect(toolTooOld(repo({ files: [] }))).toBe(false);
});

test("a file the lock names must still exist", () => {
  contains(refusal(repo({ files: [] })), "programs.git.install.custom: file 'install-git.sh' not found (relative to the repo root)");
});

test("not a lock is refused cleanly", () => {
  const root = repo();
  put(root + "/loadout.lock.json", "not a lock\n");
  contains(refusal(root), "run: loadout compile");
});

test("every loadout failure reports as a clean one-liner", () => {
  // main reports a Refusal and nothing else of ours; a type that isn't one
  // would reach the user as something else.
  const ours: Error[] = [
    new ManifestException("x"),
    new ToolTooOldException("x", ""),
    new ResolutionException("x"),
    new UpgradeException("x"),
    new ConfigException("x"),
    new GitException("x"),
    new InterruptedByUser(),
  ];
  for (const e of ours) expect(isRefusal(e)).toBe(true);
  expect(new InterruptedByUser().message).toBe("interrupted");
});
