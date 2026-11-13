import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assembleWithoutFiles, type ManifestDraft, newManifestDraft } from "../assemble/index.ts";
import { type Manifest, mapOf, newMachineConfig, newProgram, newScriptStep } from "../model/index.ts";
import { via, pm } from "../assemble/testhelpers.ts";
import { compile, decodeDraft, doneScripts, writeIfChanged } from "./compile.ts";
import { transitionalWarnings, unusedWarnings } from "./unused.ts";

/** draftOf assembles d (no file checks), for the warnings. */
function draftOf(d: ManifestDraft): [ManifestDraft, Manifest] {
  if (d.manifest.layout.state === "") d = { ...d, manifest: { ...d.manifest, layout: { ...d.manifest.layout, state: "state" } } };
  return [d, assembleWithoutFiles(d)];
}

function contains(got: readonly string[], want: string): void {
  if (!got.some((g) => g.includes(want))) throw new Error(`no warning saying ${JSON.stringify(want)} in ${JSON.stringify(got)}`);
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "compile-test-"));
}

describe("the draft", () => {
  test("a draft carries the manifest and what only compile reads", () => {
    const d = decodeDraft(`{
      "manifest": {"layout": {"state": "machines/state"}, "programs": {"git": {"install": {"dnf": {}}, "origin": "programs"}}},
      "profiles": {"base": {"pm": {"git": "dnf"}}},
      "requires": {"dnf": ["git"]},
      "spares": {"program 'git'": "kept"},
      "transitional": ["cleanup"],
      "parent": {"name": "dots", "path": "~/dots"}
    }`);
    expect(d.manifest.programs.get("git")?.origin).toBe("programs");
    // A profile's label: assembly's messages name it.
    expect(d.profiles.get("base")!.label).toBe("profile 'base'");
    expect(d.profiles.get("base")!.pm.get("git")).toBe("dnf");
    expect(d.requires.get("dnf")).toEqual(["git"]);
    expect(d.spares.get("program 'git'")).toBe("kept");
    expect(d.transitional).toEqual(["cleanup"]);
    expect(d.parent).toEqual({ name: "dots", path: "~/dots" });
  });

  test("what isn't a draft is refused as such", () => {
    for (const text of ["not json", `{"manifest": {"programs": 3}}`]) {
      expect(() => decodeDraft(text)).toThrow();
    }
  });

  test("a draft's JSON errors are worded as Go's json.Unmarshal words them", () => {
    const cases: [string, string][] = [
      ["not json", "invalid character 'o' in literal null (expecting 'u')"],
      [`{"a":`, "unexpected end of JSON input"],
      ["{} {}", "invalid character '{' after top-level value"],
      ["{} 1", "invalid character '1' after top-level value"],
      [`{"spares": [1]}`, "json: cannot unmarshal array into Go struct field .spares of type map[string]string"],
      [`{"spares": {"a": 1}}`, "json: cannot unmarshal number into Go struct field .spares.a of type string"],
      [`{"transitional": ["a", {}]}`, "json: cannot unmarshal object into .transitional.1 of type string"],
      [`{"parent": "x"}`, "json: cannot unmarshal string into Go struct field .parent of type tsmanifest.ParentRef"],
    ];
    for (const [text, want] of cases) {
      expect(() => decodeDraft(text)).toThrow("loadout.ts printed something that isn't a manifest: " + want);
    }
  });
});

describe("compile, before bun runs", () => {
  test("a repo still in HCL or Kotlin is refused by name", async () => {
    for (const [file, want] of [
      ["loadout.hcl", "manifests are HCL"],
      ["loadout.kt", "manifests are Kotlin"],
    ]) {
      const root = tempDir();
      fs.writeFileSync(path.join(root, file!), "");
      await expect(compile(root)).rejects.toThrow(want);
    }
    await expect(compile(tempDir())).rejects.toThrow("has no loadout.ts");
  });

  test("compile writes only under the root and only what changed", () => {
    const root = tempDir();
    expect(() => writeIfChanged(root, path.join(path.dirname(root), "outside"), "x")).toThrow();
    const target = path.join(root, "sub", "f");
    writeIfChanged(root, target, "one");
    const before = fs.statSync(target).mtimeMs;
    const earlier = new Date(before - 3600e3);
    fs.utimesSync(target, earlier, earlier);
    writeIfChanged(root, target, "one");
    // A file that already held the text isn't rewritten.
    expect(fs.statSync(target).mtimeMs).toBeLessThan(before);
  });
});

describe("warnings", () => {
  test("what no machine uses is named and spare silences it", () => {
    const [draft, manifest] = draftOf(
      newManifestDraft({
        manifest: {
          ...newManifestDraft().manifest,
          programs: mapOf(["git", newProgram({ install: via("dnf") })], ["htop", newProgram({ install: via("dnf") })]),
          scripts: mapOf(["hello", newScriptStep({ run: "true" })]),
          machines: mapOf(["m", newMachineConfig({ pm: pm("git", "dnf"), label: "machine 'm'" })]),
        },
        profiles: mapOf(["unused", newMachineConfig()]),
      }),
    );

    let warnings = unusedWarnings(draft, manifest, new Map(), []);
    contains(warnings, "program 'htop' isn't installed on any machine");
    contains(warnings, "script 'hello' isn't run on any machine");
    contains(warnings, "profile 'unused'");

    const spares = mapOf(["program 'htop'", "kept for later"], ["program 'git'", "but it's used"]);
    warnings = unusedWarnings(draft, manifest, spares, []);
    // A spare program isn't named.
    expect(warnings.filter((w) => w.includes("htop"))).toEqual([]);
    contains(warnings, "program 'git' is marked spare");
  });

  test("a child's warnings are about its own declarations", () => {
    const [draft, manifest] = draftOf(
      newManifestDraft({
        manifest: {
          ...newManifestDraft().manifest,
          programs: mapOf(["parents", newProgram({ install: via("dnf"), origin: "parent:programs" })]),
          machines: mapOf(["m", newMachineConfig({ label: "machine 'm'" })]),
        },
      }),
    );
    expect(unusedWarnings(draft, manifest, new Map(), ["program 'parents'"])).toEqual([]);
  });

  test("a transitional script every runner has done is named for deletion", () => {
    const [, manifest] = draftOf(
      newManifestDraft({
        manifest: {
          ...newManifestDraft().manifest,
          scripts: mapOf(["cleanup", newScriptStep({ run: "true", check: "true" })]),
          machines: mapOf(
            ["a", newMachineConfig({ scripts: ["cleanup"], label: "machine 'a'" })],
            ["b", newMachineConfig({ scripts: ["cleanup"], label: "machine 'b'" })],
          ),
        },
      }),
    );

    const done = new Map([
      ["a", new Set(["cleanup"])],
      ["b", new Set(["cleanup"])],
    ]);
    contains(transitionalWarnings(manifest, ["cleanup"], done), "script 'cleanup' is done on every machine that runs it (a, b)");
    done.get("b")!.delete("cleanup");
    // One runner not done: not named.
    expect(transitionalWarnings(manifest, ["cleanup"], done)).toEqual([]);
  });

  test("a state file says which scripts a machine has done", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "a.json"), `{"scripts": {"cleanup": {"status": "done"}, "other": {"status": "pending"}}}`);
    const done = doneScripts(dir, ["a", "missing"]);
    expect(done.get("a")!.has("cleanup")).toBe(true);
    expect(done.get("a")!.has("other")).toBe(false);
    expect(done.get("missing")!.size).toBe(0);
  });
});
