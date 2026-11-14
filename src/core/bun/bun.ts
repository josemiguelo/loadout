// The bun module makes loadout the bun of the commands it runs. A compiled bun
// executable started with BUN_BE_BUN=1 is the bun CLI it was built with, so
// loadout keeps a `bun` wrapper (`BUN_BE_BUN=1 exec <loadout> "$@"`) in
// $XDG_DATA_HOME/loadout/bin and puts that folder first on PATH for every
// manifest command and for compile's run of loadout.ts (exec.CommandFrame):
// a `#!/usr/bin/env bun` script runs on a machine that has nothing
// installed yet, with the bun this loadout was built with (Bun.version).

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cleanPath, fileError, joinPath } from "../../model/index.ts";
import { envVar } from "../platform/platform.ts";

/**
 * binVar names a bun binary to use instead of loadout itself (a CI
 * runner's, the developer's): compile and every manifest command take it
 * as it is, and its folder goes first on PATH.
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
 * preloadFile is the module the wrapper preloads when bun runs a file: it
 * drops BUN_BE_BUN (bun leaves it set), so what a script starts, loadout
 * itself or any other bun-compiled tool, is itself rather than bun. A dot
 * file, not executable: the folder is on PATH.
 */
export const preloadFile = ".preload.js";

/** preload is preloadFile's text. */
export const preload = "delete process.env." + beBunVar + ";\n";

/**
 * wrapper is the `bun` script that runs self (an executable's path) as the
 * bun CLI, with folder's preloadFile when it runs a file (`bun x.ts`, a
 * shebang's `bun /path/x.ts`, `bun run x.ts`).
 */
export function wrapper(self: string, folder: string): string {
  const pre = quote(joinPath(folder, preloadFile));
  return (
    "#!/bin/sh\n" +
    'if [ "$1" = run ] && [ -f "$2" ]; then shift; set -- run --preload ' + pre + ' "$@"\n' +
    'elif [ -f "$1" ]; then set -- --preload ' + pre + ' "$@"\n' +
    "fi\n" +
    beBunVar + "=1 exec " + quote(self) + ' "$@"\n'
  );
}

/**
 * ensure is the folder whose `bun` manifest commands run: $LOADOUT_BUN's,
 * else wrapperDir's.
 */
export function ensure(self: string = process.execPath): string {
  const bin = envVar(binVar);
  if (bin !== undefined && bin !== "") {
    if (!isExecutable(bin)) throw new Error(binVar + "=" + bin + " isn't an executable bun");
    return dir(bin);
  }
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

/** binary is the bun compile runs loadout.ts with: $LOADOUT_BUN, else the wrapper in ensure's folder. */
export function binary(folder: string): string {
  const bin = envVar(binVar);
  if (bin !== undefined && bin !== "") return bin;
  return joinPath(folder, "bun");
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

/** dir is path's folder: everything before the last slash, cleaned ("." when there is none). */
function dir(path: string): string {
  const i = path.lastIndexOf("/");
  return cleanPath(path.slice(0, i + 1) || ".");
}

/** quote is s as one sh word. */
function quote(s: string): string {
  return "'" + s.replaceAll("'", `'\\''`) + "'";
}
