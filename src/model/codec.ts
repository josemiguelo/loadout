// The lock's JSON shape, field by field, as kotlinx writes the @Serializable
// classes with encodeDefaults = false and explicitNulls = false: keys in
// declaration order, a field equal to its default left out, an undefined one
// too. Reading is strict like kotlinx's: an unknown key or a missing required
// field is an error naming its path.

import { isJSONObject, type JSONObject, type JSONValue, JSONNumber } from "./json.ts";
import { mapValues } from "./map.ts";
import {
  type Installer,
  type InstallVariant,
  isDefaultModes,
  type MachineConfig,
  type Manifest,
  type Meta,
  newInstaller,
  newInstallVariant,
  newMachineConfig,
  newManifest,
  newMeta,
  newOutdatedSource,
  newParentLayout,
  newProgram,
  newRepoLayout,
  newScriptStep,
  newVersionCheck,
  type OutdatedSource,
  type ParentLayout,
  type Program,
  type RepoLayout,
  type ScriptStep,
  type VersionCheck,
} from "./manifest.ts";

// ─── writing ────────────────────────────────────────────────────────────

/** ObjWriter builds one object, leaving defaults out. */
export class ObjWriter {
  readonly obj: JSONObject = new Map();
  any(key: string, v: JSONValue): void {
    this.obj.set(key, v);
  }
  str(key: string, v: string): void {
    this.obj.set(key, v);
  }
  strIf(key: string, v: string): void {
    if (v !== "") this.obj.set(key, v);
  }
  ptr(key: string, v: string | undefined): void {
    if (v !== undefined) this.obj.set(key, v);
  }
  flag(key: string, v: boolean): void {
    if (v) this.obj.set(key, true);
  }
  list(key: string, v: readonly string[] | undefined): void {
    if (v !== undefined && v.length > 0) this.obj.set(key, [...v]);
  }
  strMap(key: string, v: ReadonlyMap<string, string>): void {
    if (v.size > 0) this.obj.set(key, new Map<string, JSONValue>(v));
  }
  data(key: string, v: JSONObject): void {
    if (v.size > 0) this.obj.set(key, v);
  }
}

function objectsOf<V>(m: ReadonlyMap<string, V>, f: (v: V) => JSONObject): JSONObject {
  return mapValues<V, JSONValue>(m, (_, v) => f(v));
}

/** manifestToJSON is the manifest as the lock writes it. */
export function manifestToJSON(m: Manifest): JSONObject {
  const w = new ObjWriter();
  if (m.meta.name !== "" || m.meta.minToolVersion !== undefined || m.meta.bun !== undefined) {
    w.any("meta", metaToJSON(m.meta));
  }
  if (!layoutIsDefault(m.layout)) w.any("layout", layoutToJSON(m.layout));
  if (m.installers.size > 0) w.any("installers", objectsOf(m.installers, installerToJSON));
  if (m.programs.size > 0) w.any("programs", objectsOf(m.programs, programToJSON));
  if (m.scripts.size > 0) w.any("scripts", objectsOf(m.scripts, scriptToJSON));
  if (m.machines.size > 0) w.any("machines", objectsOf(m.machines, machineToJSON));
  if (m.outdated.size > 0) w.any("outdated", objectsOf(m.outdated, outdatedToJSON));
  w.list("builtinInstallers", m.builtinInstallers);
  w.data("data", m.data);
  return w.obj;
}

function metaToJSON(m: Meta): JSONObject {
  const w = new ObjWriter();
  w.strIf("name", m.name);
  w.ptr("min-tool-version", m.minToolVersion);
  w.ptr("bun", m.bun);
  return w.obj;
}

function layoutIsDefault(l: RepoLayout): boolean {
  return l.state === "" && l.configs === undefined && l.sources.length === 0 && l.parent === undefined;
}

function layoutToJSON(l: RepoLayout): JSONObject {
  const w = new ObjWriter();
  w.strIf("state", l.state);
  w.ptr("configs", l.configs);
  w.list("sources", l.sources);
  if (l.parent !== undefined) w.any("parent", parentToJSON(l.parent));
  return w.obj;
}

