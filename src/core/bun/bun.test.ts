import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { binary, binVar, ensure, home, preload, preloadFile, version, wrapper } from "./bun.ts";

const saved = { data: process.env.XDG_DATA_HOME, bin: process.env[binVar] };
let data: string;

beforeEach(() => {
  data = mkdtempSync(tmpdir() + "/loadout-bun-");
  process.env.XDG_DATA_HOME = data;
  delete process.env[binVar];
});

afterEach(() => {
  for (const [k, v] of [
    ["XDG_DATA_HOME", saved.data],
    [binVar, saved.bin],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("version is the bun loadout was built with", () => {
  expect(version).toBe(Bun.version);
});

test("home is loadout's bin folder under the data folder", () => {
  expect(home()).toBe(data + "/loadout/bin");
});

test("the wrapper runs the executable as bun, quoted, preloading for a file", () => {
  expect(wrapper("/opt/it's/loadout", "/d")).toBe(
    "#!/bin/sh\n" +
      'if [ "$1" = run ] && [ -f "$2" ]; then shift; set -- run --preload \'/d/.preload.js\' "$@"\n' +
      'elif [ -f "$1" ]; then set -- --preload \'/d/.preload.js\' "$@"\n' +
      "fi\n" +
      "BUN_BE_BUN=1 exec '/opt/it'\\''s/loadout' \"$@\"\n",
  );
});

test("ensure writes the wrapper executable, and rewrites it only when it differs", () => {
  const folder = ensure("/opt/loadout");
  expect(folder).toBe(data + "/loadout/bin");
  const bun = folder + "/bun";
  expect(readFileSync(bun, "utf8")).toBe(wrapper("/opt/loadout", folder));
  expect(statSync(bun).mode & 0o777).toBe(0o755);
  const before = statSync(bun).ino;
  ensure("/opt/loadout");
  expect(statSync(bun).ino).toBe(before); // left alone
  ensure("/usr/local/bin/loadout");
  expect(readFileSync(bun, "utf8")).toBe(wrapper("/usr/local/bin/loadout", folder));
  expect(readFileSync(folder + "/" + preloadFile, "utf8")).toBe(preload);
  expect(statSync(folder + "/" + preloadFile).mode & 0o111).toBe(0); // not a command on PATH
  expect(readdirSync(folder).sort()).toEqual([".preload.js", "bun"]); // no temp file left behind
});

test("ensure makes a wrapper that lost its executable bit executable again", () => {
  const bun = ensure("/opt/loadout") + "/bun";
  chmodSync(bun, 0o644);
  ensure("/opt/loadout");
  expect(statSync(bun).mode & 0o777).toBe(0o755);
});

test("the wrapper runs the executable with BUN_BE_BUN set and the arguments as given", async () => {
  const fake = data + "/fake";
  writeFileSync(fake, '#!/bin/sh\necho "$BUN_BE_BUN" "$@"\n', { mode: 0o755 });
  const bun = ensure(fake) + "/bun";
  const proc = Bun.spawn([bun, "run", "a b.ts"], { stdout: "pipe" });
  expect(await new Response(proc.stdout).text()).toBe("1 run a b.ts\n");
});

test("the wrapper preloads the module that drops BUN_BE_BUN when it runs a file", async () => {
  const fake = data + "/fake";
  writeFileSync(fake, '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
  const folder = ensure(fake);
  const script = data + "/x.ts";
  writeFileSync(script, "");
  const out = async (...args: string[]) => new Response(Bun.spawn([folder + "/bun", ...args], { stdout: "pipe" }).stdout).text();
  const pre = folder + "/" + preloadFile;
  expect(await out(script, "a")).toBe(`--preload ${pre} ${script} a\n`);
  expect(await out("run", script)).toBe(`run --preload ${pre} ${script}\n`);
  expect(await out("install")).toBe("install\n");
});

test("LOADOUT_BUN overrides the wrapper: its folder, its binary, nothing written", () => {
  const fake = data + "/tools/bun";
  Bun.spawnSync(["mkdir", "-p", data + "/tools"]);
  writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
  process.env[binVar] = fake;
  expect(ensure("/opt/loadout")).toBe(data + "/tools");
  expect(binary(data + "/tools")).toBe(fake);
  expect(readdirSync(data)).toEqual(["tools"]);
  process.env[binVar] = data + "/nope";
  expect(() => ensure()).toThrow("LOADOUT_BUN=" + data + "/nope isn't an executable bun");
});

test("binary is the wrapper in the folder without LOADOUT_BUN", () => {
  expect(binary("/x/loadout/bin")).toBe("/x/loadout/bin/bun");
});
