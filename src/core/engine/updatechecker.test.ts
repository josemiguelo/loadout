import { expect, test } from "bun:test";
import { assembleWithoutFiles, newManifestDraft } from "../../assemble/index.ts";
import { custom, manifestOf, variants, version } from "../coretest/coretest.ts";
import { exit, newRunner, type Runner, stderr, stdout } from "../exec/fakeexec/fakeexec.ts";
import { newCommandFrame } from "../exec/index.ts";
import {
  type Installer,
  ManifestException,
  mapOf,
  newInstaller,
  newInstallVariant,
  newManifest,
  newOutdatedSource,
  newRepoLayout,
  newVersionCheck,
  resolveInstall,
} from "../../model/index.ts";
import { contains, refused } from "./testhelpers.ts";
import { newUpdateChecker, type SourceRow, type UpdateChecker } from "./updatechecker.ts";

const noFrame = newCommandFrame("", undefined, undefined);

function updates(runner: Runner): UpdateChecker {
  return newUpdateChecker(runner, noFrame);
}

test("candidate parsed even on non-zero exit", async () => {
  // dnf check-update prints the update line and exits 100.
  const runner = newRunner().onCommand("dnf -q check-update ripgrep", stdout("ripgrep.x86_64  15.2.0-1.fc44  updates"), exit(100));
  expect(await updates(runner).candidate(version("dnf -q check-update ripgrep", String.raw`([0-9]+\.[0-9][0-9.]*)`))).toBe("15.2.0");
});

test("no output means up to date", async () => {
  const runner = newRunner().onCommand("brew outdated --verbose ripgrep");
  expect(await updates(runner).candidate(version("brew outdated --verbose ripgrep", "([0-9.]+)"))).toBeUndefined();
});

test("outdated resolves through installer with pkg substitution", () => {
  const manifest = manifestOf((b) => {
    b.installer("dnf", {
      install: "sudo dnf install -y {pkg}",
      check: "rpm -q {pkg}",
      outdated: "dnf -q check-update {pkg}",
      regex: "([0-9.]+)",
    });
    b.program("zlib-devel", { install: variants(["dnf", newInstallVariant({ pkg: "zlib-ng" })]) });
  });
  const resolved = resolveInstall(manifest, "zlib-devel", "dnf");
  expect(resolved.outdated?.command).toBe("dnf -q check-update zlib-ng");
  expect(resolved.outdated?.regex).toBe("([0-9.]+)");

  // No oracle declared -> undefined.
  const bare = manifestOf((b) => b.program("x", { install: custom("manual", "true") }));
  expect(resolveInstall(bare, "x", "manual").outdated).toBeUndefined();
});

test("batch candidates parse pkg and candidate text", async () => {
  const runner = newRunner().onCommand("list-outdated", stdout("kitty 0.48.2-1.fc44\nobsidian Version: 1.13.7\n\nmalformed\n"), exit(100));
  const batch = await updates(runner).batchCandidates("list-outdated", "", []);
  expect(batch.get("kitty")).toBe("0.48.2-1.fc44");
  expect(batch.get("obsidian")).toBe("Version: 1.13.7");
  expect(batch.size).toBe(2);
});

test("outdated-all resolves per installer and variant override wins", () => {
  const manifest = manifestOf((b) => {
    b.installer("dnf", {
      install: "sudo dnf install -y {pkg}",
      check: "rpm -q {pkg}",
      outdated: "dnf -q check-update {pkg}",
      outdatedAll: "dnf -q check-update",
      regex: "([0-9.]+)",
    });
    b.program("kitty", { install: variants(["dnf", newInstallVariant({ pkg: "kitty-terminal" })]) });
    b.program("special", { install: variants(["dnf", newInstallVariant({ outdated: "custom-oracle" })]) });
  });
  // Batch oracle covers the plain variant; per-pkg pattern is not used.
  const batched = resolveInstall(manifest, "kitty", "dnf");
  expect(batched.outdated).toBeUndefined();
  const o = batched.outdatedAll!;
  expect([o.installer, o.command, o.pkg, o.regex]).toEqual(["dnf", "dnf -q check-update", "kitty-terminal", "([0-9.]+)"]);
  // An explicit variant oracle overrides the batch.
  const explicit = resolveInstall(manifest, "special", "dnf");
  expect(explicit.outdatedAll).toBeUndefined();
  expect(explicit.outdated?.command).toBe("custom-oracle");
});

