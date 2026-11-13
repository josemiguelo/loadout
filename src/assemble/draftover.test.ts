import { expect, test } from "bun:test";
import { mapOf, newManifest, newMeta, newProgram, newRepoLayout, sortedMap } from "../model/index.ts";
import { assembleWithoutFiles, type ManifestDraft, newManifestDraft } from "./assemble.ts";
import { contains, custom, data, machine, pm, profile, programs } from "./testhelpers.ts";
import { declaredNames, draftOver } from "./draftover.ts";

// A child repo's draft over its parent's declarations (contract 18), as
// `loadout compile` builds it.

/** parentDraft is the parent: a program, a profile, a machine of its own and a data schema. */
function parentDraft(): ManifestDraft {
  return newManifestDraft({
    manifest: newManifest({
      meta: newMeta({ name: "dots", minToolVersion: "3.1.0" }),
      layout: newRepoLayout({ state: "state", configs: "configs" }),
      data: data(["work", false]),
      programs: programs(
        ["git", newProgram({ install: custom("true"), origin: "parent:programs" })],
        // Declared at the repo root, in the parent: the parent's root.
        ["htop", newProgram({ install: custom("true"), origin: "parent:" })],
      ),
      machines: mapOf(machine("laptop", { extends: ["base"], pm: pm("htop", "custom") })),
    }),
    profiles: mapOf(profile("base", { pm: pm("git", "custom") })),
    requires: mapOf(["brew", ["git"]]),
  });
}

test("a child machine uses the parent's declarations but not its machines", () => {
  const child = newManifestDraft({
    manifest: newManifest({
      meta: newMeta({ name: "work", minToolVersion: "3.3.0" }),
      layout: newRepoLayout({ state: "state" }),
      programs: programs(["worktool", newProgram({ install: custom("true"), origin: "programs" })]),
      machines: mapOf(machine("work-mac", { extends: ["base"], pm: pm("worktool", "custom"), data: data(["work", true]) })),
    }),
    requires: mapOf(["brew", ["worktool", "git"]]),
  });
  const [draft, errors] = draftOver(child, parentDraft(), "dotfiles");
  expect(errors).toEqual([]);
  const manifest = assembleWithoutFiles(draft);
  expect([...manifest.machines.keys()]).toEqual(["work-mac"]);
  expect([...sortedMap(manifest.machines.get("work-mac")!.pm).keys()]).toEqual(["git", "worktool"]);
  const ps = manifest.programs;
  expect([ps.get("git")!.origin, ps.get("htop")!.origin, ps.get("worktool")!.origin]).toEqual(["parent:programs", "parent:", "programs"]);
  expect(manifest.machines.get("work-mac")!.data.get("work")).toBe(true);
  // The floor is the higher of the two; meta and layout are the child's.
  expect([manifest.meta.minToolVersion, manifest.meta.name, manifest.layout.configs]).toEqual(["3.3.0", "work", undefined]);
  expect(draft.requires.get("brew")).toEqual(["git", "worktool"]);
  // The parent's floor wins when it's higher.
  child.manifest.meta = { ...child.manifest.meta, minToolVersion: undefined };
  const [over] = draftOver(child, parentDraft(), "dotfiles");
  expect(over.manifest.meta.minToolVersion).toBe("3.1.0");
});

test("a child's bun wins, and without one it runs the parent's", () => {
  const parent = parentDraft();
  parent.manifest.meta = { ...parent.manifest.meta, bun: "1.2.0" };
  const child = newManifestDraft({
    manifest: newManifest({ meta: newMeta({ name: "work", bun: "1.3.0" }), layout: newRepoLayout({ state: "state" }) }),
  });
  let [over, errs] = draftOver(child, parent, "dotfiles");
  expect(errs).toEqual([]);
  expect(over.manifest.meta.bun).toBe("1.3.0");
  child.manifest.meta = { ...child.manifest.meta, bun: undefined };
  [over] = draftOver(child, parent, "dotfiles");
  expect(over.manifest.meta.bun).toBe("1.2.0");
});

test("a name both repos declare is refused naming the parent", () => {
  const child = newManifestDraft({
    manifest: newManifest({
      layout: newRepoLayout({ state: "state" }),
      programs: programs(["git", newProgram({ install: custom("true") })]),
      machines: mapOf(machine("laptop", {})),
    }),
  });
  const [, errors] = draftOver(child, parentDraft(), "dotfiles");
  contains(
    errors.join("\n"),
    "program 'git' is declared by parent dotfiles too",
    "machine 'laptop' is declared by parent dotfiles too — a machine belongs to one repo",
  );
});

test("a child can't declare a data schema", () => {
  const child = newManifestDraft({ manifest: newManifest({ layout: newRepoLayout({ state: "state" }), data: data(["secret", false]) }) });
  const [, errors] = draftOver(child, parentDraft(), "dotfiles");
  contains(errors.join("\n"), "a child repo's data schema is its parent's — drop its data {} block");
});

test("declared names are what warnings call", () => {
  expect(declaredNames(parentDraft())).toEqual(["program 'git'", "program 'htop'", "profile 'base'"]);
});
