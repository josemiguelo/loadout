import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { types, typesFile } from "./compile.ts";
import { generate, typeCheck, typesPath } from "./sdktypes.ts";

const tsconfig = JSON.stringify({
  compilerOptions: {
    lib: ["ESNext"],
    target: "ESNext",
    module: "Preserve",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    types: ["bun"],
  },
  files: ["loadout.d.ts"],
  include: ["**/*.ts", "**/.*.ts", "**/.*/**/*.ts", "**/.*/**/.*.ts"],
});

/** A repo that uses most of both SDKs, as a config repo writes them. */
const fixture: Record<string, string> = {
  "tsconfig.json": tsconfig,
  "loadout.ts": `import { flag, include, list, repo, text } from "loadout";

await include("**/*.loadout.ts");

repo({
  name: "fixture",
  state: "machines/state",
  configs: "configs",
  minToolVersion: "0.1.0",
  data: { git: { email: text("") }, gui: flag(false), fonts: list([]) },
});
`,
  "programs/cli.loadout.ts": `import { brew, custom, dnf, installer, omarchy, program, requires, runScript, via } from "loadout";

export const mise = installer("mise", {
  probe: "mise",
  params: ["tool"],
  install: "mise use -g {tool}",
  outdatedAll: runScript(".loadout/mise.ts"),
});

export const curl = program("curl", { install: [dnf, omarchy, brew] });

export const ripgrep = program("ripgrep", {
  description: "fast grep",
  dependsOn: [curl],
  install: [via(dnf, { pkg: "ripgrep" }), via(mise, { params: { tool: "ripgrep" } }), custom({ command: "true", present: "rg" })],
  version: "rg --version",
});

requires(mise, [curl]);
`,
  "maintenance/scripts.loadout.ts": `import { args, file, outdated, runScript, script, variant } from "loadout";
import { ripgrep } from "../programs/cli.loadout.ts";

export const marker = script("marker", { managedBy: ".loadout/marker.ts", runAfter: [ripgrep] });

export const keyboard = script("keyboard", {
  description: "keyboard layout",
  variants: { arch: { run: ["true", "true"] }, fedora: { file: "keyboard.sh", check: file("check.sh") } },
});

export const markerHello = args(marker, "hello");
export const archKeyboard = variant(keyboard, "arch");

outdated("pins", { command: runScript(".loadout/pins.ts"), upgrade: runScript(".loadout/pins.ts update {item}") });
`,
  "machines/machines.loadout.ts": `import { dnf, machine, profile, variant, via } from "loadout";
import { curl, ripgrep } from "../programs/cli.loadout.ts";
import { archKeyboard, markerHello } from "../maintenance/scripts.loadout.ts";

type Data = { git: { email: string }; gui: boolean };

export const base = profile<Data>("base", { install: [curl], data: { gui: false } });

machine<Data>("box", {
  extends: [base],
  install: [via(dnf, [ripgrep]), variant(ripgrep, "dnf")],
  run: [markerHello, archKeyboard],
  data: { git: { email: "me@example.com" } },
});
`,
  "maintenance/.loadout/marker.ts": `#!/usr/bin/env bun
import { $, env, main, read } from "loadout/script";

const marker = env.fragmentDir + "/marker.txt";
await main(
  async (name) => (await read(marker)).trim() === name,
  async (name) => {
    await $\`echo \${name} > \${marker}\`;
  },
);
`,
  "maintenance/.loadout/pins.ts": `#!/usr/bin/env bun
import { clonesBehind, fastForward, formatRow, oracle, out, reason, type Row } from "loadout/script";

const clones = [{ name: "dots", dir: "/tmp/dots" }];
const rows = async (): Promise<Row[]> => [...(await clonesBehind(clones)), { item: "x", current: "1", candidate: "2" }];
await oracle({ rows, update: (item) => fastForward(clones.find((c) => c.name === item) ?? clones[0]!) });
console.error(formatRow({ item: "x", current: "1", candidate: "2" }), reason(new Error("no")), typeof out);
`,
};

test("loadout.d.ts is what the SDK sources emit now (bun run sdk-types rewrites it)", () => {
  expect(readFileSync(typesPath, "utf8")).toBe(generate());
  expect(types).toBe(readFileSync(typesPath, "utf8"));
});

test("doc comments reach the types, for the editor's hover", () => {
  expect(types).toContain("/** The built-in installers: shipped with loadout, `loadout installers` lists them. */\n  export const apt: Installer;");
  expect(types).toMatch(/\/\*\*\n {3}\* A managed script \(`managedBy: "x.ts"`\)/);
});

test("a repo type-checks against loadout.d.ts alone, and a wrong setting is a type error", () => {
  const ok = typeCheck({ ...fixture, [typesFile]: types });
  expect(ok.out).toBe("");
  expect(ok.code).toBe(0);
  const typo = typeCheck({
    ...fixture,
    [typesFile]: types,
    "programs/typo.loadout.ts": 'import { program } from "loadout";\nprogram("x", { descripton: "", install: [] });\n',
  });
  expect(typo.out).toContain("programs/typo.loadout.ts(2,16): error TS2561: Object literal may only specify known properties, but 'descripton' does not exist in type 'ProgramSpec'.");
  const none = typeCheck({ ...fixture, [typesFile]: "" });
  expect(none.out).toContain("error TS2307: Cannot find module 'loadout'");
});
