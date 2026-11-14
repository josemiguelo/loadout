// compile is `loadout compile`: a repo's manifests are TypeScript, run by
// bun, and what loadout.ts prints (the draft) is assembled, checked and
// written to loadout.lock.json, which every other command reads.

import * as fs from "node:fs";
import * as path from "node:path";
import { assemble, declaredNames, draftOver, invalid, type ManifestDraft } from "../assemble/index.ts";
import * as bun from "../core/bun/bun.ts";
import {
  chezmoiDataFiles,
  cleanPath,
  decodeDraft as decodeModelDraft,
  decodeLock,
  dirFS,
  distinct,
  type JSONObject,
  type JSONValue,
  JSONSyntaxError,
  type Lock,
  lockFileName,
  ManifestException,
  type MachineConfig,
  mapValues,
  newParentLayout,
  parentRoot,
  parseJSON,
  type RepoFS,
  sourcesHash,
  sortedStrings,
  isJSONObject,
  encodeLock,
} from "../model/index.ts";
import { VERSION } from "../version.ts";
// The SDKs' types (sdktypes.ts makes the file), which bun inlines (`bun
// build --compile` too). TypeScript refuses a declaration file as a value.
// @ts-ignore a text import's default is the file's text
import TypesText from "./sdk/loadout.d.ts" with { type: "text" };
import { transitionalWarnings, unusedWarnings } from "./unused.ts";

/** entryFile is a repo's root manifest: run by compile, it imports the rest. */
export const entryFile = "loadout.ts";

/**
 * typesFile is where compile and init write the SDKs' types, for the
 * editor: `declare module "loadout"` (the manifests' SDK) and `declare
 * module "loadout/script"` (loadout's protocols for scripts in TypeScript),
 * as an @types package the TypeScript server finds with no tsconfig entry.
 * In node_modules, so it's never committed. The modules themselves are the
 * binary's (core/bun's preload), so a repo's types are always the
 * loadout's that compiles it and runs its scripts.
 */
export const typesFile = "node_modules/@types/loadout/index.d.ts";

/** types is typesFile's text, embedded in the binary. */
export const types: string = TypesText as string;

/** typesFiles is the @types package compile and init write: typesFile and its package.json. */
export const typesFiles: { path: string; content: string }[] = [
  { path: "node_modules/@types/loadout/package.json", content: '{ "name": "@types/loadout", "private": true, "types": "index.d.ts" }\n' },
  { path: typesFile, content: types },
];

/**
 * Draft is what loadout.ts prints: the manifest before assembly, and what
 * only compile reads (the warnings' marks, the parent it names).
 */
export interface Draft extends ManifestDraft {
  /** spares is what `spare: "reason"` marked, keyed as warnings name it. */
  spares: Map<string, string>;
  /** transitional is the scripts marked transitional, in declaration order. */
  transitional: string[];
  /** parent is the repo this one builds on (a child repo), undefined for any other. */
  parent?: ParentRef;
}

/** ParentRef is `repo({ parent })`: the parent's name in messages, and its checkout. */
export interface ParentRef {
  name: string;
  path: string;
}

/**
 * compile is `loadout compile` for the repo at root: loadout.ts run with
 * bun (a child's parent too, contract 18), the draft assembled and checked,
 * the lock (and with configs, the templates' data and partial) written when
 * it changed. The warnings (what no machine uses, transitional scripts
 * every machine has done) come back without their "warning: " prefix; they
 * never stop a compile. Throws a refusal (ManifestException) or an I/O error.
 */
export async function compile(root: string): Promise<string[]> {
  root = path.resolve(root);
  try {
    root = fs.realpathSync(root);
  } catch {
    // A path that can't be resolved stays absolute.
  }
  if (!isFile(path.join(root, entryFile))) {
    throw new ManifestException(root + " has no " + entryFile + " — a config repo starts there (see: loadout init)");
  }
  const bunDir = bun.ensure();
  for (const f of typesFiles) writeIfChanged(root, path.join(root, f.path), f.content);
  const d = await run(bunDir, root, false);
  let draft: ManifestDraft = { manifest: d.manifest, profiles: d.profiles, requires: d.requires };
  let parentFS: RepoFS | undefined;
  let inherited: string[] = [];
  if (d.parent !== undefined) {
    const parent = await loadParent(bunDir, d.parent, root);
    const [over, errs] = draftOver(draft, parent.draft, d.parent.name);
    if (errs.length > 0) throw invalid(distinct(errs));
    const layout = parent.draft.manifest.layout;
    draft = {
      ...over,
      manifest: {
        ...over.manifest,
        layout: {
          ...over.manifest.layout,
          parent: newParentLayout({
            name: d.parent.name,
            path: d.parent.path,
            state: layout.state,
            configs: layout.configs,
            sources: layout.sources,
            hash: parent.hash,
          }),
        },
      },
    };
    parentFS = parent.fs;
    inherited = declaredNames(parent.draft);
  }
  const repoFS = dirFS(root);
  const manifest = assemble(draft, repoFS, parentFS);
  const hash = sourcesHash(repoFS, manifest.layout.sources);
  const lock: Lock = { format: 0, toolVersion: VERSION, sources: hash, manifest };
  writeIfChanged(root, path.join(root, lockFileName), encodeLock(lock));
  const configs = manifest.layout.configs;
  if (configs !== undefined) {
    for (const [p, text] of chezmoiDataFiles(manifest, configs)) {
      writeIfChanged(root, path.join(root, p), text);
    }
  }
  const warnings = unusedWarnings(draft, manifest, d.spares, inherited);
  if (d.transitional.length > 0) {
    const done = doneScripts(path.join(root, manifest.layout.state), [...manifest.machines.keys()]);
    warnings.push(...transitionalWarnings(manifest, d.transitional, done));
  }
  return warnings;
}

