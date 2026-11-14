import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VERSION } from "../version.ts";
import { commandHelp, renderHelp, wrap } from "./help.ts";
import { renderScaffold } from "./init.ts";
import { newRoot } from "./root.ts";
import { streams } from "./spinner.ts";
import { suggest } from "./errors.ts";
import { attention, echoRows, severe } from "./table.ts";

/**
 * capture is what f echoes on stdout (tests run without a terminal, so
 * nothing is styled).
 */
function capture(f: () => void): string {
  let b = "";
  const saved = streams.stdout;
  streams.stdout = { write: (t) => void (b += t) };
  try {
    f();
  } finally {
    streams.stdout = saved;
  }
  return b;
}

function golden(name: string): string {
  const text = readFileSync(new URL("./testdata/" + name, import.meta.url), "utf8");
  return text.replaceAll("{{VERSION}}", VERSION);
}

// The help layout, off a terminal (79 columns), pinned byte for byte.
test("help is laid out as the golden files have it", () => {
  const root = newRoot();
  expect(renderHelp(root).startsWith(golden("root-help-head.txt"))).toBe(true);
  const upgrade = root.commands.find((sub) => sub.name === "upgrade")!;
  expect(renderHelp(upgrade)).toBe(golden("upgrade-help.txt"));
});

test("command help aligns the detail lines", () => {
  expect(commandHelp("Do it.", "--a  first", "--long  second", "[x]")).toBe("Do it.\n  --a     first\n  --long  second\n  [x]");
});

test("wrap keeps indentation and breaks at the last space that fits", () => {
  expect(wrap("  --item x  one two three\nshort", 15)).toEqual(["  --item x  one", "two three", "short"]);
});

test("suggestions say did you mean, or list the close names", () => {
  expect(suggest("--jsn", ["--json", "--no-write", "--help"], "options")).toBe(". Did you mean --json?");
  expect(suggest("--verbos", ["--version", "--repo", "--machine", "--verbose", "--help"], "options")).toBe(
    ". (Possible options: --verbose, --version, --repo)",
  );
  expect(suggest("help", ["status", "install"], "subcommands")).toBe("");
});

test("unsettled rows share one box that is severe if any row is", () => {
  const out = capture(() =>
    echoRows([
      { lines: ["ok row"] },
      { lines: ["pending"], severity: attention },
      { lines: ["missing", "  detail"], severity: severe },
      { lines: ["last"] },
    ]),
  );
  expect(out).toBe(
    "  ok row\n" + "╭──────────╮\n" + "│ pending  │\n" + "│ missing  │\n" + "│   detail │\n" + "╰──────────╯\n" + "  last\n",
  );
});

test("scaffold values are escaped inside TypeScript strings", () => {
  const files = renderScaffold("child", { hostname: "box", parentName: `my "pub"`, parentPath: `~/a\\b`, parentImport: "../dots" });
  const paths = new Map(files.map((f) => [f.path, f.content]));
  expect(paths.has("machines/box.loadout.ts")).toBe(true);
  const root = paths.get("loadout.ts")!;
  expect(root).toContain(`name: "my \\"pub\\""`);
  expect(root).toContain(`path: "~/a\\\\b"`);
  expect(paths.get("tsconfig.json")).toContain(`"parent/*": ["../dots/*"]`);
  expect(paths.get("node_modules/@types/loadout/index.d.ts")).toContain(`declare module "loadout" {`);
});
