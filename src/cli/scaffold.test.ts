import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderScaffold } from "./init.ts";
import { scaffoldTexts } from "./scaffold.ts";

const folder = fileURLToPath(new URL("./scaffold/", import.meta.url));

test("the embedded scaffolds are the scaffold folder's files, byte for byte", () => {
  const onDisk: Record<string, Record<string, string>> = {};
  for (const kind of readdirSync(folder)) {
    onDisk[kind] = {};
    for (const e of readdirSync(folder + kind, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const full = e.parentPath + "/" + e.name;
      onDisk[kind][full.slice((folder + kind + "/").length)] = readFileSync(full, "utf8");
    }
  }
  const sorted = (r: Record<string, Record<string, string>>) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort())]));
  expect(sorted(scaffoldTexts)).toEqual(sorted(onDisk));
});

test("a scaffold's files come in Go's walk order, the SDKs last", () => {
  const files = renderScaffold("init", { hostname: "box", parentName: "", parentPath: "", parentImport: "" });
  expect(files.map((f) => f.path)).toEqual([
    ".gitignore",
    "loadout.ts",
    "machines/data.ts",
    "machines/machines.loadout.ts",
    "machines/state/.gitkeep",
    "maintenance/.gitkeep",
    "package.json",
    "programs/cli.loadout.ts",
    "tsconfig.json",
    "loadout.sdk.ts",
    "loadout.script.ts",
  ]);
});
