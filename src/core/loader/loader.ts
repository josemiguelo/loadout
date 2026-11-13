// Package loader reads a config repo's lock: the only manifest the binary
// knows.
//
// The manifests themselves are TypeScript, run by `loadout compile`; the lock
// is refused when it's missing, written by a newer loadout, below the
// repo's version floor, or older than the sources it was compiled from, and
// so is a repo whose chezmoi data or partial (model.chezmoiDataFiles)
// doesn't match it. home is $HOME ("" when unset), for a parent at `~/…`.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { checkFiles, invalid } from "../../assemble/index.ts";
import {
  chezmoiDataFiles,
  decodeLock,
  dirFS,
  goPathError,
  joinPath,
  type Lock,
  lockFileName,
  ManifestException,
  type Manifest,
  type Meta,
  parentRoot as placeParent,
  type RepoFS,
  type RepoLayout,
  sourcesHash,
  ToolTooOldException,
} from "../../model/index.ts";
import { atLeast, VERSION } from "../../version.ts";

/** readLayout is the repo's layout, from the lock alone (no staleness or file checks). */
export function readLayout(repoRoot: string): RepoLayout {
  return readLock(repoRoot).manifest.layout;
}

/**
 * readMeta is the lock's meta (its name, the loadout it needs, its bun),
 * read without the checks a full load makes, like readLayout.
 */
export function readMeta(repoRoot: string): Meta {
  return readLock(repoRoot).manifest.meta;
}

/**
 * loadRepo is the repo's manifest, checked: the lock is current with its
 * sources and every `file:` path it names exists. Machines see their own
 * script variants through model.forMachine. Throws a Refusal (or an OS error).
 */
export function loadRepo(repoRoot: string, home: string): Manifest {
  const lock = readLock(repoRoot);
  const manifest = lock.manifest;
  if (sourcesHash(dirFS(repoRoot), manifest.layout.sources) !== lock.sources) {
    throw new ManifestException("the manifests changed since " + lockFileName + " was written — run: loadout compile");
  }
  // A child's lock holds its parent's declarations as they were: a parent
  // edit it hasn't seen is refused the same way (contract 18).
  const root = parentRoot(repoRoot, manifest.layout, home);
  let parentFS: RepoFS | undefined;
  const parent = manifest.layout.parent;
  if (parent !== undefined) {
    parentFS = dirFS(root);
    if (sourcesHash(parentFS, parent.sources) !== parent.hash) {
      throw new ManifestException(
        "parent " + parent.name + ": the manifests changed since " + lockFileName + " was written — run: loadout compile",
      );
    }
  }
  const configs = manifest.layout.configs;
  if (configs !== undefined) {
    for (const [path, expected] of chezmoiDataFiles(manifest, configs)) {
      let current: Buffer | undefined;
      try {
        current = readFileSync(joinPath(repoRoot, path));
      } catch {
        current = undefined;
      }
      if (current === undefined || !current.equals(Buffer.from(expected))) {
        const what = current === undefined ? "is missing" : "doesn't match " + lockFileName;
        throw new ManifestException(path + " " + what + " — run: loadout compile");
      }
    }
  }
  const missing = checkFiles(manifest, dirFS(repoRoot), parentFS);
  if (missing.length > 0) throw invalid(missing);
  return manifest;
}

/**
 * parentRoot is a child repo's parent checkout, canonical; "" for a repo
 * without a parent. One that isn't there is refused by name and path.
 */
export function parentRoot(repoRoot: string, layout: RepoLayout, home: string): string {
  const parent = layout.parent;
  if (parent === undefined) return "";
  const root = placeParent(parent, home, repoRoot);
  try {
    statSync(root);
    // realpath is EvalSymlinks then Abs: canonical and absolute.
    return realpathSync(root);
  } catch {
    throw new ManifestException(
      "parent " + parent.name + " is not at " + parent.path + " — clone it there, or change repo({ parent }) in loadout.ts and compile",
    );
  }
}

/**
 * parentChanged says whether a child repo's parent's manifests changed
 * since the child's lock was written: `sync` recompiles the child then.
 * False for a repo without a parent.
 */
export function parentChanged(repoRoot: string, home: string): boolean {
  const layout = readLayout(repoRoot);
  const parent = layout.parent;
  if (parent === undefined) return false;
  const root = parentRoot(repoRoot, layout, home);
  return sourcesHash(dirFS(root), parent.sources) !== parent.hash;
}

/** toolTooOld says whether this binary is too old for the repo's lock; read alone, like readLayout. */
export function toolTooOld(repoRoot: string): boolean {
  try {
    readLock(repoRoot);
    return false;
  } catch (e) {
    return e instanceof ToolTooOldException;
  }
}

function readLock(repoRoot: string): Lock {
  const path = joinPath(repoRoot, lockFileName);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ManifestException("no " + lockFileName + " in " + repoRoot + " — run: loadout compile");
    }
    throw goPathError(e, undefined, path);
  }
  // A newer minor may write what this binary would misread (a field it
  // doesn't know), so its version is checked before the body is read; a
  // patch release never changes what a lock means.
  const lock = decodeLock(text, "", (toolVersion) => {
    if (!atLeast(minor(VERSION), minor(toolVersion))) {
      throw new ToolTooOldException(
        lockFileName + " was compiled by loadout " + toolVersion + " (you have " + VERSION + ") — run: loadout self-upgrade",
        minor(toolVersion) + ".0",
      );
    }
  });
  const required = lock.manifest.meta.minToolVersion;
  if (required !== undefined && !atLeast(VERSION, required)) {
    throw new ToolTooOldException(
      "this config repo requires loadout >= " + required + " (you have " + VERSION + ") — run: loadout self-upgrade",
      required,
    );
  }
  return lock;
}

function minor(v: string): string {
  return v.split(".").slice(0, 2).join(".");
}
