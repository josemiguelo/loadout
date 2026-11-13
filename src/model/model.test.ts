import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chezmoiDataFiles, chezmoiPartial, renderChezmoiData } from "./chezmoidata.ts";
import { type Errs, programToJSON, readProgram, readScript, scriptToJSON } from "./codec.ts";
import { mapFS } from "./fsys.ts";
import { globExpand, globMatches, globProblem } from "./glob.ts";
import { type JSONValue, jsonString, kotlinDouble } from "./json.ts";
import { decodeLock, encodeLock, type Lock, sourcesHash } from "./lock.ts";
import { dataConflicts, mergeData, validateData } from "./machinedata.ts";
import {
  expandFilePrefix,
  fileLine,
  forMachine,
  newInstaller,
  newInstallVariant,
  newMachineConfig,
  newManifest,
  newParentLayout,
  newProgram,
  newRepoLayout,
  newScriptStep,
  parentRoot,
  providedFolders,
  runsIn,
  scriptEntry,
  shellLine,
  shownLine,
  toolPathOf,
} from "./manifest.ts";
import { mapOf } from "./map.ts";
import { isRefusal, ManifestException, ToolTooOldException } from "./refusal.ts";

const testdata = import.meta.dir + "/../../internal/model/testdata/";

function read(name: string): string {
  return readFileSync(testdata + name, "utf8");
}

function decodeTestLock(): Lock {
  return decodeLock(read("loadout.lock.json"));
}

/** firstDiff points at where two texts part, for a readable failure. */
export function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 80);
  return `at ${i}:\n--- got\n${a.slice(from, i + 80)}\n--- want\n${b.slice(from, i + 80)}`;
}

function expectSame(got: string, want: string): void {
  if (got !== want) throw new Error("differs " + firstDiff(got, want));
}

function errorOf(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("no error thrown");
}

test("the real lock round-trips byte for byte", () => {
  expectSame(encodeLock(decodeTestLock()), read("loadout.lock.json"));
});

test("chezmoi data is byte-identical", () => {
  const lock = decodeTestLock();
  expectSame(renderChezmoiData(lock.manifest), read("chezmoidata.json"));
  expectSame(chezmoiPartial, read("machine.partial"));
  const files = chezmoiDataFiles(lock.manifest, "loadouts");
  expect([...files.keys()]).toEqual(["loadouts/.chezmoidata/loadout.json", "loadouts/.chezmoitemplates/loadout/machine"]);
});

test("a decoded lock reads the model", () => {
  const m = decodeTestLock().manifest;
  expect(m.meta.name).toBe("jm's machines");
  expect(m.meta.minToolVersion).toBe("3.4.0");
  expect(m.layout.state).toBe("machines/state");
  expect(m.layout.configs).toBe("loadouts");
  const brew = m.installers.get("brew")!;
  expect(brew.probe).toBe("brew");
  expect(brew.requires).toEqual(["setup-brew"]);
  expect(m.machines.size).toBeGreaterThan(0);
  expect(m.data.size).toBeGreaterThan(0);
});

test("the lock round-trips", () => {
  const m = newManifest({
    layout: newRepoLayout({ state: "state" }),
    programs: mapOf(["jq", newProgram({ install: mapOf(["brew", newInstallVariant()]) })]),
    scripts: mapOf(
      ["a", newScriptStep({ run: "true" })],
      ["b", newScriptStep({ run: 'x\n"y"\x01', modes: [] })],
      ["c", newScriptStep({ run: "<&>", modes: ["setup"] })],
    ),
    machines: mapOf(["m", newMachineConfig({ pm: mapOf(["jq", "brew"]) })]),
  });
  const text = encodeLock({ format: 0, toolVersion: "3.0.0", sources: "abc", manifest: m });
  const lock = decodeLock(text);
  expectSame(encodeLock(lock), text);
  expect([lock.format, lock.toolVersion, lock.sources]).toEqual([1, "3.0.0", "abc"]);
  expect(lock.manifest.scripts.get("b")!.modes).toEqual([]);
  expect(runsIn(lock.manifest.scripts.get("a")!, "maintain")).toBe(true);
  for (const want of ['"format": 1,', '"run": "x\\n\\"y\\"\\u0001"', '"run": "<&>"', '"modes": []', '"brew": {}']) {
    expect(text).toContain(want);
  }
  expect(text.split('"modes"').length - 1).toBe(2);
});

