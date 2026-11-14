import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { binVar, ensure, home, preload, preloadFile, sdkModules, version, wrapper } from "./bun.ts";

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

test("the wrapper runs the executable as bun, quoted, preloading for a file, or $LOADOUT_BUN", () => {
  expect(wrapper("/opt/it's/loadout", "/d")).toBe(
    "#!/bin/sh\n" +
      'if [ "$1" = run ] && [ -f "$2" ]; then shift; set -- run --preload \'/d/.preload.js\' "$@"\n' +
      'elif [ -f "$1" ]; then set -- --preload \'/d/.preload.js\' "$@"\n' +
      "fi\n" +
      'if [ -n "$LOADOUT_BUN" ]; then exec "$LOADOUT_BUN" "$@"; fi\n' +
      "BUN_BE_BUN=1 exec '/opt/it'\\''s/loadout' \"$@\"\n",
  );
});

test("the preload drops BUN_BE_BUN and registers the SDKs as modules, from the embedded sources", async () => {
  expect(preload.startsWith("delete process.env.BUN_BE_BUN;\n")).toBe(true);
  expect(sdkModules.map(([name]) => name)).toEqual(["loadout", "loadout/script"]);
  expect(sdkModules[0]![1]).toBe(await Bun.file(import.meta.dir + "/../../compile/sdk/loadout.sdk.ts").text());
  expect(sdkModules[1]![1]).toBe(await Bun.file(import.meta.dir + "/../../compile/sdk/loadout.script.ts").text());
  const folder = ensure("/opt/loadout");
  const dir = mkdtempSync(tmpdir() + "/loadout-preload-");
  writeFileSync(dir + "/a.ts", 'import { apt } from "loadout";\nexport const name = apt.name;\n');
  writeFileSync(
    dir + "/x.ts",
    'import { apt, program } from "loadout";\nimport { formatRow } from "loadout/script";\nimport { name } from "./a.ts";\n' +
      'console.log(typeof program, apt === (await import("loadout")).apt, name, formatRow({ item: "i", current: "1", candidate: "2" }), process.env.BUN_BE_BUN);\n',
  );
  const proc = Bun.spawn([process.execPath, "--preload", folder + "/" + preloadFile, dir + "/x.ts"], {
    cwd: dir,
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect((await new Response(proc.stderr).text()) + (await new Response(proc.stdout).text())).toBe("function true apt i 1 2 undefined\n");
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

test("with LOADOUT_BUN, the wrapper execs that bun, preloading for a file, without BUN_BE_BUN", async () => {
  const fake = data + "/tools/bun";
  Bun.spawnSync(["mkdir", "-p", data + "/tools"]);
  writeFileSync(fake, '#!/bin/sh\necho "other[$BUN_BE_BUN]" "$@"\n', { mode: 0o755 });
  process.env[binVar] = fake;
  const folder = ensure("/opt/loadout");
  expect(folder).toBe(data + "/loadout/bin");
  const script = data + "/x.ts";
  writeFileSync(script, "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "BUN_BE_BUN"));
  const out = async (...args: string[]) => new Response(Bun.spawn([folder + "/bun", ...args], { env, stdout: "pipe" }).stdout).text();
  expect(await out("run", script)).toBe(`other[] run --preload ${folder}/${preloadFile} ${script}\n`);
  expect(await out("install")).toBe("other[] install\n");
  process.env[binVar] = data + "/nope";
  expect(() => ensure()).toThrow("LOADOUT_BUN=" + data + "/nope isn't an executable bun");
});