function parentToJSON(p: ParentLayout): JSONObject {
  const w = new ObjWriter();
  w.str("name", p.name);
  w.str("path", p.path);
  w.str("state", p.state);
  w.ptr("configs", p.configs);
  w.list("sources", p.sources);
  w.strIf("hash", p.hash);
  return w.obj;
}

/** installerToJSON is an installer as the lock writes it. */
export function installerToJSON(i: Installer): JSONObject {
  const w = new ObjWriter();
  w.ptr("probe", i.probe);
  w.list("params", i.params);
  w.ptr("install", i.install);
  w.ptr("check", i.check);
  w.ptr("regex", i.regex);
  w.ptr("outdated", i.outdated);
  w.ptr("outdated-all", i.outdatedAll);
  w.ptr("upgrade", i.upgrade);
  w.flag("sudo", i.sudo);
  w.list("requires", i.requires);
  w.strIf("origin", i.origin);
  return w.obj;
}

function variantToJSON(v: InstallVariant): JSONObject {
  const w = new ObjWriter();
  w.ptr("installer", v.installer);
  w.ptr("pkg", v.pkg);
  w.ptr("command", v.command);
  w.ptr("check", v.check);
  w.ptr("regex", v.regex);
  w.flag("present", v.present);
  w.ptr("probe", v.probe);
  w.ptr("outdated", v.outdated);
  w.strMap("with", v.with);
  if (v.sudo !== undefined) w.any("sudo", v.sudo);
  w.list("depends-on", v.dependsOn);
  if (v.provides.length > 0) {
    w.any(
      "provides",
      v.provides.map((p) => {
        const pw = new ObjWriter();
        pw.str("binary", p.binary);
        pw.ptr("at", p.at);
        return pw.obj;
      }),
    );
  }
  return w.obj;
}

/** machineToJSON is a machine (or a draft's profile) as the lock writes it. */
export function machineToJSON(c: MachineConfig): JSONObject {
  const w = new ObjWriter();
  w.list("extends", c.extends);
  w.strMap("pm", c.pm);
  w.list("scripts", c.scripts);
  w.strMap("script-variants", c.scriptVariants);
  w.data("data", c.data);
  return w.obj;
}

/** programToJSON is a program as the lock writes it. */
export function programToJSON(p: Program): JSONObject {
  const w = new ObjWriter();
  w.strIf("description", p.description);
  w.list("tags", p.tags);
  w.list("depends-on", p.dependsOn);
  if (p.version !== undefined) w.any("version", versionCheckToJSON(p.version));
  if (p.install.size > 0) w.any("install", objectsOf(p.install, variantToJSON));
  if (p.outdated !== undefined) {
    const ow = new ObjWriter();
    ow.str("command", p.outdated.command);
    ow.ptr("upgrade", p.outdated.upgrade);
    w.any("outdated", ow.obj);
  }
  w.list("path", p.path);
  w.strIf("later", p.later);
  w.strIf("origin", p.origin);
  return w.obj;
}

function versionCheckToJSON(v: VersionCheck): JSONObject {
  const w = new ObjWriter();
  w.str("command", v.command);
  w.ptr("regex", v.regex);
  w.strIf("origin", v.origin);
  w.list("path", v.path);
  return w.obj;
}

/** scriptToJSON is a script as the lock writes it. */
export function scriptToJSON(s: ScriptStep): JSONObject {
  const w = new ObjWriter();
  w.strIf("description", s.description);
  w.ptr("file", s.file);
  w.ptr("run", s.run);
  w.ptr("check", s.check);
  w.list("after", s.after);
  if (s.modes !== undefined && !isDefaultModes(s.modes)) w.any("modes", [...s.modes]);
  w.flag("sudo", s.sudo);
  w.strIf("later", s.later);
  if (s.variants.size > 0) w.any("variants", objectsOf(s.variants, scriptToJSON));
  w.strIf("origin", s.origin);
  return w.obj;
}

function outdatedToJSON(o: OutdatedSource): JSONObject {
  const w = new ObjWriter();
  w.ptr("command", o.command);
  w.ptr("upgrade", o.upgrade);
  w.flag("sudo", o.sudo);
  w.strIf("origin", o.origin);
  return w.obj;
}

