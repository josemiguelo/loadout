// configbuild builds chezmoi's sources from a repo's tool folders
// (`repo({ dotfiles: { tools, home, root, from } })`, contract 17): every
// folder tools matches is a tool, named after its folder; its `home/` is
// chezmoi source rooted at $HOME and goes into the home build, its `root/`
// chezmoi source rooted at / and goes into the root build, and `from` (an
// authored chezmoi tree) is merged into the home build as it stands.
//
// A build is real folders and relative symlinks to the files it's built
// from: chezmoi follows a symlinked file but not a symlinked folder. Each
// part's `.chezmoiignore` and `.chezmoiremove` are joined into one file.
// The root build links the templates' data written into the home build, so
// a template reads the same machine on both sides. Builds are derived, never
// committed (a repo ignores them): compile writes them, and so does every
// command that reads the repo (refreshBuilds), as it writes the SDKs' types.
// A child repo builds its parent's tool folders into its own
// .loadout-parent/, since nothing writes under the parent (contract 18).
//
// chezmoi commands that write their source (re-add, merge, chattr, forget,
// add) write into a build: a symlink becomes a file, is renamed or removed,
// or a file appears. drift() tells those apart from a build that's just
// behind its tool folders; `loadout chezmoi` carries them over (snapshot()).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  chezmoiDataFiles,
  chezmoiDataPath,
  chezmoiPartialPath,
  globMatches,
  type Manifest,
  ManifestException,
  newRepoLayout,
  type RepoLayout,
  sortStrings,
} from "../../model/index.ts";

/** Entry is one path in a build: a folder, a symlink to a repo file, or a joined file. */
export type Entry =
  | { kind: "dir" }
  | { kind: "link"; source: string; generated: boolean }
  | { kind: "joined"; text: string };

/** Build is one chezmoi source to write: out is its folder; paths are relative to it. */
export interface Build {
  side: "home" | "root";
  out: string;
  entries: Map<string, Entry>;
  /** keep is what compile writes into the build itself (the templates' data): never touched here. */
  keep: string[];
}

/** Tool is one tool folder: its name, its folder, and which of home/ and root/ it has. */
export interface Tool {
  name: string;
  dir: string;
  home: boolean;
  root: boolean;
}

/** Plan is both builds for a repo, its tools, and what compile warns about. */
export interface Plan {
  home: Build;
  root: Build | undefined;
  tools: Tool[];
  warnings: string[];
  /** parts is every folder a build is made from (each tool's home/ and root/, and from): carryOver never removes one. */
  parts: string[];
}

/** joined is the special files each part may have, joined into one per build. */
const joined = [".chezmoiignore", ".chezmoiremove"];

/** Outs is where a plan's builds go, relative to the repo built from (a child's builds of its parent's folders: `../child/.loadout-parent/home`). */
export interface Outs {
  home: string;
  root?: string;
}

/** parentBuilds is the folder, in a child repo, its parent's builds go in. */
export const parentBuilds = ".loadout-parent";

/**
 * planBuild is what compile builds for layout in the repo at root, into
 * layout's folders or outs; undefined when layout has no tool folders.
 * Throws a ManifestException.
 */