/**
 * run is the draft root's loadout.ts prints, run by the wrapper in bunDir
 * (loadout itself as bun, or $LOADOUT_BUN, with the SDKs' preload) with
 * nothing of the caller's environment but PATH, bunDir first, HOME and
 * $LOADOUT_BUN: a manifest's output must not depend on who compiles it.
 * asParent marks every origin as the parent's. It runs the process itself
 * rather than through the ProcessRunner: an argv with a cleared
 * environment, not a shell line.
 */
async function run(bunDir: string, root: string, asParent: boolean): Promise<Draft> {
  const bunBin = path.join(bunDir, "bun");
  const env: Record<string, string> = {
    PATH: bunDir + ":" + (process.env.PATH ?? ""),
    HOME: process.env.HOME ?? "",
    LOADOUT_COMPILE: "1",
  };
  const otherBun = process.env[bun.binVar];
  if (otherBun !== undefined && otherBun !== "") env[bun.binVar] = otherBun;
  if (asParent) env.LOADOUT_AS_PARENT = "1";
  let stdout: string;
  let stderr: string;
  let failure: string | undefined;
  try {
    const proc = Bun.spawn([bunBin, "run", entryFile], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    if (proc.signalCode !== null) failure = "signal: " + signalName(String(proc.signalCode));
    else if (proc.exitCode !== 0) failure = "exit status " + proc.exitCode;
  } catch (e) {
    stdout = "";
    stderr = "";
    failure = "fork/exec " + bunBin + ": " + errnoText(e);
  }
  if (failure !== undefined) {
    let why = stderr.trim();
    if (why === "") why = failure;
    throw new ManifestException(why);
  }
  if (stdout.trim() === "") {
    throw new ManifestException(entryFile + " printed no manifest: it ends with repo({ ... })");
  }
  return decodeDraft(stdout);
}

/** signalName is a signal in words, as a failed run names it ("signal: killed"). */
function signalName(signal: string): string {
  const names: Record<string, string> = {
    SIGHUP: "hangup",
    SIGINT: "interrupt",
    SIGQUIT: "quit",
    SIGILL: "illegal instruction",
    SIGTRAP: "trace/breakpoint trap",
    SIGABRT: "aborted",
    SIGBUS: "bus error",
    SIGFPE: "floating point exception",
    SIGKILL: "killed",
    SIGUSR1: "user defined signal 1",
    SIGSEGV: "segmentation fault",
    SIGUSR2: "user defined signal 2",
    SIGPIPE: "broken pipe",
    SIGALRM: "alarm clock",
    SIGTERM: "terminated",
  };
  return names[signal] ?? signal;
}

/** errnoText is a failed spawn's reason in words ("no such file or directory"). */
function errnoText(e: unknown): string {
  const code = (e as { code?: string }).code;
  const texts: Record<string, string> = {
    ENOENT: "no such file or directory",
    EACCES: "permission denied",
    ENOEXEC: "exec format error",
    ENOTDIR: "not a directory",
  };
  return (code !== undefined && texts[code]) || (e as Error).message;
}

/** decodeDraft reads what the SDK's repo() prints. */
export function decodeDraft(text: string): Draft {
  let extra: Extra;
  try {
    extra = readExtra(text);
  } catch (e) {
    throw new ManifestException(entryFile + " printed something that isn't a manifest: " + (e as Error).message);
  }
  let decoded;
  try {
    decoded = decodeModelDraft(text);
  } catch (e) {
    throw new ManifestException((e as Error).message);
  }
  // What assembly's messages call each one ("machine 'm': …"), never in the lock.
  const label =
    (kind: string) =>
    (name: string, c: MachineConfig): MachineConfig => ({ ...c, label: kind + " '" + name + "'" });
  const manifest = { ...decoded.manifest, machines: mapValues(decoded.manifest.machines, label("machine")) };
  const profiles = mapValues(decoded.profiles, label("profile"));
  const spares = new Map<string, string>();
  for (const k of sortedStrings(extra.spares.keys())) spares.set(k, extra.spares.get(k)!);
  return { manifest, profiles, requires: decoded.requires, spares, transitional: extra.transitional, parent: extra.parent };
}

/** Extra is what decodeDraft reads besides the model's draft. */
interface Extra {
  spares: Map<string, string>;
  transitional: string[];
  parent?: ParentRef;
}

/**
 * readExtra is the draft's spares, transitional and parent fields. It
 * throws the first problem: a syntax error (as parseDraftJSON words it) or
 * a field of the wrong kind. Fields match case-insensitively.
 */
function readExtra(text: string): Extra {
  const tree = parseDraftJSON(text);
  const out: Extra = { spares: new Map(), transitional: [] };
  const errs: string[] = [];
  const mismatch = (v: JSONValue, where: string, type: string) => {
    errs.push(`json: ${where} is ${kindOf(v)}, not ${type}`);
  };
  if (tree === null) return out;
  if (!isJSONObject(tree)) {
    mismatch(tree, "the draft", "an object");
    throw new Error(errs[0]);
  }
  for (const [key, v] of tree) {
    switch (key.toLowerCase()) {
      case "spares":
        if (v === null) out.spares = new Map();
        else if (!isJSONObject(v)) mismatch(v, ".spares", "an object of strings");
        else {
          for (const [k, s] of v) {
            if (s === null) out.spares.set(k, "");
            else if (typeof s === "string") out.spares.set(k, s);
            else mismatch(s, ".spares." + k, "a string");
          }
        }
        break;
      case "transitional":
        if (v === null) out.transitional = [];
        else if (!Array.isArray(v)) mismatch(v, ".transitional", "an array of strings");
        else {
          out.transitional = v.map((s, i) => {
            if (s === null) return "";
            if (typeof s !== "string") {
              mismatch(s, ".transitional." + i, "a string");
              return "";
            }
            return s;
          });
        }
        break;
      case "parent":
        if (v === null) out.parent = undefined;
        else if (!isJSONObject(v)) mismatch(v, ".parent", "an object with a name and a path");
        else {
          const ref = out.parent ?? { name: "", path: "" };
          for (const [k, s] of v) {
            const field = k.toLowerCase();
            if (field !== "name" && field !== "path") continue;
            if (s === null) continue;
            if (typeof s !== "string") mismatch(s, ".parent." + k, "a string");
            else ref[field] = s;
          }
          out.parent = ref;
        }
        break;
    }
  }
  if (errs.length > 0) throw new Error(errs[0]);
  return out;
}

/** kindOf is a JSON value's kind, with its article, as a mismatch names it. */
function kindOf(v: JSONValue): string {
  if (typeof v === "string") return "a string";
  if (typeof v === "boolean") return "a bool";
  if (Array.isArray(v)) return "an array";
  if (isJSONObject(v)) return "an object";
  return "a number";
}

/**
 * parseDraftJSON is parseJSON with the draft's own words for running out of
 * input ("unexpected end of JSON input") and for content after the value.
 */
function parseDraftJSON(text: string): JSONValue {
  try {
    return parseJSON(text);
  } catch (e) {
    if (!(e instanceof JSONSyntaxError)) throw e;
    if (e.message === "unexpected EOF" || e.message === "EOF" || e.message === "unexpected end of JSON input") {
      throw new Error("unexpected end of JSON input");
    }
    if (e.message.startsWith("unexpected trailing content")) {
      const after = text.slice(endOfValue(text)).trimStart();
      throw new Error(`invalid character ${quoteChar(after[0] ?? "")} after top-level value`);
    }
    throw e;
  }
}

/** quoteChar is a character as a draft's syntax errors quote it. */
function quoteChar(c: string): string {
  if (c === "'") return "'\\''";
  if (c === '"') return "'\"'";
  return "'" + c + "'";
}

/**
 * endOfValue is the index just past the first JSON value in text, which
 * parseJSON has already read as valid.
 */
function endOfValue(text: string): number {
  let i = 0;
  const ws = " \t\n\r";
  while (i < text.length && ws.includes(text[i]!)) i++;
  const c = text[i];
  if (c === '"') return endOfString(text, i);
  if (c !== "{" && c !== "[") {
    while (i < text.length && !ws.includes(text[i]!) && !",:]}[{\"".includes(text[i]!)) i++;
    return i;
  }
  let depth = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      i = endOfString(text, i);
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/** endOfString is the index just past the string starting at text[start]. */
function endOfString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  return i;
}

/** ParentRepo is a child's parent, run: its checkout, its draft (every origin the parent's) and its sources' hash. */
interface ParentRepo {
  fs: RepoFS;
  hash: string;
  draft: Draft;
}

/**
 * loadParent runs the parent of the child at childRoot. Its own lock must
 * be current and have no parent of its own: the child's lock records the
 * parent's sources as that lock names them.
 */
async function loadParent(bunDir: string, ref: ParentRef, childRoot: string): Promise<ParentRepo> {
  const root = parentRoot(newParentLayout({ name: ref.name, path: ref.path }), process.env.HOME ?? "", childRoot);
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new ManifestException(`parent ${ref.name} (${ref.path}) names no directory — see repo({ parent }) in ${entryFile}`);
  }
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, lockFileName), "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
      throw new ManifestException(`parent ${ref.name} (${ref.path}) has no ${lockFileName} — run: loadout compile there first`);
    }
    throw e;
  }
  const lock = decodeLock(text, "parent " + ref.name + "'s " + lockFileName);
  if (lock.manifest.layout.parent !== undefined) {
    throw new ManifestException("parent " + ref.name + " is itself a child: a parent can't have a parent");
  }
  if (!isFile(path.join(root, entryFile))) {
    throw new ManifestException(`parent ${ref.name} (${ref.path}) has no ${entryFile}`);
  }
  const parentFS = dirFS(root);
  const hash = sourcesHash(parentFS, lock.manifest.layout.sources);
  if (hash !== lock.sources) {
    throw new ManifestException(`parent ${ref.name}: ${lockFileName} is older than its manifests — run: loadout compile there first`);
  }
  let d: Draft;
  try {
    d = await run(bunDir, root, true);
  } catch (e) {
    throw new ManifestException("parent " + ref.name + ": " + (e as Error).message);
  }
  return { fs: parentFS, hash, draft: d };
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * doneScripts is each machine's scripts its state file says are done. A
 * missing or unreadable file is a machine that has done nothing: never a
 * reason to call a script finished.
 */
