import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderScaffold } from "./init.ts";
import { scaffoldTexts } from "./scaffold.ts";
import { typeCheck } from "../compile/sdktypes.ts";

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

test("a scaffold's files come in walk order, the SDKs' types last", () => {
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
    "node_modules/@types/loadout/package.json",
    "node_modules/@types/loadout/index.d.ts",
  ]);
});

test("every scaffold type-checks against the node_modules/@types/loadout init writes, and only with it", () => {
  for (const kind of ["init", "init-configs", "child", "child-configs"]) {
    const files = renderScaffold(kind, { hostname: "box", parentName: "dad", parentPath: "../dad", parentImport: "../dad" });
    const repo = Object.fromEntries(files.map((f) => [f.path, f.content]));
    expect(typeCheck(repo)).toEqual({ code: 0, out: "" });
    delete repo["node_modules/@types/loadout/index.d.ts"];
    expect(typeCheck(repo).out).toContain("error TS2307: Cannot find module 'loadout'");
  }
});
