/** This binary's version: the ONE place it's written (the lock's toolVersion, --version, release tags). */
export const VERSION = "5.0.0";

/** installCommand is the curl|sh bootstrap — used by `loadout self-upgrade` and the floor refusal. */
export const installCommand = "curl -fsSL https://raw.githubusercontent.com/josemiguelo/loadout/master/install.sh | sh";

/**
 * atLeast is the numeric dotted-version comparison: is current >= required?
 * A part that isn't a number counts as 0.
 */
export function atLeast(current: string, required: string): boolean {
  const c = parts(current);
  const r = parts(required);
  for (let i = 0; i < Math.max(c.length, r.length); i++) {
    const a = c[i] ?? 0;
    const b = r[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** parts is v's dot-separated numbers, each a signed decimal 32-bit int: 0 when it isn't one. */
function parts(v: string): number[] {
  return v.split(".").map((f) => {
    if (!/^[+-]?[0-9]+$/.test(f)) return 0;
    const n = Number(f);
    return n >= -2147483648 && n <= 2147483647 ? n : 0;
  });
}