// ─── reading ────────────────────────────────────────────────────────────

/** DecodeError is a lock that doesn't fit the model, worded like kotlinx's. */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

/** Errs holds a decode's first problem: it sticks, later ones are dropped. */
export interface Errs {
  err?: DecodeError;
}

/** kindOf is a JSON value's kind as kotlinx names it in messages. */
function kindOf(v: JSONValue | undefined): string {
  if (isJSONObject(v)) return "JsonObject";
  if (Array.isArray(v)) return "JsonArray";
  if (v === null || v === undefined) return "JsonNull";
  return "JsonLiteral";
}

/**
 * ObjReader reads one object's fields; the first problem sticks, and done
 * reports it or the first key nothing read.
 */
export class ObjReader {
  readonly obj: JSONObject;
  private readonly seen = new Set<string>();

  constructor(
    v: JSONValue | undefined,
    readonly path: string,
    readonly serial: string,
    readonly errs: Errs,
  ) {
    if (isJSONObject(v)) {
      this.obj = v;
    } else {
      this.obj = new Map();
      this.fail(`Expected JsonObject, but had ${kindOf(v)} as the serialized body of ${serial} at element: ${path}`);
    }
  }

  fail(message: string): void {
    if (this.errs.err === undefined) this.errs.err = new DecodeError(message);
  }

  /** get is key's value; a null counts as absent (explicitNulls = false). */
  get(key: string): JSONValue | undefined {
    this.seen.add(key);
    const v = this.obj.get(key);
    return v === null ? undefined : v;
  }

  at(key: string): string {
    return this.path + "." + key;
  }

  required(key: string): JSONValue | undefined {
    const v = this.get(key);
    if (v === undefined) {
      this.fail(`Field '${key}' is required for type with serial name '${this.serial}', but it was missing at path: ${this.path}`);
    }
    return v;
  }

  private asString(key: string, v: JSONValue): string {
    if (typeof v !== "string") {
      this.fail(`String literal for key '${key}' should be quoted at element: ${this.at(key)}`);
      return "";
    }
    return v;
  }

  reqStr(key: string): string {
    const v = this.required(key);
    return v === undefined ? "" : this.asString(key, v);
  }

  str(key: string): string {
    const v = this.get(key);
    return v === undefined ? "" : this.asString(key, v);
  }

  ptr(key: string): string | undefined {
    const v = this.get(key);
    return v === undefined ? undefined : this.asString(key, v);
  }

  private asBool(key: string, v: JSONValue): boolean {
    if (typeof v !== "boolean") {
      this.fail(`Boolean literal for key '${key}' expected at element: ${this.at(key)}`);
      return false;
    }
    return v;
  }

  flag(key: string): boolean {
    const v = this.get(key);
    return v !== undefined && this.asBool(key, v);
  }

  optFlag(key: string): boolean | undefined {
    const v = this.get(key);
    return v === undefined ? undefined : this.asBool(key, v);
  }

  array(key: string): JSONValue[] | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) {
      this.fail(
        `Expected JsonArray, but had ${kindOf(v)} as the serialized body of kotlin.collections.ArrayList at element: ${this.at(key)}`,
      );
      return undefined;
    }
    return v;
  }

  /** list is key's strings; undefined when absent (Go's nil). */
  listOrNil(key: string): string[] | undefined {
    const arr = this.array(key);
    if (arr === undefined) return undefined;
    return arr.map((e, i) => {
      if (typeof e !== "string") {
        this.fail(`String literal for key '${i}' should be quoted at element: ${this.at(key)}[${i}]`);
        return "";
      }
      return e;
    });
  }

  list(key: string): string[] {
    return this.listOrNil(key) ?? [];
  }

  object(key: string): JSONObject | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    if (!isJSONObject(v)) {
      this.fail(
        `Expected JsonObject, but had ${kindOf(v)} as the serialized body of kotlin.collections.LinkedHashMap at element: ${this.at(key)}`,
      );
      return undefined;
    }
    return v;
  }

  strMap(key: string): Map<string, string> {
    const obj = this.object(key);
    if (obj === undefined) return new Map();
    return mapValues(obj, (k, v) => {
      if (typeof v !== "string") {
        this.fail(`String literal for key '${k}' should be quoted at element: ${this.at(key)}.${k}`);
        return "";
      }
      return v;
    });
  }

  data(key: string): JSONObject {
    return this.object(key) ?? new Map();
  }

  map<V>(key: string, read: (v: JSONValue, path: string, errs: Errs) => V): Map<string, V> {
    const obj = this.object(key);
    if (obj === undefined) return new Map();
    return mapValues(obj, (k, v) => read(v, this.at(key) + "." + k, this.errs));
  }

  /** done reports the first unknown key. */
  done(): void {
    for (const k of this.obj.keys()) {
      if (!this.seen.has(k)) {
        this.fail(`Encountered an unknown key '${k}' at path: ${this.path}`);
        return;
      }
    }
  }
}

