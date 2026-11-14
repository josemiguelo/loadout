// sdktypes makes src/compile/sdk/loadout.d.ts, the types compile and init
// write into every repo: the SDKs' declarations as the pinned TypeScript
// (package.json's devDependency) emits them from the sources, doc comments
// included, each module's in a `declare module` block named as repos import
// it. The binary embeds the committed file; sdktypes.test.ts fails when it
// differs from what the sources emit now. `bun run sdk-types` rewrites it,
// and so does `bun run build`. Never part of the binary.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** checkout is this source tree's root. */
export const checkout = join(import.meta.dir, "..", "..");

/** typesPath is the generated file, in the source tree. */
export const typesPath = join(import.meta.dir, "sdk", "loadout.d.ts");

/** modules is each SDK module's name and source, in the order the file declares them. */
export const modules: readonly (readonly [name: string, source: string])[] = [
  ["loadout", "loadout.sdk.ts"],
  ["loadout/script", "loadout.script.ts"],
];

/** tsc is the pinned TypeScript's compiler. */
export const tsc = join(checkout, "node_modules", ".bin", "tsc");

const header =
  "// loadout's types: the modules manifests import as \"loadout\" and TypeScript\n" +
  '// scripts as "loadout/script". The modules themselves are inside loadout,\n' +
  "// which provides them whenever it runs this repo's files. Written by\n" +
  "// `loadout compile` (and `loadout init`) from the loadout that compiles the\n" +
  "// repo: don't edit it, a compile puts it back.\n";

/** generate is loadout.d.ts's text, emitted from the SDK sources now. Throws when tsc fails. */
export function generate(): string {
  const out = mkdtempSync(join(tmpdir(), "loadout-sdk-types-"));
  try {
    const sources = modules.map(([, source]) => join(import.meta.dir, "sdk", source));
    const r = Bun.spawnSync(
      [
        tsc,
        "--ignoreConfig",
        "--declaration",
        "--emitDeclarationOnly",
        "--outDir",
        out,
        "--lib",
        "ESNext",
        "--target",
        "ESNext",
        "--module",
        "Preserve",
        "--moduleResolution",
        "bundler",
        "--allowImportingTsExtensions",
        "--strict",
        "--skipLibCheck",
        "--types",
        "bun",
        ...sources,
      ],
      { cwd: checkout, stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) throw new Error("tsc: " + (r.stdout.toString() + r.stderr.toString()).trim());
    const blocks = modules.map(([name, source]) => wrap(name, readFileSync(join(out, source.replace(/\.ts$/, ".d.ts")), "utf8")));
    return header + "\n" + blocks.join("\n");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * wrap is one module's emitted declarations as `declare module "name"`:
 * indented by two (tsc's four become two, as the sources write them),
 * without the `declare` a statement can't repeat inside it.
 */
function wrap(name: string, dts: string): string {
  const body = dts
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => line.replace(/^(?: {4})+/, (indent) => " ".repeat(indent.length / 2)))
    .map((line) => line.replace(/^export declare /, "export ").replace(/^declare /, ""))
    .map((line) => (line === "" ? line : "  " + line));
  return "declare module " + JSON.stringify(name) + " {\n" + body.join("\n") + "\n}\n";
}

/**
 * typeCheck is tsc's output and exit code over a repo of files (path →
 * text), written into a new folder that sees this checkout's node_modules
 * (bun's types), as a config repo does after `bun install`: what an editor
 * reports there. For tests.
 */
export function typeCheck(files: Record<string, string>): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "loadout-types-"));
  try {
    symlinkSync(join(checkout, "node_modules"), join(dir, "node_modules"));
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    const r = Bun.spawnSync([tsc, "--noEmit", "-p", "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) writeFileSync(typesPath, generate());