export function planBuild(root: string, layout: RepoLayout, outs?: Outs): Plan | undefined {
  const build = layout.build;
  if (build === undefined || layout.configs === undefined) return undefined;
  const homeOut = outs?.home ?? layout.configs;
  const rootOut = outs !== undefined ? outs.root : layout.rootConfigs;
  const problems: string[] = [];
  const warnings: string[] = [];
  const tools: Tool[] = [];
  for (const dir of globDirs(root, build.tools)) {
    const name = path.posix.basename(dir);
    const home = isDir(root, dir + "/home");
    const rootDir = isDir(root, dir + "/root");
    const other = tools.find((t) => t.name === name);
    if (other !== undefined) problems.push("tools " + other.dir + " and " + dir + " share the name " + name);
    tools.push({ name, dir, home, root: rootDir });
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "home" && e.name !== "root") {
        warnings.push(dir + "/" + e.name + " is in a tool folder but isn't home/ or root/");
      }
    }
  }
  const from = build.from;
  if (from !== undefined) {
    for (const t of tools) {
      if (inside(t.dir, from) || inside(from, t.dir)) problems.push("tool " + t.dir + " overlaps from " + from + ": keep the tool folders apart from it");
    }
    if (!isDir(root, from)) problems.push("from " + from + " is not a folder");
  }
  const roots = tools.filter((t) => t.root);
  if (roots.length > 0 && layout.rootConfigs === undefined) {
    problems.push("tool " + roots[0]!.name + " has root/, and dotfiles has no root to build it into");
  }
  if (problems.length > 0) throw new ManifestException(problems.join("; "));

  const compiled = [chezmoiDataPath(""), chezmoiPartialPath("")].map((p) => p.replace(/^\//, ""));
  const homeParts: Part[] = [];
  if (from !== undefined) homeParts.push({ label: from, dir: from, skip: compiled });
  for (const t of tools) if (t.home) homeParts.push({ label: t.name, dir: t.dir + "/home", skip: [] });
  const home = plan(root, "home", homeOut, homeParts, compiled, new Map(), undefined, problems);
  let rootBuild: Build | undefined;
  if (rootOut !== undefined) {
    const links = new Map(compiled.map((c) => [c, homeOut + "/" + c]));
    const parts = roots.map((t) => ({ label: t.name, dir: t.dir + "/root", skip: [] }));
    rootBuild = plan(root, "root", rootOut, parts, [], links, (target) => (/^(home|Users)(\/|$)/.test(target) ? "is in a home: it goes in home/" : undefined), problems);
  }
  if (problems.length > 0) throw new ManifestException(problems.join("; "));
  const parts = [...homeParts.map((pt) => pt.dir), ...roots.map((t) => t.dir + "/root")];
  return { home, root: rootBuild, tools, warnings, parts };
}

interface Part {
  label: string;
  dir: string;
  skip: string[];
}

function plan(
  root: string,
  side: "home" | "root",
  out: string,
  parts: Part[],
  keep: string[],
  links: Map<string, string>,
  refuse: ((target: string) => string | undefined) | undefined,
  problems: string[],
): Build {
  const entries = new Map<string, Entry>();
  const owner = new Map<string, string>();
  const targets = new Map<string, { path: string; label: string }>();
  const joinedText = new Map<string, string[]>();
  const walk = (part: Part, rel: string, target: string) => {
    for (const name of sortStrings(fs.readdirSync(path.join(root, part.dir, rel)))) {
      const relPath = rel === "" ? name : rel + "/" + name;
      if (!chezmoiReads(name) || part.skip.includes(relPath)) continue;
      const src = part.dir + "/" + relPath;
      const stat = fs.statSync(path.join(root, src));
      if (rel === "" && joined.includes(name)) {
        const list = joinedText.get(name) ?? [];
        list.push("# " + src + "\n" + fs.readFileSync(path.join(root, src), "utf8").replace(/\n?$/, "\n"));
        joinedText.set(name, list);
        continue;
      }
      const tPath = (target === "" ? "" : target + "/") + targetName(name, stat.isDirectory());
      const why = name.startsWith(".chezmoi") ? undefined : refuse?.(tPath);
      if (why !== undefined) {
        problems.push(part.label + ": /" + tPath + " " + why);
        continue;
      }
      const claim = targets.get(tPath);
      if (claim !== undefined && claim.path !== relPath) {
        problems.push(display(side, tPath) + " is " + claim.path + " in " + claim.label + " and " + relPath + " in " + part.label);
        continue;
      }
      targets.set(tPath, { path: relPath, label: part.label });
      const prev = entries.get(relPath);
      if (stat.isDirectory()) {
        if (prev !== undefined && prev.kind !== "dir") problems.push(relPath + " is a file in " + owner.get(relPath) + " and a folder in " + part.label);
        entries.set(relPath, { kind: "dir" });
        owner.set(relPath, part.label);
        walk(part, relPath, tPath);
      } else if (prev !== undefined) {
        problems.push(display(side, tPath) + " is in both " + owner.get(relPath) + " and " + part.label);
      } else {
        entries.set(relPath, { kind: "link", source: src, generated: false });
        owner.set(relPath, part.label);
      }
    }
  };
  for (const p of parts) walk(p, "", "");
  for (const k of keep) parentsOf(k, entries);
  for (const [p, source] of links) {
    parentsOf(p, entries);
    entries.set(p, { kind: "link", source, generated: true });
  }
  for (const [name, list] of joinedText) {
    entries.set(name, { kind: "joined", text: "# Written by loadout compile from these; don't edit.\n" + list.join("\n") });
  }
  return { side, out, entries, keep };
}

/**
 * parentPlan is a child repo's build of its parent's tool folders, into the
 * child's .loadout-parent/; undefined when the parent has none. root is
 * the parent's checkout, childRoot the child's.
 */
export function parentPlan(manifest: Manifest, root: string, childRoot: string): Plan | undefined {
  const p = manifest.layout.parent;
  if (p === undefined || p.build === undefined || root === "") return undefined;
  const there = path.relative(root, childRoot) + "/" + parentBuilds;
  const layout = newRepoLayout({ state: p.state, configs: p.configs, rootConfigs: p.rootConfigs, build: p.build });
  return planBuild(root, layout, { home: there + "/home", root: p.rootConfigs !== undefined ? there + "/root" : undefined });
}

/**
 * refreshBuilds brings a repo's builds (and, in a child, its builds of the
 * parent's folders) up to date with their tool folders, with the
 * templates' data in each home build: every command that reads the repo
 * does, so chezmoi never reads a stale one. A build holding what a chezmoi
 * command wrote is left as it is (the load refuses it, naming the way
 * out). Best effort: what can't be planned or written is the load's to
 * report.
 */
export function refreshBuilds(repoRoot: string, manifest: Manifest, parentRoot: string): void {
  const jobs: [string, Plan | undefined][] = [];
  try {
    jobs.push([repoRoot, planBuild(repoRoot, manifest.layout)]);
  } catch {
    // The load says what's wrong.
  }
  try {
    jobs.push([parentRoot, parentPlan(manifest, parentRoot, repoRoot)]);
  } catch {
    // The load says what's wrong.
  }
  for (const [root, plan] of jobs) {
    if (plan === undefined) continue;
    try {
      const d = drift(root, plan);
      if (d.writes.length > 0 || d.strays.length > 0) continue;
      writeBuild(root, plan);
      for (const [p, text] of chezmoiDataFiles(manifest, plan.home.out)) writeChanged(path.join(root, p), text);
    } catch {
      // A checkout that can't be written: the load says what's behind.
    }
  }
}

function writeChanged(target: string, text: string): void {
  try {
    if (fs.readFileSync(target, "utf8") === text) return;
  } catch {
    // Not there yet.
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

/** writeBuild brings every build in p to what it plans, keeping what compile writes into it. */
export function writeBuild(root: string, p: Plan): void {
  for (const b of [p.home, p.root]) {
    if (b === undefined) continue;
    const have = current(root, b);
    for (const rel of [...have.keys()].reverse()) {
      if (!fits(root, b, rel, have.get(rel)!)) {
        const full = path.join(root, b.out, rel);
        if (have.get(rel)!.kind === "dir") {
          if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        } else fs.unlinkSync(full);
      }
    }
    fs.mkdirSync(path.join(root, b.out), { recursive: true });
    for (const [rel, e] of b.entries) {
      const full = path.join(root, b.out, rel);
      if (e.kind === "dir") fs.mkdirSync(full, { recursive: true });
      else if (!exists(full)) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (e.kind === "link") fs.symlinkSync(linkText(root, b, rel, e.source), full);
        else fs.writeFileSync(full, e.text);
      }
    }
  }
}

/** Write is a file chezmoi wrote into a build where a symlink belongs: build and source repo-relative, target as the user names it. */
export interface Write {
  build: string;
  source: string;
  target: string;
}

/** Drift is how builds differ from their plan: chezmoi's writes, files from no tool, and what's merely behind. */
export interface Drift {
  writes: Write[];
  strays: string[];
  stale: string[];
}

/** drift is how p's builds differ from what writeBuild would make them. */
export function drift(root: string, p: Plan): Drift {
  const out: Drift = { writes: [], strays: [], stale: [] };
  for (const b of [p.home, p.root]) {
    if (b === undefined) continue;
    const have = current(root, b);
    for (const [rel, h] of have) {
      const e = b.entries.get(rel);
      if (h.kind === "file" && e?.kind === "link" && !e.generated) {
        out.writes.push({ build: b.out + "/" + rel, source: e.source, target: targetOf(b, rel) });
      } else if (h.kind === "file" && e === undefined && !joined.includes(rel)) {
        // A joined file no part has any more is compile's leftover, not a stray.
        out.strays.push(b.out + "/" + rel);
      } else if (!fits(root, b, rel, h)) {
        out.stale.push(b.out + "/" + rel);
      }
    }
    for (const rel of b.entries.keys()) if (!have.has(rel)) out.stale.push(b.out + "/" + rel);
  }
  return out;
}

/** driftMessage is what a load or compile says about d, undefined when there's nothing to say. */
export function driftMessage(d: Drift): string | undefined {
  if (d.writes.length > 0) {
    const w = d.writes[0]!;
    const more = d.writes.length > 1 ? " (and " + (d.writes.length - 1) + " more)" : "";
    return (
      "chezmoi wrote " + w.build + more + ", not " + w.source + " — keep it with `loadout chezmoi re-add " + w.target + "` " +
      "(or copy it over " + w.source + "), or drop it by deleting " + w.build
    );
  }
  if (d.strays.length > 0) {
    return (
      d.strays[0] + " is from no tool (chezmoi add writes there) — add it again with `loadout chezmoi add --tool <tool> …`, " +
      "move it into a tool's home/ or root/, or delete it"
    );
  }
  if (d.stale.length > 0) return d.stale[0] + " doesn't match the tool folders — run: loadout compile";
  return undefined;
}

/** Snapshot is what a build holds: per path, a folder, a file, or a symlink and what it points to (repo-relative). */
export type Snapshot = Map<string, { kind: "dir" } | { kind: "file" } | { kind: "link"; source: string }>;

/** snapshot is what the build at out (repo-relative) holds now, compile's own files aside. */
export function snapshot(root: string, b: Build): Snapshot {
  const out: Snapshot = new Map();
  for (const [rel, h] of current(root, b)) {
    if (h.kind === "link") out.set(rel, { kind: "link", source: path.relative(root, path.resolve(root, b.out, path.dirname(rel), h.text)) });
    else out.set(rel, { kind: h.kind });
  }
  return out;
}

/** Carried is what carryOver did, as lines for the user, and the files it couldn't place (from no tool). */
export interface Carried {
  done: string[];
  homeless: string[];
}

/**
 * carryOver brings what a chezmoi command did to p's builds over to the
 * tool folders (contract 3: the user ran that command). before is each
 * build's snapshot from before the command. A symlink turned file is the
 * tool file's new content (re-add, merge, an editor that replaces files),
 * also when chezmoi wrote it before this command (a plain `chezmoi
 * re-add`); a symlink renamed is the tool file renamed (chattr, a folder's
 * too); one gone is the tool file deleted (forget); a new file goes into
 * tool's folder (add). Every change is worked out before any is made: a
 * new file with no tool to go to leaves everything as it is (homeless).
 * Folders a rename or deletion empties in a tool folder are removed, or
 * they'd still be chezmoi source. The caller rebuilds afterwards.
 */
export function carryOver(root: string, p: Plan, before: ReadonlyMap<"home" | "root", Snapshot>, tool: string | undefined): Carried {
  type Change = { kind: "write" | "move" | "delete" | "add"; from: string; to: string; say: string };
  const changes: Change[] = [];
  const homeless: string[] = [];
  const owner = tool === undefined ? undefined : p.tools.find((t) => t.name === tool);
  if (tool !== undefined && owner === undefined) throw new ManifestException("no tool folder " + tool);
  for (const b of [p.home, p.root]) {
    if (b === undefined) continue;
    const was = before.get(b.side) ?? new Map();
    const now = snapshot(root, b);
    const nowSources = new Map<string, string>();
    for (const [rel, e] of now) if (e.kind === "link") nowSources.set(e.source, rel);
    for (const [rel, e] of now) {
      const planned = b.entries.get(rel);
      if (e.kind !== "file") continue;
      if (planned?.kind === "link" && !planned.generated) {
        changes.push({ kind: "write", from: b.out + "/" + rel, to: planned.source, say: targetOf(b, rel) + " → " + planned.source });
      } else if (planned === undefined && !joined.includes(rel)) {
        if (owner === undefined) homeless.push(b.out + "/" + rel);
        else {
          const to = owner.dir + "/" + b.side + "/" + rel;
          changes.push({ kind: "add", from: b.out + "/" + rel, to, say: targetOf(b, rel) + " → " + to });
        }
      }
    }
    for (const [rel, e] of was) {
      if (e.kind !== "link") continue;
      const n = now.get(rel);
      if (n?.kind === "file" || (n?.kind === "link" && n.source === e.source)) continue;
      const movedTo = nowSources.get(e.source);
      if (movedTo !== undefined && movedTo !== rel) {
        const partRoot = e.source.slice(0, e.source.length - rel.length - 1);
        const to = partRoot + "/" + movedTo;
        changes.push({ kind: "move", from: e.source, to, say: e.source + " → " + to });
      } else if (n === undefined) {
        changes.push({ kind: "delete", from: e.source, to: "", say: "removed " + e.source });
      }
    }
  }
  if (homeless.length > 0) return { done: [], homeless };
  const emptied = new Set<string>();
  for (const c of changes) {
    const from = path.join(root, c.from);
    const to = path.join(root, c.to);
    if (c.kind === "write") fs.copyFileSync(from, to);
    else if (c.kind === "delete") fs.rmSync(from, { force: true });
    else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    }
    if (c.kind === "move" || c.kind === "delete") emptied.add(path.dirname(c.from));
  }
  // Folders left empty in a tool folder, up to its home/ or root/ (or from).
  for (const start of emptied) {
    for (let d = start; ; d = path.posix.dirname(d)) {
      if (p.parts.includes(d) || d === "." || !p.parts.some((pt) => d.startsWith(pt + "/")) || !fs.existsSync(path.join(root, d))) break;
      if (fs.readdirSync(path.join(root, d)).length > 0) break;
      fs.rmdirSync(path.join(root, d));
    }
  }
  return { done: changes.map((c) => c.say), homeless: [] };
}

/** targetOf is where a build path lands, as the user names it: `~/.zshrc`, `/etc/x`. */
export function targetOf(b: Build, rel: string): string {
  return display(b.side, rel.split("/").map((seg, i, all) => targetName(seg, i < all.length - 1)).join("/"));
}

function display(side: "home" | "root", target: string): string {
  return (side === "home" ? "~/" : "/") + target;
}

type Have = { kind: "dir" } | { kind: "file" } | { kind: "link"; text: string };

function current(root: string, b: Build): Map<string, Have> {
  const have = new Map<string, Have>();
  const base = path.join(root, b.out);
  if (!exists(base)) return have;
  const walk = (rel: string) => {
    for (const name of sortStrings(fs.readdirSync(path.join(base, rel)))) {
      const r = rel === "" ? name : rel + "/" + name;
      if (b.keep.includes(r)) continue;
      const st = fs.lstatSync(path.join(base, r));
      if (st.isSymbolicLink()) have.set(r, { kind: "link", text: fs.readlinkSync(path.join(base, r)) });
      else if (st.isDirectory()) {
        have.set(r, { kind: "dir" });
        walk(r);
      } else have.set(r, { kind: "file" });
    }
  };
  walk("");
  return have;
}

function fits(root: string, b: Build, rel: string, h: Have): boolean {
  const e = b.entries.get(rel);
  if (e === undefined) return false;
  if (e.kind === "dir") return h.kind === "dir";
  if (e.kind === "link") return h.kind === "link" && h.text === linkText(root, b, rel, e.source);
  return h.kind === "file" && fs.readFileSync(path.join(root, b.out, rel), "utf8") === e.text;
}

/** linkText is a build symlink's target: relative, both ends resolved in the repo at root (a child's build of its parent's folders is outside it). */
function linkText(root: string, b: Build, rel: string, source: string): string {
  return path.relative(path.dirname(path.resolve(root, b.out, rel)), path.resolve(root, source));
}

function parentsOf(p: string, entries: Map<string, Entry>): void {
  for (let d = path.posix.dirname(p); d !== "."; d = path.posix.dirname(d)) if (!entries.has(d)) entries.set(d, { kind: "dir" });
}

/** chezmoiReads says whether chezmoi reads an entry so named: its own dot entries only (a manifest and .loadout/ stay out). */
function chezmoiReads(name: string): boolean {
  return !name.startsWith(".") || name.startsWith(".chezmoi");
}

const dirAttrs = ["remove_", "external_", "exact_", "private_", "readonly_"];
const fileAttrs = ["after_", "before_", "onchange_", "once_", "run_", "create_", "modify_", "remove_", "symlink_", "encrypted_", "private_", "readonly_", "empty_", "executable_"];

/** targetName is the name a source entry lands as, chezmoi's attributes taken off (private_dot_config → .config). */
export function targetName(name: string, isDirectory: boolean): string {
  let n = name;
  for (let again = true; again; ) {
    again = false;
    for (const a of isDirectory ? dirAttrs : fileAttrs) {
      if (n.startsWith(a)) {
        n = n.slice(a.length);
        again = true;
      }
    }
  }
  if (!isDirectory) n = n.replace(/\.(tmpl|literal|age|asc)$/, "");
  if (n.startsWith("literal_")) return n.slice("literal_".length);
  return n.startsWith("dot_") ? "." + n.slice(4) : n;
}

/** globDirs is the repo folders pattern matches, path-sorted (`.git` and `node_modules` never entered). */
export function globDirs(root: string, pattern: string): string[] {
  const segments = pattern.split("/");
  const deep = segments.includes("**");
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (!deep && depth >= segments.length) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (!e.isDirectory() || e.name === ".git" || e.name === "node_modules") continue;
      const r = rel === "" ? e.name : rel + "/" + e.name;
      if (globMatches(pattern, r)) out.push(r);
      walk(r, depth + 1);
    }
  };
  walk("", 0);
  return sortStrings(out);
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}

function isDir(root: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

function exists(full: string): boolean {
  try {
    fs.lstatSync(full);
    return true;
  } catch {
    return false;
  }
}
