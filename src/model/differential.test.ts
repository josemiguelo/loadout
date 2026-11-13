// The differential check: every lock this repo holds as testdata, and the
// real config repos' locks on this machine, decode and re-encode to the same
// bytes, and their chezmoi data and partial render as the Go compile wrote
// them. A real repo that isn't on this machine is skipped, and so is one
// whose lock still pins a bun (`meta.bun`, gone at the cutover: such a lock
// is refused until the repo drops the pin and compiles). Read-only: nothing
// here writes. Add a lock to `locks` to check it too.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chezmoiDataFiles } from "./chezmoidata.ts";
import { decodeLock, encodeLock } from "./lock.ts";

const root = import.meta.dir + "/../..";
const home = process.env.HOME ?? "";

const locks = [
  `${root}/internal/model/testdata/loadout.lock.json`,
  `${root}/internal/assemble/testdata/loadout.lock.json`,
  `${home}/.local/share/chezmoi__worktrees/typescript-manifests/loadout.lock.json`,
  `${home}/.local/share/chezmoi/loadout.lock.json`,
];

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `at ${i}:\n--- got\n${a.slice(Math.max(0, i - 80), i + 80)}\n--- want\n${b.slice(Math.max(0, i - 80), i + 80)}`;
}

/** pinsBun says whether the lock at path still carries the removed `meta.bun`. */
function pinsBun(path: string): boolean {
  try {
    return JSON.parse(readFileSync(path, "utf8"))?.manifest?.meta?.bun !== undefined;
  } catch {
    return false;
  }
}

for (const path of locks) {
  const present = existsSync(path) && !pinsBun(path);
  test.skipIf(!present)(`${path} re-encodes byte for byte`, () => {
    const text = readFileSync(path, "utf8");
    const got = encodeLock(decodeLock(text));
    if (got !== text) throw new Error("re-encoded lock differs " + firstDiff(got, text));
    expect(got).toBe(text);
  });

  // A real repo's compile wrote its chezmoi files beside the lock.
  const repo = path.slice(0, -"/loadout.lock.json".length);
  test.skipIf(!present || path.includes("/testdata/"))(`${repo}'s chezmoi files render byte for byte`, () => {
    const lock = decodeLock(readFileSync(path, "utf8"));
    const configs = lock.manifest.layout.configs;
    if (configs === undefined) return;
    for (const [file, content] of chezmoiDataFiles(lock.manifest, configs)) {
      if (!existsSync(`${repo}/${file}`)) continue;
      const want = readFileSync(`${repo}/${file}`, "utf8");
      if (content !== want) throw new Error(`${file} differs ` + firstDiff(content, want));
    }
  });
}
