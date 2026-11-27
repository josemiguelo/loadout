// Knows whether this binary is behind the latest published release. The one
// deliberate self-knowledge carve-out: loadout is infrastructure, not repo
// payload, so "can this machine keep participating?" is part of observing
// it. Lookups fail soft (offline -> "") and the cached form costs a file
// read, so `status` can afford it on every refresh.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { type ExecResult, line, type ProcessRunner } from "../core/exec/index.ts";
import { envVar } from "../core/platform/platform.ts";
import { joinPath, trimSpace } from "../model/index.ts";
import { atLeast, VERSION } from "../version.ts";

const selfAPI = "https://api.github.com/repos/josemiguelo/loadout/releases/latest";
/** selfCache is how long a cached answer stands: 6h. */
const selfCache = 6 * 60 * 60 * 1000;

const tagName = /"tag_name": *"v([0-9][0-9.]*)"/;

/**
 * latestRelease is the latest published release ("0.4.0"), or "" when
 * unknown (offline and no cache). cached uses a ~6h on-disk cache;
 * `outdated` passes false for a fresh answer.
 */
export function latestRelease(runner: ProcessRunner, cached: boolean): Promise<string> {
  return latestOf(runner, selfAPI, tagName, "latest-release", cached);
}

/**
 * latestOf is the version tag matches in api's latest release, cached in
 * $XDG_CACHE_HOME/loadout/<cacheName>.
 */
async function latestOf(runner: ProcessRunner, api: string, tag: RegExp, cacheName: string, cached: boolean): Promise<string> {
  let cacheHome = envVar("XDG_CACHE_HOME");
  if (cacheHome === undefined || cacheHome === "") {
    const home = envVar("HOME");
    if (home === undefined || home === "") return "";
    cacheHome = home + "/.cache";
  }
  const cacheDir = cacheHome + "/loadout";
  const cache = joinPath(cacheDir, cacheName);
  // The cache is a file, so read it as one: no process per status.
  const readCache = (): string => {
    try {
      return trimSpace(readFileSync(cache, "utf8"));
    } catch {
      return "";
    }
  };
  if (cached) {
    let fresh = false;
    try {
      fresh = Date.now() - statSync(cache).mtimeMs < selfCache;
    } catch {
      fresh = false;
    }
    if (fresh) {
      const v = readCache();
      if (v !== "") return v;
    }
  }
  let result: ExecResult;
  try {
    result = await runner.capture(line("curl -fsSL --max-time 5 '" + api + "'", ""));
  } catch {
    // An interrupted curl reads as no output.
    result = { exitCode: 0, stdout: "", stderr: "" };
  }
  const match = tag.exec(result.stdout);
  if (match === null) return readCache(); // stale beats nothing when the API is unreachable
  const fetched = match[1]!;
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
    try {
      writeFileSync(cache, fetched + "\n", { mode: 0o644 });
    } catch {
      // a cache that can't be written costs a lookup next time, nothing more
    }
  } catch {
    // as above
  }
  return fetched;
}

/**
 * behindRelease is the latest release this binary is behind, or "" when
 * current or unknown.
 */
export async function behindRelease(runner: ProcessRunner, cached: boolean): Promise<string> {
  const latest = await latestRelease(runner, cached);
  if (latest === "" || atLeast(VERSION, latest)) return "";
  return latest;
}