export function doneScripts(stateDir: string, machines: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const machine of machines) {
    const done = new Set<string>();
    out.set(machine, done);
    let text: string;
    try {
      text = fs.readFileSync(path.join(stateDir, machine + ".json"), "utf8");
    } catch {
      continue;
    }
    const scripts = stateScripts(text);
    if (scripts === undefined) continue;
    for (const [name, status] of scripts) {
      if (status === "done") done.add(name);
    }
  }
  return out;
}

/**
 * stateScripts is each script's status in a state file, read as
 * `{scripts: {<name>: {status}}}`; undefined where that fails (not JSON, or
 * a field of the wrong kind).
 */
function stateScripts(text: string): Map<string, JSONValue> | undefined {
  let tree: JSONValue;
  try {
    tree = parseJSON(text);
  } catch {
    return undefined;
  }
  const out = new Map<string, JSONValue>();
  if (tree === null) return out;
  if (!isJSONObject(tree)) return undefined;
  let ok = true;
  for (const [key, scripts] of tree) {
    if (key.toLowerCase() !== "scripts" || scripts === null) continue;
    if (!isJSONObject(scripts)) {
      ok = false;
      continue;
    }
    for (const [name, s] of scripts) {
      if (s === null) {
        out.set(name, null);
        continue;
      }
      if (!isJSONObject(s)) {
        ok = false;
        continue;
      }
      let status: JSONValue = null;
      for (const [k, v] of s as JSONObject) if (k.toLowerCase() === "status") status = v;
      out.set(name, status);
    }
  }
  return ok ? out : undefined;
}

/**
 * writeIfChanged writes text to target unless it already holds it: a
 * compile that changed nothing shows nothing in git. Nothing lands outside
 * root: a child's compile never writes into its parent (contract 18).
 */
export function writeIfChanged(root: string, target: string, text: string): void {
  const clean = cleanPath(target);
  const prefix = cleanPath(root).replace(/\/+$/, "") + "/";
  if (!clean.startsWith(prefix)) throw new Error("compile writes only under the repo root: " + target);
  const bytes = Buffer.from(text, "utf8");
  try {
    if (fs.readFileSync(clean).equals(bytes)) return;
  } catch {
    // Not there yet, or unreadable: write it.
  }
  fs.mkdirSync(path.dirname(clean), { recursive: true, mode: 0o755 });
  fs.writeFileSync(clean, bytes, { mode: 0o644 });
}