test("a newer lock format is refused by name", () => {
  const err = errorOf(() => decodeLock(`{"format": 99, "toolVersion": "9.0.0", "sources": "", "manifest": {}}`));
  expect(err).toBeInstanceOf(ManifestException);
  expect(err.message).toBe("loadout.lock.json was written by a newer loadout (lock format 99) — run: loadout self-upgrade");
});

test("the tool version is checked before the body", () => {
  let seen = "";
  const err = errorOf(() =>
    decodeLock(`{"toolVersion": "9.0.0", "sources": "", "manifest": {"future": 1}}`, "x.json", (v) => {
      seen = v;
      throw new ToolTooOldException("too old", v);
    }),
  );
  expect(seen).toBe("9.0.0");
  expect(err.message).toBe("too old");
  const err2 = errorOf(() => decodeLock(`{"toolVersion": "9.0.0", "sources": "", "manifest": {"future": 1}}`, "x.json"));
  expect(err2.message.startsWith("x.json can't be read (Encountered an unknown key 'future'")).toBe(true);
  expect(err2.message.endsWith("— run: loadout compile")).toBe(true);
});

test("an unreadable lock says so", () => {
  const cases: Record<string, string> = {
    "{": "loadout.lock.json is not valid JSON (",
    "[]": "loadout.lock.json is not a lock file — run: loadout compile",
    '{"sources": "", "manifest": {}}': "loadout.lock.json can't be read (Field 'toolVersion' is required",
  };
  for (const [text, want] of Object.entries(cases)) {
    const err = errorOf(() => decodeLock(text));
    expect(err.message.startsWith(want)).toBe(true);
    expect(isRefusal(err)).toBe(true);
  }
});

