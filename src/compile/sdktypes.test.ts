import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { types, typesFiles } from "./compile.ts";
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
  include: ["**/*.ts", "**/.*.ts", "**/.*/**/*.ts", "**/.*/**/.*.ts"],
});

/** The @types package compile writes, as files. */
const typesPackage = Object.fromEntries(typesFiles.map((f) => [f.path, f.content]));

/** A repo that uses most of both SDKs, as a config repo writes them. */
const fixture: Record<string, string> = {
  "tsconfig.json": tsconfig,
  "loadout.ts": `import { include, repo } from "loadout";

await include("**/*.loadout.ts");

repo({
  name: "fixture",
  stateFolder: "machines/state",
  dotfiles: "configs",
  minLoadoutVersion: "0.1.0",
  data: { git: { email: "" }, gui: false, fonts: [] as string[] },
});
`,
  "programs/cli.loadout.ts": `import { installer, program, runFile, withBrew, withCustomSteps, withDnf, withOmarchy } from "loadout";

export const mise = installer("mise", {
  neededBinary: "mise",
  installerParams: ["tool"],
  installCommand: "mise use -g {tool}",
  allOutdatedCommand: runFile(".loadout/mise.ts"),
});

export const curl = program("curl", { canBeInstalled: [withDnf, withOmarchy, withBrew] });

export const ripgrep = program("ripgrep", {
  description: "fast grep",
  dependsOn: [curl],
  canBeInstalled: [withDnf({ packageName: "ripgrep" }), mise({ tool: "ripgrep" }), withCustomSteps({ installCommand: "true", isInstalled: "rg" })],
  versionCommand: "rg --version",
  versionRegex: /ripgrep ([0-9.]+)/,
});

mise.needs(curl);
`,
  "maintenance/scripts.loadout.ts": `import { outdated, runFile, script } from "loadout";
import { ripgrep } from "../programs/cli.loadout.ts";

export const marker = script("marker", { module: () => import("./.loadout/marker.ts"), rules: () => import("./.loadout/marker.rules.ts"), runAfter: [ripgrep] });

export const keyboard = script("keyboard", {
  description: "keyboard layout",
  runCommand: runFile("keyboard.sh"),
  checkCommand: ["true", "true"],
});

export const limit = script("limit", { module: () => import("./.loadout/limit.ts"), rules: () => import("./.loadout/limit.rules.ts"), updates: () => import("./.loadout/pins.ts") });

export const markerHello = marker({ name: "hello" });

outdated("pins", { command: runFile("pins.sh") });
`,
  "machines/machines.loadout.ts": `import { machine, profile, withDnf } from "loadout";
import { curl, ripgrep } from "../programs/cli.loadout.ts";
import { keyboard, limit, markerHello } from "../maintenance/scripts.loadout.ts";

type Data = { git: { email: string }; gui: boolean };

export const base = profile<Data>("base", { install: [curl], data: { gui: false } });

machine<Data>("box", {
  extends: [base],
  install: [withDnf(ripgrep), ripgrep("custom")],
  run: [markerHello, keyboard, limit({ percent: 90 })],
  data: { git: { email: "me@example.com" } },
});
`,
  "maintenance/.loadout/marker.ts": `import { $, env, read } from "loadout/script";

const marker = env.fragmentDir + "/marker.txt";
import type { Options } from "./marker.rules.ts";
export const check = async ({ name }: Options) => (await read(marker)).trim() === name;
export async function install({ name }: Options) {
  await $\`echo \${name} > \${marker}\`;
}
`,
  "maintenance/.loadout/limit.rules.ts": `export type Options = { percent: number };
export const validate = ({ percent }: Options) => percent > 100 && "percent is at most 100";
`,
  "maintenance/.loadout/marker.rules.ts": `export type Options = { name: string };
export const validate = (_: Options) => undefined;
`,
  "maintenance/.loadout/limit.ts": `import type { Options } from "./limit.rules.ts";
export const check = async ({ percent }: Options) => percent > 0;
export async function install(options: Options) {
  if (!(await check(options))) throw new Error("no");
}
`,
  "maintenance/.loadout/pins.ts": `import { clonesBehind, fastForward, formatOutdatedItem, outputOf, reason, type OutdatedItem } from "loadout/script";

const clones = [{ name: "dots", dir: "/tmp/dots" }];
export const listOutdated = async (): Promise<OutdatedItem[]> => [...(await clonesBehind(clones)), { item: "x", current: "1", candidate: "2" }];
export const update = (item: string) => fastForward(clones.find((c) => c.name === item) ?? clones[0]!);
console.error(formatOutdatedItem({ item: "x", current: "1", candidate: "2" }), reason(new Error("no")), typeof outputOf);
`,
};

