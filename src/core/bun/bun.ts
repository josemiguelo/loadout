// The bun module makes loadout the bun of the commands it runs. A compiled bun
// executable started with BUN_BE_BUN=1 is the bun CLI it was built with, so
// loadout keeps a `bun` wrapper (`BUN_BE_BUN=1 exec <loadout> "$@"`) in
// $XDG_DATA_HOME/loadout/bin and puts that folder first on PATH for every
// manifest command and for compile's run of loadout.ts (exec.CommandFrame):
// a `#!/usr/bin/env bun` script runs on a machine that has nothing
// installed yet, with the bun this loadout was built with (Bun.version).
// The wrapper's preload carries the SDKs, so "loadout" and "loadout/script"
// are loadout's own modules in every file it runs.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileError, joinPath } from "../../model/index.ts";
import { envVar } from "../platform/platform.ts";
// The SDKs' text, which bun inlines (`bun build --compile` too). TypeScript
// types these imports as the modules themselves, which have no default.
// @ts-expect-error a text import's default is the file's text
import SDKText from "../../compile/sdk/loadout.sdk.ts" with { type: "text" };
// @ts-expect-error a text import's default is the file's text
import ScriptSDKText from "../../compile/sdk/loadout.script.ts" with { type: "text" };

/**
 * binVar names a bun binary to run instead of loadout itself (a CI
 * runner's, the developer's): the wrapper execs it, with the same preload,
 * for compile and every manifest command.
 */
export const binVar = "LOADOUT_BUN";

/** beBunVar is what makes a compiled bun executable the bun CLI. */
export const beBunVar = "BUN_BE_BUN";

/** version is the bun manifest commands run with: the one loadout was built with. */
export const version: string = Bun.version;

/**
 * home is the folder of loadout's bun wrapper: $XDG_DATA_HOME/loadout/bin,
 * else ~/.local/share/loadout/bin. Throws when HOME isn't set either.
 */
export function home(): string {
  const data = envVar("XDG_DATA_HOME");
  if (data !== undefined && data !== "") return joinPath(data, "loadout", "bin");
  const h = envVar("HOME");
  if (h === undefined || h === "") throw new Error("bun: HOME isn't set, so there's nowhere to keep it");
  return joinPath(h, ".local", "share", "loadout", "bin");
}

/**
 * sdkModules is each SDK module's name and source text: what manifests
 * (`"loadout"`) and TypeScript scripts (`"loadout/script"`) import, embedded
 * in the binary. A repo holds only their types (compile's typesFile).
 */
export const sdkModules: readonly (readonly [name: string, text: string])[] = [
  ["loadout", SDKText as string],
  ["loadout/script", ScriptSDKText as string],
];

/**
 * preloadFile is the module the wrapper preloads when bun runs a file. It
 * drops BUN_BE_BUN (bun leaves it set), so what a script starts, loadout
 * itself or any other bun-compiled tool, is itself rather than bun; and it
 * registers the SDKs as modules (Bun.plugin's virtual modules), so a file
 * importing "loadout" gets this loadout's, one instance per process, from
 * a repo's files and a parent's alike. A dot file, not executable: the
 * folder is on PATH.
 */
export const preloadFile = ".preload.js";

/** preload is preloadFile's text. */
export const preload =
  "delete process.env." + beBunVar + ";\n" +
  "const modules = " + JSON.stringify(Object.fromEntries(sdkModules)) + ";\n" +
  "Bun.plugin({\n" +
  '  name: "loadout",\n' +
  "  setup(build) {\n" +
  '    for (const [name, contents] of Object.entries(modules)) build.module(name, () => ({ contents, loader: "ts" }));\n' +
  "  },\n" +
  "});\n";

/**
 * wrapper is the `bun` script that runs self (an executable's path) as the
 * bun CLI, with folder's preloadFile when it runs a file (`bun x.ts`, a
 * shebang's `bun /path/x.ts`, `bun run x.ts`). With $LOADOUT_BUN set, it
 * execs that bun instead, the same way.
 */
export function wrapper(self: string, folder: string): string {
  const pre = quote(joinPath(folder, preloadFile));
  return (
    "#!/bin/sh\n" +
    'if [ "$1" = run ] && [ -f "$2" ]; then shift; set -- run --preload ' + pre + ' "$@"\n' +
    'elif [ -f "$1" ]; then set -- --preload ' + pre + ' "$@"\n' +
    "fi\n" +
    'if [ -n "$' + binVar + '" ]; then exec "$' + binVar + '" "$@"; fi\n' +
    beBunVar + "=1 exec " + quote(self) + ' "$@"\n'
  );
}

/**
 * ensure is the folder whose `bun` manifest commands and compile run:
 * wrapperDir's. A $LOADOUT_BUN that isn't an executable is refused here,
 * before anything runs with it.
 */
export function ensure(self: string = process.execPath): string {
  const bin = envVar(binVar);
  if (bin !== undefined && bin !== "" && !isExecutable(bin)) throw new Error(binVar + "=" + bin + " isn't an executable bun");
  return wrapperDir(self);
}

/**
 * wrapperDir is home() with the wrapper for self and its preload, each
 * written when it's missing or different. They go in through a rename, so a
 * loadout running at the same time never sees half a file.
 */
export function wrapperDir(self: string = process.execPath): string {
  const folder = home();
  put(folder, preloadFile, preload, 0o644);
  put(folder, "bun", wrapper(self, folder), 0o755);
  return folder;
}

function put(folder: string, name: string, text: string, mode: number) {
  const target = joinPath(folder, name);
  if (readText(target) === text && ((mode & 0o111) === 0 || isExecutable(target))) return;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o755 });
  } catch (e) {
    throw new Error("couldn't set up bun in " + folder + ": " + fileError(e, "mkdir", folder).message);
  }
  const temp = joinPath(folder, ".bun-" + process.pid + "-" + Math.random().toString(36).slice(2));
  try {
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (e) {
    rmSync(temp, { force: true });
    throw new Error("couldn't set up bun in " + folder + ": " + fileError(e).message);
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function isExecutable(file: string): boolean {
  try {
    const st = statSync(file);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** quote is s as one sh word. */
function quote(s: string): string {
  return "'" + s.replaceAll("'", `'\\''`) + "'";
}