test("sources hash covers path and content in path order", () => {
  const files: Record<string, string> = {
    "loadout.hcl": "repo {}\n",
    "b/x.loadout.hcl": "b",
    "a/.y.loadout.hcl": "a",
    "a/z.txt": "no",
    ".git/q.loadout.hcl": "no",
    "a/.git/q.loadout.hcl": "no",
    "a/deep/w.loadout.hcl": "w",
  };
  const repo = mapFS(files);
  const got = sourcesHash(repo, ["loadout.hcl", "**/*.loadout.hcl", "a/**/.*.loadout.hcl", "loadout.hcl"]);
  const h = createHash("sha256");
  for (const f of ["a/.y.loadout.hcl", "a/deep/w.loadout.hcl", "b/x.loadout.hcl", "loadout.hcl"]) {
    h.update(f + "\x00" + files[f] + "\x00");
  }
  expect(got).toBe(h.digest("hex"));
  expect(sourcesHash(repo, undefined)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("matching follows the source rules", () => {
  // As the SDK's include() (Bun.Glob with dot files): wildcards match dot
  // entries, and ** enters dot folders.
  const yes = [
    ["programs/**/*.loadout.ts", "programs/a.loadout.ts"],
    ["programs/**/*.loadout.ts", "programs/x/y/a.loadout.ts"],
    ["programs/?.ts", "programs/a.ts"],
    ["programs/*.ts", "programs/.hidden.ts"],
    ["loadouts/**/*.loadout.ts", "loadouts/private_dot_config/tmux/.tmux.loadout.ts"],
    ["loadouts/**/*.loadout.ts", "loadouts/a/.t/.t.loadout.ts"],
    ["loadouts/**/*.loadout.ts", "loadouts/.etc/t2/.t2.loadout.ts"],
  ] as const;
  const no = [
    ["programs/**/*.loadout.ts", "programs/a.loadout.ts.sample"],
    ["programs/*.ts", "programs/x/a.ts"],
    ["loadouts/**/*.loadout.ts", "machines/a.loadout.ts"],
  ] as const;
  for (const [p, path] of yes) expect([p, path, globMatches(p, path)]).toEqual([p, path, true]);
  for (const [p, path] of no) expect([p, path, globMatches(p, path)]).toEqual([p, path, false]);
});

test("expand is path-sorted and never enters .git", () => {
  const files: Record<string, string> = {};
  for (const f of [
    "programs/b.loadout.kt",
    "programs/a/z.loadout.kt",
    "programs/a.loadout.kt",
    ".git/c.loadout.kt",
    "programs/node_modules/d.loadout.kt",
  ]) {
    files[f] = "";
  }
  const repo = mapFS(files);
  expect(globExpand(repo, "programs/**/*.loadout.kt").join(" ")).toBe(
    "programs/a.loadout.kt programs/a/z.loadout.kt programs/b.loadout.kt",
  );
  // A literal path is that file or nothing; a missing base is nothing.
  expect(globExpand(repo, "programs/a.loadout.kt")).toHaveLength(1);
  expect(globExpand(repo, "nowhere/**/*.kt")).toHaveLength(0);
});

test("problems name what's wrong", () => {
  const cases: Record<string, string> = {
    "programs/**/*.kt": "",
    "/etc": "is absolute; layout paths are relative to the repo root",
    "../x": "leaves the repo (..)",
    "a//b": "has an empty path segment",
    "": "is empty",
  };
  for (const [pattern, want] of Object.entries(cases)) expect([pattern, globProblem(pattern)]).toEqual([pattern, want]);
});

test("a script entry's whitespace becomes single spaces", () => {
  expect(scriptEntry("  name\n\ta \n  b  ")).toEqual(["name", "a b"]);
});

test("shell line puts the repo bun first when set, and a shown line leaves it out", () => {
  const line = shellLine("bun x.ts", ["/opt/homebrew/bin"]);
  expect(line).toBe('PATH="${LOADOUT_BUN_DIR:+$LOADOUT_BUN_DIR:}/opt/homebrew/bin:$PATH"; export PATH; bun x.ts');
  expect(shownLine(line)).toBe('PATH="/opt/homebrew/bin:$PATH"; export PATH; bun x.ts');
});

test("shell line expands file: and puts path first", () => {
  expect(shellLine('file:x.sh check "$@"', undefined)).toBe(
    `{ l=$(head -n 1 'x.sh'); case $l in '#!'*) \${l#??} 'x.sh' check "$@";; *) sh 'x.sh' check "$@";; esac; }`,
  );
  expect(shellLine("file:x.sh", ["$HOME/.local/bin", "/opt/b"])).toBe(
    'PATH="${LOADOUT_BUN_DIR:+$LOADOUT_BUN_DIR:}$HOME/.local/bin:/opt/b:$PATH"; export PATH; ' + fileLine("x.sh", ""),
  );
  expect(expandFilePrefix("echo hi")).toBe("echo hi");
});

test("shown line gives back the script and its arguments", () => {
  expect(shownLine("set -- a; " + fileLine(".loadout/x.ts", 'check "$@"'))).toBe('set -- a; .loadout/x.ts check "$@"');
  expect(shownLine(fileLine("up.sh", "") + " && " + fileLine("b.sh", "--all"))).toBe("up.sh && b.sh --all");
  expect(shownLine("echo hi")).toBe("echo hi");
});

test("provided folders come first for scripts on the machine", () => {
  const got = providedFolders(
    mapOf(["brew", ["/opt/homebrew/bin"]], ["bun", ["/opt/homebrew/bin", "$HOME/.bun/bin"]]),
  );
  expect(got.join(":")).toBe("/opt/homebrew/bin:$HOME/.bun/bin");
});

test("data merges tables and replaces the rest", () => {
  const base = mapOf<JSONValue>(["a", true], ["k", mapOf<JSONValue>(["x", "1"], ["y", "2"])], ["l", ["a"]]);
  const over = mapOf<JSONValue>(["k", mapOf<JSONValue>(["y", "3"])], ["l", ["b"]], ["n", kotlinDouble(1)]);
  expect(jsonString(mergeData(base, over))).toBe(`{"a":true,"k":{"x":"1","y":"3"},"l":["b"],"n":1.0}`);
  expect(dataConflicts(base, over, "").join(",")).toBe("k.y,l");
  const errs = validateData(base, mapOf<JSONValue>(["a", "yes"], ["k", mapOf<JSONValue>(["z", "1"])]), "machine 'm'", "");
  expect(errs).toEqual([
    "machine 'm': data key 'a' is a string, but the data schema declares a boolean",
    "machine 'm': data key 'k.z' is not declared in the data schema",
  ]);
});

test("Kotlin doubles read as Kotlin writes them", () => {
  const cases: [number, string][] = [
    [0.85, "0.85"],
    [1, "1.0"],
    [0, "0.0"],
    [1e7, "1.0E7"],
    [1.5e-4, "1.5E-4"],
    [-2.5, "-2.5"],
    [123456.0, "123456.0"],
  ];
  for (const [f, want] of cases) expect([f, kotlinDouble(f).text]).toEqual([f, want]);
});

test("a machine sees its script variant and tool paths", () => {
  const m = newManifest({
    programs: mapOf([
      "setup-brew",
      newProgram({
        install: mapOf([
          "linux",
          newInstallVariant({
            command: "x",
            provides: [{ binary: "brew", at: "/home/linuxbrew/.linuxbrew/bin" }, { binary: "flatpak" }],
          }),
        ]),
      }),
    ]),
    installers: mapOf(["brew", newInstaller({ probe: "brew", install: "brew install {pkg}", upgrade: "brew upgrade" })]),
    scripts: mapOf([
      "keyboard",
      newScriptStep({
        description: "fn swap",
        sudo: true,
        check: "base-check",
        after: ["programs.setup-brew"],
        variants: mapOf(
          ["arch", newScriptStep({ file: "arch.sh", after: ["scripts.x", "programs.setup-brew"], origin: "k" })],
          ["fedora", newScriptStep({ file: "fedora.sh" })],
        ),
      }),
    ]),
    machines: mapOf([
      "m",
      newMachineConfig({ pm: mapOf(["setup-brew", "linux"]), scripts: ["keyboard"], scriptVariants: mapOf(["keyboard", "arch"]) }),
    ]),
  });
  const seen = forMachine(m, "m");
  const step = seen.scripts.get("keyboard")!;
  expect(step.file).toBe("arch.sh");
  expect(step.sudo).toBe(true);
  expect(step.description).toBe("fn swap");
  expect(step.check).toBe("base-check");
  expect(step.after.join(",")).toBe("programs.setup-brew,scripts.x");
  expect(step.origin).toBe("k");
  expect(step.variants.size).toBe(0);
  expect(toolPathOf(seen, "brew")).toEqual(["/home/linuxbrew/.linuxbrew/bin"]);
  // A binary without `at` has no tool path.
  expect(seen.toolPaths.has("flatpak")).toBe(false);
  // forMachine doesn't change the manifest it was called on.
  expect(m.scripts.get("keyboard")!.file).toBeUndefined();
});

test("parent root places its checkout", () => {
  const cases: Record<string, string> = { "~/dots": "/home/u/dots", "~": "/home/u", "/abs/./x": "/abs/x", "../dots": "/work/dots" };
  for (const [p, want] of Object.entries(cases)) {
    expect(parentRoot(newParentLayout({ name: "dotfiles", path: p }), "/home/u/", "/work/child")).toBe(want);
  }
  const err = errorOf(() => parentRoot(newParentLayout({ name: "dotfiles", path: "~/x" }), "", "/c"));
  expect(err.message).toBe("HOME is unset: can't place parent dotfiles at ~/x");
});

describe("later is in the lock only when set", () => {
  test("programs and scripts", () => {
    const errs: Errs = {};
    const back = readProgram(programToJSON(newProgram({ description: "Stremio", later: "a big download" })), "$", errs);
    expect(errs.err).toBeUndefined();
    expect(back.later).toBe("a big download");
    // A core program writes no later; the lock must stay as it was.
    expect(programToJSON(newProgram({ description: "git" })).has("later")).toBe(false);
    const backStep = readScript(scriptToJSON(newScriptStep({ run: "true", later: "gigabytes" })), "$", errs);
    expect(errs.err).toBeUndefined();
    expect(backStep.later).toBe("gigabytes");
    expect(scriptToJSON(newScriptStep({ run: "true" })).has("later")).toBe(false);
  });
});