test("loadout.d.ts is what the SDK sources emit now (bun run sdk-types rewrites it)", () => {
  expect(readFileSync(typesPath, "utf8")).toBe(generate());
  expect(types).toBe(readFileSync(typesPath, "utf8"));
});

test("doc comments reach the types, for the editor's hover", () => {
  expect(types).toContain("/** The built-in installers: shipped with loadout, `loadout installers` lists them. */\n  export const withApt: Installer<never>;");
  expect(types).toMatch(/\/\*\*\n {3}\* A script a manifest runs as a command/);
});

test("a repo type-checks against node_modules/@types/loadout alone, and a wrong setting is a type error", () => {
  const ok = typeCheck({ ...fixture, ...typesPackage });
  expect(ok.out).toBe("");
  expect(ok.code).toBe(0);
  const typo = typeCheck({
    ...fixture,
    ...typesPackage,
    "programs/typo.loadout.ts": 'import { program } from "loadout";\nprogram("x", { descripton: "", install: [] });\n',
  });
  expect(typo.out).toContain("programs/typo.loadout.ts(2,16): error TS2561: Object literal may only specify known properties, but 'descripton' does not exist in type 'ProgramSpec<Way>'.");
  const options = typeCheck({
    ...fixture,
    ...typesPackage,
    "maintenance/wrong.loadout.ts":
      'import { machine, script } from "loadout";\nimport { limit } from "./scripts.loadout.ts";\nlimit({ percent: "90" });\nlimit();\nmachine("x", { run: [limit] });\nscript("y", { module: () => import("./.loadout/none.ts") });\n',
  });
  for (const line of ["(3,9)", "(4,1)", "(5,22)", "(6,36)"]) expect(options.out).toContain("maintenance/wrong.loadout.ts" + line + ": error");
  const unvalidated = typeCheck({
    ...fixture,
    ...typesPackage,
    "maintenance/.loadout/unvalidated.ts": "export const check = (o: { n: number }) => o.n > 0;\nexport const install = (o: { n: number }) => {};\n",
    "maintenance/.loadout/plain.ts": "export const check = () => true;\nexport const install = () => {};\n",
    "maintenance/.loadout/optional.ts":
      "export type Options = { n: number };\nexport const check = (o?: Options) => true;\nexport const install = (o?: Options) => {};\n",
    "maintenance/.loadout/optional.rules.ts": "export const validate = (o?: { n: number }) => undefined;\n",
    "maintenance/wrong.loadout.ts":
      'import { machine, script } from "loadout";\nscript("a", { module: () => import("./.loadout/unvalidated.ts") });\nconst plain = script("b", { module: () => import("./.loadout/plain.ts") });\nconst optional = script("c", { module: () => import("./.loadout/optional.ts"), rules: () => import("./.loadout/optional.rules.ts") });\nmachine("x", { run: [plain, optional, optional({ n: 1 })] });\nplain({ n: 1 });\nscript("d", { module: () => import("./.loadout/optional.ts"), rules: () => import("./.loadout/limit.rules.ts") });\n',
  });
  expect(unvalidated.out).toMatch(/wrong\.loadout\.ts\(2,\d+\): error/);
  expect(unvalidated.out).toMatch(/wrong\.loadout\.ts\(6,\d+\): error/);
  expect(unvalidated.out).toMatch(/wrong\.loadout\.ts\(7,\d+\): error/);
  expect(unvalidated.out).not.toMatch(/wrong\.loadout\.ts\([345],/);
  const installers = typeCheck({
    ...fixture,
    ...typesPackage,
    "programs/wrong.loadout.ts":
      'import { machine, program, withBrew } from "loadout";\nimport { curl, mise, ripgrep } from "./cli.loadout.ts";\nripgrep("linux");\ncurl("brew");\nprogram("a", { install: [mise] });\nmise({ packageName: "x" });\nwithBrew({ tool: "x" });\nmachine("m", { install: [withBrew] });\n',
  });
  for (const line of [3, 4, 5, 6, 7, 8]) expect(installers.out).toMatch(new RegExp(`programs/wrong\\.loadout\\.ts\\(${line},\\d+\\): error`));
  const none = typeCheck(fixture);
  expect(none.out).toContain("error TS2307: Cannot find module 'loadout'");
});
