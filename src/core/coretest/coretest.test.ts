import { expect, test } from "bun:test";
import { encodeLock, resolveInstall } from "../../model/index.ts";
import { example, manifestOf, via } from "./coretest.ts";

// The fixture assembles through the production path; these keep it honest
// for the tests that lean on it.

test("the example assembles with its own installers over the built-ins", () => {
  const m = example();
  expect([...m.programs.keys()]).toEqual(["git", "ripgrep", "rustup"]);
  expect([...m.machines.keys()]).toEqual(["laptop", "macbook"]);
  expect(resolveInstall(m, "ripgrep", "dnf").command).toBe("sudo dnf install -y ripgrep");
  expect(m.builtinInstallers).not.toContain("dnf");
  expect(m.meta.minToolVersion).toBe("0.1.0");
  expect(encodeLock({ format: 0, toolVersion: "x", sources: "", manifest: m })).toContain('"example machines"');
});

test("a draft that doesn't assemble throws", () => {
  expect(() => manifestOf((b) => b.program("a", { install: via("nope") }))).toThrow("resolves to no install command");
});
