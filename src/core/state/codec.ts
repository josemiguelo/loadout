// The state file's JSON, as kotlinx wrote it: every field in declaration
// order, nulls included (encodeDefaults), except configs, left out when
// empty; pretty-printed with a two-space indent. Unknown keys are ignored
// on read (contract 8).

import { goAtoi, isJSONObject, type JSONObject, type JSONValue, mapValues, ObjWriter, parseJSON, prettyJSON, primitive } from "../../model/index.ts";
import {
  type ConfigState,
  type ConfigStatus,
  type MachineState,
  newMachineState,
  type ProgramState,
  type ProgramStatus,
  schemaVersion,
  type ScriptState,
  type ScriptStatus,
} from "../coremodel/coremodel.ts";

/** encode is state's file content, final newline included. */
export function encode(state: MachineState): string {
  const w = new ObjWriter();
  w.any("schemaVersion", state.schemaVersion === 0 ? schemaVersion : state.schemaVersion);
  w.str("machine", state.machine);
  w.str("os", state.os);
  w.any("distro", strOrNull(state.distro));
  w.str("arch", state.arch);
  w.str("toolVersion", state.toolVersion);
  w.str("updatedAt", state.updatedAt);
  w.any(
    "programs",
    mapValues<ProgramState, JSONValue>(state.programs, (_, p) =>
      object(["status", p.status], ["version", strOrNull(p.version)], ["reason", strOrNull(p.reason)]),
    ),
  );
  w.any(
    "scripts",
    mapValues<ScriptState, JSONValue>(state.scripts, (_, s) =>
      object(["status", s.status], ["lastRun", strOrNull(s.lastRun)], ["exitCode", s.exitCode ?? null]),
    ),
  );
  if (state.configs.size > 0) {
    w.any(
      "configs",
      mapValues<ConfigState, JSONValue>(state.configs, (_, c) =>
        object(["status", c.status], ["files", [...c.files]], ["reason", strOrNull(c.reason)]),
      ),
    );
  }
  return prettyJSON(w.obj) + "\n";
}

function object(...entries: [string, JSONValue][]): JSONObject {
  return new Map(entries);
}

function strOrNull(s: string | undefined): JSONValue {
  return s === undefined ? null : s;
}

/** StateDecodeError is a state file that doesn't fit, worded as kotlinx's messages were. */
export class StateDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateDecodeError";
  }
}

/** decode reads a state file's content; throws when it can't. */
export function decode(text: string): MachineState {
  const tree = parseJSON(text);
  const d = new Decoder();
  const state = d.machineState(tree);
  if (d.err !== undefined) throw d.err;
  return state;
}

/** Decoder reads the tree; the first problem sticks. */
class Decoder {
  err?: StateDecodeError;

  fail(message: string): void {
    if (this.err === undefined) this.err = new StateDecodeError(message);
  }

  object(v: JSONValue | undefined, path: string, what: string): JSONObject {
    if (!isJSONObject(v)) {
      this.fail(`Expected JsonObject as the serialized body of ${what} at element: ${path}`);
      return new Map();
    }
    return v;
  }

  required(obj: JSONObject, key: string, path: string, what: string): JSONValue | undefined {
    if (!obj.has(key)) {
      this.fail(`Field '${key}' is required for type with serial name '${what}', but it was missing at path: ${path}`);
      return undefined;
    }
    return obj.get(key);
  }

  str(v: JSONValue | undefined, path: string): string {
    if (typeof v !== "string") {
      this.fail(`Expected a string at element: ${path}`);
      return "";
    }
    return v;
  }

  reqStr(obj: JSONObject, key: string, path: string, what: string): string {
    const v = this.required(obj, key, path, what);
    if (this.err !== undefined) return "";
    return this.str(v, path + "." + key);
  }

  optStr(obj: JSONObject, key: string, path: string): string | undefined {
    const v = obj.get(key);
    if (v === undefined || v === null) return undefined;
    return this.str(v, path + "." + key);
  }

  /** integer is v as Go's strconv.Atoi(fmt.Sprint(v)) reads it: a JSON string never counts. */
  integer(v: JSONValue, path: string): number {
    const p = primitive(v);
    const n = p === undefined || p.isString ? undefined : goAtoi(p.content);
    if (n === undefined) {
      this.fail(`Expected an int at element: ${path}`);
      return 0;
    }
    return n;
  }

  objectsOf<V>(obj: JSONObject, key: string, path: string, read: (v: JSONValue, path: string) => V): Map<string, V> {
    if (!obj.has(key)) return new Map();
    const entries = this.object(obj.get(key), path + "." + key, "kotlin.collections.LinkedHashMap");
    return mapValues(entries, (k, e) => read(e, path + "." + key + "." + k));
  }

  status<S extends string>(v: JSONValue | undefined, path: string, ...allowed: S[]): S {
    const s = this.str(v, path);
    if ((allowed as string[]).includes(s)) return s as S;
    this.fail(`unknown status '${s}' at element: ${path}`);
    return s as S;
  }

  machineState(v: JSONValue): MachineState {
    const what = serial + "MachineState";
    const obj = this.object(v, "$", what);
    if (this.err !== undefined) return newMachineState();
    const state = newMachineState({ schemaVersion });
    if (obj.has("schemaVersion")) state.schemaVersion = this.integer(obj.get("schemaVersion")!, "$.schemaVersion");
    state.machine = this.reqStr(obj, "machine", "$", what);
    state.os = this.reqStr(obj, "os", "$", what);
    state.distro = this.optStr(obj, "distro", "$");
    state.arch = this.reqStr(obj, "arch", "$", what);
    state.toolVersion = this.reqStr(obj, "toolVersion", "$", what);
    state.updatedAt = this.reqStr(obj, "updatedAt", "$", what);
    state.programs = this.objectsOf(obj, "programs", "$", (v, path): ProgramState => {
      const o = this.object(v, path, serial + "ProgramState");
      const status = this.required(o, "status", path, serial + "ProgramState");
      return {
        status: this.status<ProgramStatus>(status, path + ".status", "installed", "missing", "unknown"),
        version: this.optStr(o, "version", path),
        reason: this.optStr(o, "reason", path),
      };
    });
    state.scripts = this.objectsOf(obj, "scripts", "$", (v, path): ScriptState => {
      const o = this.object(v, path, serial + "ScriptState");
      const status = this.required(o, "status", path, serial + "ScriptState");
      const s: ScriptState = {
        status: this.status<ScriptStatus>(status, path + ".status", "done", "failed", "pending"),
        lastRun: this.optStr(o, "lastRun", path),
      };
      const e = o.get("exitCode");
      if (e !== undefined && e !== null) s.exitCode = this.integer(e, path + ".exitCode");
      return s;
    });
    state.configs = this.objectsOf(obj, "configs", "$", (v, path): ConfigState => {
      const o = this.object(v, path, serial + "ConfigState");
      const status = this.required(o, "status", path, serial + "ConfigState");
      const c: ConfigState = {
        status: this.status<ConfigStatus>(status, path + ".status", "applied", "drifted", "unknown"),
        files: [],
        reason: this.optStr(o, "reason", path),
      };
      if (o.has("files")) {
        const f = o.get("files");
        if (!Array.isArray(f)) {
          this.fail(`Expected JsonArray at element: ${path}.files`);
        } else {
          f.forEach((e, i) => c.files.push(this.str(e, `${path}.files[${i}]`)));
        }
      }
      return c;
    });
    return state;
  }
}

const serial = "loadout.core.model.";
