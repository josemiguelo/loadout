// RepoFS is how the model and assemble read files: a tree rooted at a
// repo, read through `/`-separated paths relative to that root. dirFS is
// the disk; mapFS is in memory, for tests. A valid path (validPath) has no
// leading or trailing slash, no empty, "." or ".."
// segment, "." for the root; anything else doesn't exist.

import * as fs from "node:fs";
import { compareStrings } from "./stdlib.ts";

/** EntryKind is what a path is, without following a symlink. */
export type EntryKind = "file" | "dir" | "symlink" | "other";

/** DirEntry is one entry of a folder. */
export interface DirEntry {
  name: string;
  kind: EntryKind;
}

/** RepoFS is a read-only file tree rooted at a repo. */
export interface RepoFS {
  /** lstat is what path is, not following a symlink; undefined when it isn't there (or isn't a valid path). */
  lstat(path: string): EntryKind | undefined;
  /** readDir is the folder's entries, sorted by name; throws when it can't be read. */
  readDir(path: string): DirEntry[];
  /** readFile is the file's bytes; throws when it can't be read. */
  readFile(path: string): Uint8Array;
}

/** validPath says whether name is a valid RepoFS path. */
export function validPath(name: string): boolean {
  if (name === ".") return true;
  if (name === "") return false;
  return name.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** byName orders entries by name, bytewise. */
function byName(a: DirEntry, b: DirEntry): number {
  return compareStrings(a.name, b.name);
}

function kindOf(st: fs.Stats | fs.Dirent): EntryKind {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

/** dirFS is the tree under root on disk. */
export function dirFS(root: string): RepoFS {
  const full = (p: string) => {
    if (!validPath(p)) throw Object.assign(new Error(`open ${p}: invalid argument`), { code: "EINVAL" });
    return p === "." ? root : root + "/" + p;
  };
  return {
    lstat(p) {
      if (!validPath(p)) return undefined;
      try {
        return kindOf(fs.lstatSync(full(p)));
      } catch {
        return undefined;
      }
    },
    readDir(p) {
      return fs
        .readdirSync(full(p), { withFileTypes: true })
        .map((d) => ({ name: d.name, kind: kindOf(d) }))
        .sort(byName);
    },
    readFile(p) {
      return new Uint8Array(fs.readFileSync(full(p)));
    },
  };
}

/**
 * mapFS is a tree in memory: each key a file path, its value
 * the content; the folders on the way are implied.
 */
export function mapFS(files: Record<string, string | Uint8Array>): RepoFS {
  const content = new Map<string, Uint8Array>();
  const dirs = new Set<string>(["."]);
  for (const [path, data] of Object.entries(files)) {
    content.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
  }
  const notExist = (p: string) => Object.assign(new Error(`open ${p}: file does not exist`), { code: "ENOENT" });
  return {
    lstat(p) {
      if (!validPath(p)) return undefined;
      if (content.has(p)) return "file";
      if (dirs.has(p)) return "dir";
      return undefined;
    },
    readDir(p) {
      if (!validPath(p) || !dirs.has(p)) throw notExist(p);
      const prefix = p === "." ? "" : p + "/";
      const seen = new Map<string, EntryKind>();
      for (const path of [...content.keys(), ...dirs]) {
        if (path === "." || !path.startsWith(prefix)) continue;
        const name = path.slice(prefix.length).split("/")[0]!;
        if (name === "") continue;
        const child = prefix + name;
        seen.set(name, dirs.has(child) ? "dir" : "file");
      }
      return [...seen].map(([name, kind]) => ({ name, kind })).sort(byName);
    },
    readFile(p) {
      const data = validPath(p) ? content.get(p) : undefined;
      if (data === undefined) throw notExist(p);
      return data;
    },
  };
}
