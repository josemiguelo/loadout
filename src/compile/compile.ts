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
// The SDKs' text, which bun inlines (`bun build --compile` too). TypeScript
// types these imports as the modules themselves, which have no default.
// @ts-expect-error a text import's default is the file's text
import SDKText from "../../internal/tsmanifest/sdk/loadout.sdk.ts" with { type: "text" };
// @ts-expect-error a text import's default is the file's text
import ScriptSDKText from "../../internal/tsmanifest/sdk/loadout.script.ts" with { type: "text" };
import { transitionalWarnings, unusedWarnings } from "./unused.ts";

/** entryFile is a repo's root manifest: run by compile, it imports the rest. */
export const entryFile = "loadout.ts";

/**
 * sdkFile is the SDK compile writes beside the entry (manifests import it as
 * "loadout"): the one this binary reads drafts from, so a repo's types are
 * always the loadout's that compiles it.
 */
export const sdkFile = "loadout.sdk.ts";

/** sdk is loadout.sdk.ts's text, embedded in the binary. */
export const sdk: string = SDKText as string;

/**
 * scriptSDKFile is the script SDK compile writes beside it (scripts import
 * it as "loadout/script"): loadout's protocols for scripts in TypeScript (a
 * managed script's check/install, an oracle's rows and update, the LOADOUT_*
 * environment), as the binary that runs them speaks them.
 */
export const scriptSDKFile = "loadout.script.ts";

/** scriptSDK is loadout.script.ts's text, embedded in the binary. */
export const scriptSDK: string = ScriptSDKText as string;

/** hclRepoMessage refuses a repo still declared in HCL (loadout 4). */
export const hclRepoMessage =
  "this repo's manifests are HCL; loadout 5 reads TypeScript (loadout.ts) — see the wiki's Writing-Your-Manifest";

/** kotlinRepoMessage refuses a repo still declared in Kotlin (loadout 3). */
export const kotlinRepoMessage = "this repo's manifests are Kotlin; loadout 5 reads TypeScript (loadout.ts)";

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
    // Go's EvalSymlinks failing keeps the absolute path.
  }
  if (!isFile(path.join(root, entryFile))) {
    if (isFile(path.join(root, "loadout.hcl"))) throw new ManifestException(hclRepoMessage);
    if (isFile(path.join(root, "loadout.kt")) || isFile(path.join(root, "build.gradle.kts"))) {
      throw new ManifestException(kotlinRepoMessage);
    }
    throw new ManifestException(root + " has no " + entryFile + " — a config repo starts there (see: loadout init)");
  }
  const bunDir = bun.ensure();
  const bunBin = bun.binary(bunDir);
  for (const [file, text] of [
    [sdkFile, sdk],
    [scriptSDKFile, scriptSDK],
  ] as const) {
    writeIfChanged(root, path.join(root, file), text);
  }
  const d = await run(bunBin, bunDir, root, false);
  let draft: ManifestDraft = { manifest: d.manifest, profiles: d.profiles, requires: d.requires };
  let parentFS: RepoFS | undefined;
  let inherited: string[] = [];
  if (d.parent !== undefined) {
    const parent = await loadParent(bunBin, bunDir, d.parent, root);
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
 * run is the draft root's loadout.ts prints, run by bunBin (loadout itself
 * as bun, through the wrapper in bunDir, unless $LOADOUT_BUN names one)
 * with nothing of the caller's environment but PATH, bunDir first, and
 * HOME: a manifest's output must not depend on who compiles it. asParent
 * marks every origin as the parent's.
 * Like Go's, it runs the process itself rather than through the
 * ProcessRunner: an argv with a cleared environment, not a shell line.
 */
async function run(bunBin: string, bunDir: string, root: string, asParent: boolean): Promise<Draft> {
  const env: Record<string, string> = {
    PATH: bunDir + ":" + (process.env.PATH ?? ""),
    HOME: process.env.HOME ?? "",
    LOADOUT_COMPILE: "1",
  };
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
    if (why.includes(`Cannot find module 'loadout'`) || why.includes(`Cannot find package 'loadout'`)) {
      why += ` — tsconfig.json maps "loadout" to ./` + sdkFile + ` ("paths": {"loadout": ["./` + sdkFile + `"]})`;
    }
    throw new ManifestException(why);
  }
  if (stdout.trim() === "") {
    throw new ManifestException(entryFile + " printed no manifest: it ends with repo({ ... })");
  }
  return decodeDraft(stdout);
}

