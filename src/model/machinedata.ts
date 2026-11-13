// The per-machine `data` tables: the repo's data
// schema declares every key and its default, machines and profiles override
// them, and chezmoi templates read each machine's merged table from the
// lock. Kept as JSON values, because the model can't hold free-form tables.

import { sortStrings } from "./gostd.ts";
import { isJSONObject, JSONNumber, type JSONObject, type JSONValue, jsonEqual, jsonString } from "./json.ts";
import { sortedMap } from "./map.ts";

/** mergeData is over on top of base: tables merge key by key, anything else (lists too) replaces. */
export function mergeData(base: JSONObject, over: JSONObject): JSONObject {
  const out: JSONObject = new Map(base);
  for (const [key, value] of over) {
    const under = base.get(key);
    if (isJSONObject(under) && isJSONObject(value)) out.set(key, mergeData(under, value));
    else out.set(key, value);
  }
  return out;
}

/**
 * validateData says every key of data must be declared in defaults with the
 * same kind (string, boolean, number, list, table); errors name the dotted key.
 */
export function validateData(defaults: JSONObject, data: JSONObject, label: string, prefix: string): string[] {
  const errors: string[] = [];
  for (const [key, value] of data) {
    const p = prefix + key;
    if (!defaults.has(key)) {
      errors.push(label + ": data key '" + p + "' is not declared in the data schema");
      continue;
    }
    const declared = defaults.get(key)!;
    if (dataKind(declared) !== dataKind(value)) {
      errors.push(label + ": data key '" + p + "' is a " + dataKind(value) + ", but the data schema declares a " + dataKind(declared));
    } else if (isJSONObject(declared) && isJSONObject(value)) {
      errors.push(...validateData(declared, value, label, p + "."));
    }
  }
  return errors;
}

/**
 * dataConflicts is the dotted keys a and b both set to different values —
 * where two profiles of one `extends` list disagree. Tables are compared key
 * by key; anything else (lists too) must be equal.
 */
export function dataConflicts(a: JSONObject, b: JSONObject, prefix: string): string[] {
  const keys = sortStrings([...a.keys()].filter((k) => b.has(k)));
  const out: string[] = [];
  for (const key of keys) {
    const left = a.get(key)!;
    const right = b.get(key)!;
    if (isJSONObject(left) && isJSONObject(right)) out.push(...dataConflicts(left, right, prefix + key + "."));
    else if (!jsonEqual(left, right)) out.push(prefix + key);
  }
  return out;
}

/** DataLine is one dotted `key: value` line of dataLines. */
export interface DataLine {
  key: string;
  value: string;
}

/** dataLines is data as dotted `key: value` lines, sorted, for `explain`; values are compact JSON. */
export function dataLines(data: JSONObject, prefix: string): DataLine[] {
  const out: DataLine[] = [];
  for (const [key, value] of sortedMap(data)) {
    if (isJSONObject(value)) out.push(...dataLines(value, prefix + key + "."));
    else out.push({ key: prefix + key, value: jsonString(value) });
  }
  return out;
}

function dataKind(v: JSONValue): string {
  if (isJSONObject(v)) return "table";
  if (Array.isArray(v)) return "list";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (v instanceof JSONNumber && (v.text === "true" || v.text === "false")) return "boolean";
  // kotlinx's rule: any other primitive (null too) is a number.
  return "number";
}
