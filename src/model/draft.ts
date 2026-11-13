// A manifest draft as JSON, in the lock's own shapes: the manifest as the
// lock writes it (before assembly: machines unflattened, built-ins not
// merged), plus the profiles and the installers' extra requires. What a
// repo's loadout.ts prints (the SDK's repo()) for compile to assemble.

import { machineToJSON, manifestToJSON, ObjReader, ObjWriter, readMachine, readManifest, type Errs } from "./codec.ts";
import { type JSONValue, parseJSON, prettyJSON } from "./json.ts";
import { type MachineConfig, type Manifest, newManifest } from "./manifest.ts";
import { mapValues } from "./map.ts";

/** Draft is what decodeDraft reads: the manifest, its profiles and the installers' extra requires. */
export interface DecodedDraft {
  manifest: Manifest;
  profiles: Map<string, MachineConfig>;
  requires: Map<string, string[]>;
}

/** encodeDraft is the draft's JSON. */
export function encodeDraft(m: Manifest, profiles: ReadonlyMap<string, MachineConfig>, requires: ReadonlyMap<string, string[]>): string {
  const w = new ObjWriter();
  w.any("manifest", manifestToJSON(m));
  if (profiles.size > 0) w.any("profiles", mapValues<MachineConfig, JSONValue>(profiles, (_, c) => machineToJSON(c)));
  if (requires.size > 0) w.any("requires", mapValues<string[], JSONValue>(requires, (_, v) => [...v]));
  return prettyJSON(w.obj) + "\n";
}

/**
 * decodeDraft reads encodeDraft's JSON. Throws the parser's error for text
 * that isn't JSON, and "the manifest's draft can't be read: …" for JSON that
 * isn't a draft.
 */
export function decodeDraft(text: string): DecodedDraft {
  const tree = parseJSON(text);
  const errs: Errs = {};
  const r = new ObjReader(tree, "draft", "draft", errs);
  let manifest = newManifest();
  const v = r.get("manifest");
  if (v !== undefined) manifest = readManifest(v, "draft.manifest", errs);
  const profiles = new Map<string, MachineConfig>();
  const p = r.object("profiles");
  if (p !== undefined) {
    for (const [name, v] of p) profiles.set(name, readMachine(v, "draft.profiles." + name, errs));
  }
  const requires = new Map<string, string[]>();
  const q = r.object("requires");
  if (q !== undefined) {
    for (const name of q.keys()) {
      const rr = new ObjReader(q, "draft.requires", "requires", errs);
      requires.set(name, rr.list(name));
    }
  }
  if (errs.err !== undefined) throw new Error(`the manifest's draft can't be read: ${errs.err.message}`);
  return { manifest, profiles, requires };
}
