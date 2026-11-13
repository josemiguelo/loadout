import { distinct, keysOf, plus } from "../model/index.ts";
import { atLeast } from "../version.ts";
import type { ManifestDraft } from "./assemble.ts";

/**
 * draftOver is a child repo's draft (contract 18): child's declarations over
 * parent's. The parent's installers, programs,
 * scripts, outdated sources, profiles and data schema join the child's; its
 * machines don't, and nor do its meta and layout. A name both repos declare
 * is an error naming the parent, as is a child data schema. The repo floor
 * is the higher of the two.
 *
 * The errors come back for the caller to report as one refusal, after its
 * own front-end errors and the parent's (each prefixed "parent <name>: "),
 * repeats dropped; the draft is meaningful only when there are none.
 */
export function draftOver(child: ManifestDraft, parent: ManifestDraft, parentName: string): [ManifestDraft, string[]] {
  const label = "parent " + parentName;
  const errors: string[] = [];
  if (child.manifest.data.size > 0) {
    errors.push("a child repo's data schema is its parent's — drop its data {} block");
  }
  const clash = (kind: string, mine: string[], theirs: string[]) => {
    const have = new Set(theirs);
    for (const n of mine) if (have.has(n)) errors.push(kind + " '" + n + "' is declared by " + label + " too");
  };
  const c = child.manifest;
  const p = parent.manifest;
  clash("installer", keysOf(c.installers), keysOf(p.installers));
  clash("program", keysOf(c.programs), keysOf(p.programs));
  clash("script", keysOf(c.scripts), keysOf(p.scripts));
  clash("outdated source", keysOf(c.outdated), keysOf(p.outdated));
  clash("profile", keysOf(child.profiles), keysOf(parent.profiles));
  for (const name of c.machines.keys()) {
    if (p.machines.has(name)) errors.push("machine '" + name + "' is declared by " + label + " too — a machine belongs to one repo");
  }

  let floor = c.meta.minToolVersion;
  const theirs = p.meta.minToolVersion;
  if (theirs !== undefined && (floor === undefined || !atLeast(floor, theirs))) floor = theirs;
  const requires = new Map<string, string[]>();
  for (const name of plus(parent.requires, child.requires).keys()) {
    requires.set(name, distinct([...(parent.requires.get(name) ?? []), ...(child.requires.get(name) ?? [])]));
  }
  const out: ManifestDraft = {
    ...child,
    manifest: {
      ...c,
      // The child's own bun, else the parent's: its scripts run with one bun.
      meta: { ...c.meta, minToolVersion: floor, bun: c.meta.bun ?? p.meta.bun },
      installers: plus(p.installers, c.installers),
      programs: plus(p.programs, c.programs),
      scripts: plus(p.scripts, c.scripts),
      outdated: plus(p.outdated, c.outdated),
      data: p.data,
    },
    profiles: plus(parent.profiles, child.profiles),
    requires,
  };
  return [out, errors];
}

/**
 * declaredNames is what draft declares, as warnings name it ("program 'x'"):
 * a child's compile doesn't warn about its parent's.
 */
export function declaredNames(draft: ManifestDraft): string[] {
  const names: string[] = [];
  const add = (kind: string, keys: Iterable<string>) => {
    for (const k of keys) names.push(kind + " '" + k + "'");
  };
  add("installer", draft.manifest.installers.keys());
  add("program", draft.manifest.programs.keys());
  add("script", draft.manifest.scripts.keys());
  add("profile", draft.profiles.keys());
  return names;
}
