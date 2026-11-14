// The model's maps are JS Maps: string-keyed and insertion-ordered. The lock writes keys in the order they were declared
// (or sorted, when the assembler sorts them), so order is part of the model.
//
// A Map is a reference: build a new one (mapValues, plus, new Map(m))
// rather than setting into a map another value holds. A Map's `set` keeps
// an existing key in its place; `get` gives undefined for a missing key.

import { compareStrings } from "./stdlib.ts";

/** mapOf is a map of entries, in order; a repeated key keeps its first place and its last value. */
export function mapOf<V>(...entries: [string, V][]): Map<string, V> {
  return new Map(entries);
}

/** plus is m's entries, then other's, other winning a key both have (in m's place). */
export function plus<V>(m: ReadonlyMap<string, V>, other: ReadonlyMap<string, V>): Map<string, V> {
  const out = new Map(m);
  for (const [k, v] of other) out.set(k, v);
  return out;
}

/** mapValues is the same keys, in order, with f applied to each value. */
export function mapValues<V, W>(m: ReadonlyMap<string, V>, f: (key: string, value: V) => W): Map<string, W> {
  const out = new Map<string, W>();
  for (const [k, v] of m) out.set(k, f(k, v));
  return out;
}

/** sortedMap is m with its keys in name order (by UTF-8 bytes). */
export function sortedMap<V>(m: ReadonlyMap<string, V>): Map<string, V> {
  const keys = [...m.keys()].sort(compareStrings);
  return new Map(keys.map((k) => [k, m.get(k) as V]));
}

/** keysOf is the keys, in order (a fresh array). */
export function keysOf<V>(m: ReadonlyMap<string, V>): string[] {
  return [...m.keys()];
}

/** distinct is xs without repeats, first occurrences in order. */
export function distinct(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/** concat is a fresh array holding every list's elements in order. */
export function concat<T>(...lists: (readonly T[] | undefined)[]): T[] {
  const out: T[] = [];
  for (const l of lists) if (l) out.push(...l);
  return out;
}