/** signalName is a signal as Go's os.ProcessState words it ("signal: killed"). */
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

/** errnoText is a failed spawn's reason as Go's syscall.Errno words it. */
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
 * readExtra is Go's json.Unmarshal of the draft into its spares,
 * transitional and parent fields, with its errors' words: Unmarshal's
 * syntax errors (not the Decoder's that parseJSON speaks), and the first
 * type mismatch. Fields match case-insensitively, as Go's do.
 */
function readExtra(text: string): Extra {
  const tree = unmarshalJSON(text);
  const out: Extra = { spares: new Map(), transitional: [] };
  const errs: string[] = [];
  const mismatch = (v: JSONValue, where: string, type: string) => {
    errs.push(`json: cannot unmarshal ${kindOf(v)} into ${where} of type ${type}`);
  };
  if (tree === null) return out;
  if (!isJSONObject(tree)) {
    mismatch(
      tree,
      "Go value",
      'struct { Spares map[string]string "json:\\"spares\\""; Transitional []string "json:\\"transitional\\""; Parent *tsmanifest.ParentRef "json:\\"parent\\"" }',
    );
    throw new Error(errs[0]);
  }
  for (const [key, v] of tree) {
    switch (key.toLowerCase()) {
      case "spares":
        if (v === null) out.spares = new Map();
        else if (!isJSONObject(v)) mismatch(v, "Go struct field .spares", "map[string]string");
        else {
          for (const [k, s] of v) {
            if (s === null) out.spares.set(k, "");
            else if (typeof s === "string") out.spares.set(k, s);
            else mismatch(s, "Go struct field .spares." + k, "string");
          }
        }
        break;
      case "transitional":
        if (v === null) out.transitional = [];
        else if (!Array.isArray(v)) mismatch(v, "Go struct field .transitional", "[]string");
        else {
          out.transitional = v.map((s, i) => {
            if (s === null) return "";
            if (typeof s !== "string") {
              mismatch(s, ".transitional." + i, "string");
              return "";
            }
            return s;
          });
        }
        break;
      case "parent":
        if (v === null) out.parent = undefined;
        else if (!isJSONObject(v)) mismatch(v, "Go struct field .parent", "tsmanifest.ParentRef");
        else {
          const ref = out.parent ?? { name: "", path: "" };
          for (const [k, s] of v) {
            const field = k.toLowerCase();
            if (field !== "name" && field !== "path") continue;
            if (s === null) continue;
            if (typeof s !== "string") mismatch(s, "Go struct field .parent." + k, "string");
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

/** kindOf is a JSON value's kind as Go's UnmarshalTypeError names it. */
function kindOf(v: JSONValue): string {
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "bool";
  if (Array.isArray(v)) return "array";
  if (isJSONObject(v)) return "object";
  return "number";
}

/**
 * unmarshalJSON is parseJSON with json.Unmarshal's words for what the
 * Decoder words differently: running out of input, and content after the
 * value.
 */
function unmarshalJSON(text: string): JSONValue {
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

/** quoteChar is a character as Go's json errors quote it. */
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
async function loadParent(bunBin: string, bunDir: string, ref: ParentRef, childRoot: string): Promise<ParentRepo> {
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
    throw new ManifestException("parent " + ref.name + ": " + hclRepoMessage);
  }
  const parentFS = dirFS(root);
  const hash = sourcesHash(parentFS, lock.manifest.layout.sources);
  if (hash !== lock.sources) {
    throw new ManifestException(`parent ${ref.name}: ${lockFileName} is older than its manifests — run: loadout compile there first`);
  }
  let d: Draft;
  try {
    d = await run(bunBin, bunDir, root, true);
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
 * stateScripts is each script's status in a state file, as Go's Unmarshal
 * into `{scripts: map[string]{status any}}` reads it; undefined where that
 * fails (not JSON, or a field of the wrong kind).
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