test("custom source rows parse and validate", async () => {
  const runner = newRunner().onCommand(
    "plugin-sweep",
    stdout(
      "java 9bd89aa ea1fe99\nruby fa85ede 498c76f extra\n" +
        "go 1111111 2222222 3 commit(s) behind https://github.com/x/go/compare/1111111...2222222\nmalformed line\n",
    ),
  );
  const result = await updates(runner).sourceRows("plugin-sweep", "", []);
  expect(result.error).toBeUndefined();
  expect(result.rows.length).toBe(3);
  const row = (r: SourceRow) => r.name + "|" + r.current + "|" + r.candidate + "|" + r.note + "|" + (r.link ?? "");
  expect(result.rows.map(row)).toEqual([
    "java|9bd89aa|ea1fe99||",
    "ruby|fa85ede|498c76f|extra|",
    // A URL in the tail is the row's link, lifted out of the note.
    "go|1111111|2222222|3 commit(s) behind|https://github.com/x/go/compare/1111111...2222222",
  ]);

  const manifest = manifestOf((b) => b.outdated("asdf-plugins", { command: "sh sweep.sh" }));
  expect(manifest.outdated.get("asdf-plugins")!.command).toBe("sh sweep.sh");

  const message = await refused(ManifestException, () =>
    assembleWithoutFiles(
      newManifestDraft({
        manifest: newManifest({ layout: newRepoLayout({ state: "state" }), outdated: mapOf(["broken", newOutdatedSource()]) }),
      }),
    ),
  );
  contains(message, "outdated.broken needs a command");
});

test("custom source non-zero exit is reported as error not empty rows", async () => {
  // A crashed/failing source must NOT look like "nothing outdated": its
  // exit code and last stderr line become a surfaced error, no rows.
  const runner = newRunner().onCommand(
    "flaky-oracle",
    exit(1),
    stdout("java 9bd89aa ea1fe99\n"),
    stderr("warming up\nfatal: could not fetch remote\n"),
  );
  const result = await updates(runner).sourceRows("flaky-oracle", "", []);
  expect(result.rows).toEqual([]);
  expect(result.error).toBe("exited 1: fatal: could not fetch remote");
});

test("custom source missing binary is reported as error", async () => {
  // Unregistered command = exit 127 (missing binary) -> loud error.
  const result = await updates(newRunner()).sourceRows("no-such-oracle", "", []);
  expect(result.rows).toEqual([]);
  contains(result.error!, "exited 127");
});

/** A front end always gives an installer a regex; a lock written otherwise is still refused. */
function installerOnly(installer: Partial<Installer>): () => unknown {
  return () =>
    assembleWithoutFiles(
      newManifestDraft({
        manifest: newManifest({ layout: newRepoLayout({ state: "state" }), installers: mapOf(["bad", newInstaller(installer)]) }),
      }),
    );
}

test("outdated-all without regex is rejected", async () => {
  contains(await refused(ManifestException, installerOnly({ install: "install {pkg}", outdatedAll: "query" })), "outdated-all command but no regex");
});

test("outdated without regex is rejected", async () => {
  contains(await refused(ManifestException, installerOnly({ install: "install {pkg}", outdated: "query {pkg}" })), "outdated command but no regex");
});

test("a program's path comes first for its outdated check", async () => {
  const runner = newRunner().onCommand(`PATH="\${LOADOUT_BUN_DIR:+$LOADOUT_BUN_DIR:}/opt/x:$PATH"; export PATH; x latest`, stdout("2.0.0"));
  const vc = newVersionCheck({ command: "x latest", regex: "([0-9.]+)", path: ["/opt/x"] });
  expect(await updates(runner).candidate(vc)).toBe("2.0.0");
});