/** readManifest reads a manifest as the lock writes it. */
export function readManifest(v: JSONValue | undefined, path: string, errs: Errs): Manifest {
  const r = new ObjReader(v, path, "loadout.core.model.Manifest", errs);
  const m = newManifest();
  const meta = r.get("meta");
  if (meta !== undefined) {
    const mr = new ObjReader(meta, r.at("meta"), "loadout.core.model.Meta", errs);
    m.meta = newMeta({ name: mr.str("name"), minToolVersion: mr.ptr("min-tool-version"), bun: mr.ptr("bun") });
    mr.done();
  }
  const layout = r.get("layout");
  if (layout !== undefined) m.layout = readLayout(layout, r.at("layout"), errs);
  m.installers = r.map("installers", readInstaller);
  m.programs = r.map("programs", readProgram);
  m.scripts = r.map("scripts", readScript);
  m.machines = r.map("machines", readMachine);
  m.outdated = r.map("outdated", readOutdated);
  m.builtinInstallers = [...new Set(r.list("builtinInstallers"))];
  m.data = r.data("data");
  r.done();
  return m;
}

function readLayout(v: JSONValue, path: string, errs: Errs): RepoLayout {
  const r = new ObjReader(v, path, "loadout.core.model.RepoLayout", errs);
  const l = newRepoLayout({ state: r.str("state"), configs: r.ptr("configs"), sources: r.list("sources") });
  const parent = r.get("parent");
  if (parent !== undefined) {
    const pr = new ObjReader(parent, r.at("parent"), "loadout.core.model.ParentLayout", errs);
    l.parent = newParentLayout({
      name: pr.reqStr("name"),
      path: pr.reqStr("path"),
      state: pr.reqStr("state"),
      configs: pr.ptr("configs"),
      sources: pr.list("sources"),
      hash: pr.str("hash"),
    });
    pr.done();
  }
  r.done();
  return l;
}

function readInstaller(v: JSONValue, path: string, errs: Errs): Installer {
  const r = new ObjReader(v, path, "loadout.core.model.Installer", errs);
  const i = newInstaller({
    probe: r.ptr("probe"),
    params: r.list("params"),
    install: r.ptr("install"),
    check: r.ptr("check"),
    regex: r.ptr("regex"),
    outdated: r.ptr("outdated"),
    outdatedAll: r.ptr("outdated-all"),
    upgrade: r.ptr("upgrade"),
    sudo: r.flag("sudo"),
    requires: r.list("requires"),
    origin: r.str("origin"),
  });
  r.done();
  return i;
}

function readVariant(v: JSONValue, path: string, errs: Errs): InstallVariant {
  const r = new ObjReader(v, path, "loadout.core.model.InstallVariant", errs);
  const iv = newInstallVariant({
    installer: r.ptr("installer"),
    pkg: r.ptr("pkg"),
    command: r.ptr("command"),
    check: r.ptr("check"),
    regex: r.ptr("regex"),
    present: r.flag("present"),
    probe: r.ptr("probe"),
    outdated: r.ptr("outdated"),
    with: r.strMap("with"),
    sudo: r.optFlag("sudo"),
    dependsOn: r.list("depends-on"),
  });
  const provides = r.array("provides");
  if (provides !== undefined) {
    provides.forEach((e, n) => {
      const pr = new ObjReader(e, `${r.at("provides")}[${n}]`, "loadout.core.model.Provides", errs);
      iv.provides.push({ binary: pr.reqStr("binary"), at: pr.ptr("at") });
      pr.done();
    });
  }
  r.done();
  return iv;
}

