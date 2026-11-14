import { createHash } from "node:crypto";
import { ObjWriter, readLockTree, type Errs, parseDecimal, manifestToJSON } from "./codec.ts";
import type { RepoFS } from "./fsys.ts";
import { globExpand } from "./glob.ts";
import { sortStrings } from "./stdlib.ts";
import { isJSONObject, type JSONObject, parseJSON, prettyJSON, primitive } from "./json.ts";
import type { Manifest } from "./manifest.ts";
import { distinct } from "./map.ts";
import { ManifestException } from "./refusal.ts";

/**
 * Lock is loadout.lock.json: a config repo's manifests, compiled. `loadout
 * compile` writes it; the rest of the binary reads nothing else. It's
 * generated, like state, but committed: a fresh machine needs only the
 * binary and a clone.
 */
export interface Lock {
  /**
   * format is bumped only when an older binary could misread the file; see
   * lockFormat. Always written; 0 is written as lockFormat.
   */
  format: number;
  /** toolVersion is the loadout version that wrote it. */
  toolVersion: string;
  /** sources is the sha256 of the sources it was compiled from (sourcesHash). */
  sources: string;
  manifest: Manifest;
}

/** lockFileName is the lock's file name, at the repo root. */
export const lockFileName = "loadout.lock.json";

/** lockFormat is the lock layout this binary writes and reads. */
export const lockFormat = 1;

/**
 * encodeLock is the lock's text: pretty-printed with a
 * two-space indent, defaults (the model's) left out — keeping the lock short
 * and its diffs about what changed — and a final newline.
 */
export function encodeLock(lock: Lock): string {
  const w = new ObjWriter();
  w.any("format", lock.format === 0 ? lockFormat : lock.format);
  w.str("toolVersion", lock.toolVersion);
  w.str("sources", lock.sources);
  w.any("manifest", manifestToJSON(lock.manifest));
  return prettyJSON(w.obj) + "\n";
}

/**
 * decodeLock is the lock in text. A newer format is refused by name before
 * anything else is read, and checkToolVersion (when given) sees the
 * writer's version before the body is decoded, so an old binary says
 * "upgrade" instead of failing on a field a newer minor added (it throws to
 * refuse). label names the file in messages (lockFileName when empty).
 * Throws a ManifestException when the text isn't a lock this binary reads.
 */
export function decodeLock(text: string, label = "", checkToolVersion?: (version: string) => void): Lock {
  if (label === "") label = lockFileName;
  const tree = lockHeader(text, label);
  if (checkToolVersion !== undefined && tree.has("toolVersion")) {
    const v = tree.get("toolVersion")!;
    const p = primitive(v);
    if (p === undefined) throw notALock(label);
    if (v !== null) checkToolVersion(p.content);
  }
  const errs: Errs = {};
  const lock = readLockTree(tree, errs);
  if (errs.err !== undefined) {
    throw new ManifestException(`${label} can't be read (${errs.err.message}) — run: loadout compile`);
  }
  return lock;
}

function notALock(label: string): ManifestException {
  return new ManifestException(label + " is not a lock file — run: loadout compile");
}

/** lockHeader is text as a JSON object whose format this binary reads. */
function lockHeader(text: string, label: string): JSONObject {
  let v;
  try {
    v = parseJSON(text);
  } catch (e) {
    throw new ManifestException(`${label} is not valid JSON (${(e as Error).message}) — run: loadout compile`);
  }
  if (!isJSONObject(v)) throw notALock(label);
  let format = lockFormat;
  if (v.has("format")) {
    const p = primitive(v.get("format"));
    if (p === undefined) throw notALock(label);
    const n = parseDecimal(p.content);
    if (n === undefined) throw notALock(label);
    format = n;
  }
  if (format > lockFormat) {
    throw new ManifestException(`${label} was written by a newer loadout (lock format ${format}) — run: loadout self-upgrade`);
  }
  return v;
}

/**
 * sourcesHash is the sha256 over every file the globs match in repo (rooted
 * at the repo root): each one's repo-relative path and content, in path
 * order. The compile stamps it into the lock and the binary recomputes it,
 * so an edit the lock hasn't seen is caught. Throws when a file can't be read.
 */
export function sourcesHash(repo: RepoFS, globs: readonly string[] | undefined): string {
  const files: string[] = [];
  for (const g of globs ?? []) files.push(...globExpand(repo, g));
  const h = createHash("sha256");
  for (const file of sortStrings(distinct(files))) {
    h.update(file);
    h.update(new Uint8Array([0]));
    h.update(repo.readFile(file));
    h.update(new Uint8Array([0]));
  }
  return h.digest("hex");
}
