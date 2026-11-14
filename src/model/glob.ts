// The manifest sources (`layout.sources`): the files loadout.ts reaches and
// the globs it includes, on `/`-separated paths relative to the repo root,
// matched as the SDK's include() matches them (Bun.Glob with dot files): `*`
// matches within one segment, dot entries too (`.tmux.loadout.ts`), `?` one
// character, `**` any number of segments, dot folders included. `.git` and
// `node_modules` are never entered.

import type { RepoFS } from "./fsys.ts";
import { joinPath, sortStrings, trimSpace } from "./stdlib.ts";

/** globProblem is why pattern can't be a layout path or glob, or "" when it can. */
export function globProblem(pattern: string): string {
  const segments = pattern.split("/");
  if (trimSpace(pattern) === "") return "is empty";
  if (pattern.startsWith("/")) return "is absolute; layout paths are relative to the repo root";
  if (segments.includes("..")) return "leaves the repo (..)";
  if (segments.includes("")) return "has an empty path segment";
  return "";
}

/** globHasWildcard says whether pattern has a `*` or `?`. */
export function globHasWildcard(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/** globMatches says whether pattern matches the repo-relative path. */
export function globMatches(pattern: string, p: string): boolean {
  return matchSegments(pattern.split("/"), p.split("/"));
}

/**
 * globExpand is the repo files pattern matches, path-sorted, as paths
 * relative to repo's root. Symlinks are neither files nor folders here.
 */
export function globExpand(repo: RepoFS, pattern: string): string[] {
  const segments = pattern.split("/");
  let n = 0;
  while (n < segments.length && !globHasWildcard(segments[n]!)) n++;
  const base = n > 0 ? joinPath(...segments.slice(0, n)) : ".";
  const kind = repo.lstat(base);
  if (n === segments.length) return kind === "file" ? [base] : [];
  if (kind !== "dir") return [];
  const files: string[] = [];
  walk(repo, base, files);
  return sortStrings(files.filter((f) => globMatches(pattern, f)));
}

function walk(repo: RepoFS, dir: string, out: string[]): void {
  for (const e of repo.readDir(dir)) {
    const child = joinPath(dir, e.name);
    if (e.kind === "dir") {
      if (e.name !== ".git" && e.name !== "node_modules") walk(repo, child, out);
    } else if (e.kind === "file") {
      out.push(child);
    }
  }
}

function matchSegments(pattern: string[], p: string[]): boolean {
  if (pattern.length === 0) return p.length === 0;
  const head = pattern[0]!;
  if (head === "**") {
    // Zero segments, or one more and try again.
    return matchSegments(pattern.slice(1), p) || (p.length > 0 && matchSegments(pattern, p.slice(1)));
  }
  if (p.length === 0) return false;
  return wildcard(Array.from(head), Array.from(p[0]!)) && matchSegments(pattern.slice(1), p.slice(1));
}

/** wildcard matches a whole segment: `*` any run of characters, `?` one. */
function wildcard(pattern: string[], s: string[]): boolean {
  if (pattern.length === 0) return s.length === 0;
  switch (pattern[0]) {
    case "*":
      for (let i = 0; i <= s.length; i++) {
        if (wildcard(pattern.slice(1), s.slice(i))) return true;
      }
      return false;
    case "?":
      return s.length > 0 && wildcard(pattern.slice(1), s.slice(1));
  }
  return s.length > 0 && s[0] === pattern[0] && wildcard(pattern.slice(1), s.slice(1));
}