/** readMachine reads a machine (or a draft's profile) as the lock writes it. */
export function readMachine(v: JSONValue, path: string, errs: Errs): MachineConfig {
  const r = new ObjReader(v, path, "loadout.core.model.MachineConfig", errs);
  const c = newMachineConfig({
    extends: r.list("extends"),
    pm: r.strMap("pm"),
    scripts: r.list("scripts"),
    scriptVariants: r.strMap("script-variants"),
    data: r.data("data"),
  });
  r.done();
  return c;
}

function readCheck(v: JSONValue, path: string, errs: Errs): VersionCheck {
  const r = new ObjReader(v, path, "loadout.core.model.VersionCheck", errs);
  const c = newVersionCheck({ command: r.reqStr("command"), regex: r.ptr("regex"), origin: r.str("origin"), path: r.list("path") });
  r.done();
  return c;
}

/** readProgram reads a program as the lock writes it. */
export function readProgram(v: JSONValue, path: string, errs: Errs): Program {
  const r = new ObjReader(v, path, "loadout.core.model.Program", errs);
  const p = newProgram({ description: r.str("description"), tags: r.list("tags"), dependsOn: r.list("depends-on") });
  const version = r.get("version");
  if (version !== undefined) p.version = readCheck(version, r.at("version"), errs);
  p.install = r.map("install", readVariant);
  const outdated = r.get("outdated");
  if (outdated !== undefined) {
    const or = new ObjReader(outdated, r.at("outdated"), "loadout.core.model.ProgramOutdated", errs);
    p.outdated = { command: or.reqStr("command"), upgrade: or.ptr("upgrade") };
    or.done();
  }
  p.path = r.list("path");
  p.later = r.str("later");
  p.origin = r.str("origin");
  r.done();
  return p;
}

/** readScript reads a script as the lock writes it. */
export function readScript(v: JSONValue, path: string, errs: Errs): ScriptStep {
  const r = new ObjReader(v, path, "loadout.core.model.ScriptStep", errs);
  const s = newScriptStep({
    description: r.str("description"),
    file: r.ptr("file"),
    run: r.ptr("run"),
    check: r.ptr("check"),
    after: r.list("after"),
  });
  if (r.array("modes") !== undefined) s.modes = r.list("modes");
  s.sudo = r.flag("sudo");
  s.later = r.str("later");
  s.variants = r.map("variants", readScript);
  s.origin = r.str("origin");
  r.done();
  return s;
}

function readOutdated(v: JSONValue, path: string, errs: Errs): OutdatedSource {
  const r = new ObjReader(v, path, "loadout.core.model.OutdatedSource", errs);
  const o = newOutdatedSource({ command: r.ptr("command"), upgrade: r.ptr("upgrade"), sudo: r.flag("sudo"), origin: r.str("origin") });
  r.done();
  return o;
}

/** goAtoi is Go's strconv.Atoi: a decimal int (sign allowed, int64 range), or undefined. */
export function goAtoi(s: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(s)) return undefined;
  const n = BigInt(s);
  if (n > 9223372036854775807n || n < -9223372036854775808n) return undefined;
  return Number(n);
}

/** readLockTree reads the lock's whole tree. */
export function readLockTree(tree: JSONObject, errs: Errs): { format: number; toolVersion: string; sources: string; manifest: Manifest } {
  const r = new ObjReader(tree, "$", "loadout.core.manifest.Lock", errs);
  let format = 1;
  const f = r.get("format");
  if (f !== undefined) {
    const parsed = f instanceof JSONNumber ? goAtoi(f.text) : undefined;
    if (parsed === undefined) r.fail("Unexpected JSON token at element: $.format");
    format = parsed ?? 0;
  }
  const toolVersion = r.reqStr("toolVersion");
  const sources = r.reqStr("sources");
  const m = r.required("manifest");
  const manifest = m !== undefined ? readManifest(m, "$.manifest", errs) : newManifest();
  r.done();
  return { format, toolVersion, sources, manifest };
}
