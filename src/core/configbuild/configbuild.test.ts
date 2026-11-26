import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { newManifest, newRepoLayout, type RepoLayout } from "../../model/index.ts";
import { carryOver, drift, driftMessage, globDirs, parentPlan, planBuild, refreshBuilds, snapshot, type Snapshot, targetName, targetOf, writeBuild } from "./configbuild.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** repo is a temp repo holding files (path → content). */
function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "configbuild-"));
  roots.push(root);
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  return root;
}

const layout = (more: Partial<RepoLayout> = {}): RepoLayout =>
  newRepoLayout({ state: "state", configs: ".home", rootConfigs: ".root", build: { tools: "tools/*" }, ...more });

const kit = {
  "tools/zsh/zsh.loadout.ts": "",
  "tools/zsh/.loadout/plugins.ts": "",
  "tools/zsh/home/dot_zshenv": "export ZDOTDIR\n",
  "tools/zsh/home/private_dot_config/zsh/dot_zshrc.tmpl": "{{ .chezmoi.os }}\n",
  "tools/zsh/home/.chezmoiignore": ".config/zsh/.zcompdump\n",
  "tools/keychron/keychron.loadout.ts": "",
  "tools/keychron/root/etc/udev/rules.d/50-k.rules": "rule\n",
  "tools/git/git.loadout.ts": "",
};

test("each tool's home/ and root/ go into their builds as symlinks to the tool's files", () => {
  const root = repo(kit);
  const plan = planBuild(root, layout())!;
  expect(plan.tools.map((t) => [t.name, t.home, t.root])).toEqual([
    ["git", false, false],
    ["keychron", false, true],
    ["zsh", true, false],
  ]);
  writeBuild(root, plan);
  expect(fs.readlinkSync(path.join(root, ".home/private_dot_config/zsh/dot_zshrc.tmpl"))).toBe(
    "../../../tools/zsh/home/private_dot_config/zsh/dot_zshrc.tmpl",
  );
  expect(fs.readlinkSync(path.join(root, ".root/etc/udev/rules.d/50-k.rules"))).toBe("../../../../tools/keychron/root/etc/udev/rules.d/50-k.rules");
  // A tool's manifest and .loadout/ are no chezmoi source.
  expect(fs.existsSync(path.join(root, ".home/zsh.loadout.ts"))).toBe(false);
  expect(fs.readFileSync(path.join(root, ".home/.chezmoiignore"), "utf8")).toContain("# tools/zsh/home/.chezmoiignore\n.config/zsh/.zcompdump\n");
  // The root build reads the templates' data compile writes into the home build.
  expect(fs.readlinkSync(path.join(root, ".root/.chezmoidata/loadout.json"))).toBe("../../.home/.chezmoidata/loadout.json");
  expect(drift(root, plan)).toEqual({ writes: [], strays: [], stale: [] });
});

test("from is merged into the home build as it stands, without the data compile writes there", () => {
  const root = repo({ ...kit, "legacy/dot_vimrc": "set nu\n", "legacy/.chezmoidata/loadout.json": "{}", "legacy/.chezmoiremove": ".old\n" });
  const plan = planBuild(root, layout({ build: { tools: "tools/*", from: "legacy" } }))!;
  writeBuild(root, plan);
  expect(fs.readlinkSync(path.join(root, ".home/dot_vimrc"))).toBe("../legacy/dot_vimrc");
  expect(fs.existsSync(path.join(root, ".home/.chezmoidata/loadout.json"))).toBe(false);
  expect(fs.readFileSync(path.join(root, ".home/.chezmoiremove"), "utf8")).toContain("# legacy/.chezmoiremove\n.old\n");
});

test("a file two tools land in the same place is refused, naming both", () => {
  const root = repo({ ...kit, "tools/bash/home/dot_zshenv": "x\n" });
  expect(() => planBuild(root, layout())).toThrow("~/.zshenv is in both bash and zsh");
  const differently = repo({ ...kit, "tools/bash/home/dot_config/x": "x\n" });
  expect(() => planBuild(differently, layout())).toThrow("~/.config is dot_config in bash and private_dot_config in zsh");
});

test("what the layout can't build is refused", () => {
  expect(() => planBuild(repo({ ...kit, "tools/x/root/home/me/dot_x": "" }), layout())).toThrow("x: /home is in a home: it goes in home/");
  expect(() => planBuild(repo(kit), layout({ rootConfigs: undefined }))).toThrow("tool keychron has root/, and dotfiles has no root");
  expect(() => planBuild(repo(kit), layout({ build: { tools: "tools/*", from: "tools/zsh" } }))).toThrow("overlaps from tools/zsh");
  expect(() => planBuild(repo(kit), layout({ build: { tools: "tools/*", from: "legacy" } }))).toThrow("from legacy is not a folder");
});

test("a folder in a tool that isn't home/ or root/ is warned about", () => {
  const root = repo({ ...kit, "tools/zsh/hom/dot_x": "" });
  expect(planBuild(root, layout())!.warnings).toEqual(["tools/zsh/hom is in a tool folder but isn't home/ or root/"]);
});

test("drift tells chezmoi's writes and strays from a build that's behind", () => {
  const root = repo(kit);
  const plan = planBuild(root, layout())!;
  writeBuild(root, plan);
  // re-add: the symlink became a file.
  fs.rmSync(path.join(root, ".home/dot_zshenv"));
  fs.writeFileSync(path.join(root, ".home/dot_zshenv"), "edited\n");
  // add: a file from no tool.
  fs.writeFileSync(path.join(root, ".home/dot_newrc"), "new\n");
  const d = drift(root, plan);
  expect(d.writes).toEqual([{ build: ".home/dot_zshenv", source: "tools/zsh/home/dot_zshenv", target: "~/.zshenv" }]);
  expect(d.strays).toEqual([".home/dot_newrc"]);
  // Both ways out work with an ignored build: re-add carries it, deleting it relinks.
  expect(driftMessage(d)).toContain(
    "keep it with `loadout chezmoi re-add ~/.zshenv` (or copy it over tools/zsh/home/dot_zshenv), or drop it by deleting .home/dot_zshenv",
  );
  // A new tool file the build hasn't seen: compile's to fix.
  const fresh = repo(kit);
  const p2 = planBuild(fresh, layout())!;
  writeBuild(fresh, p2);
  fs.writeFileSync(path.join(fresh, "tools/zsh/home/dot_zprofile"), "");
  expect(driftMessage(drift(fresh, planBuild(fresh, layout())!))).toBe(".home/dot_zprofile doesn't match the tool folders — run: loadout compile");
});

test("writeBuild removes what no tool has any more and keeps compile's own files", () => {
  const root = repo(kit);
  writeBuild(root, planBuild(root, layout())!);
  fs.mkdirSync(path.join(root, ".home/.chezmoidata"), { recursive: true });
  fs.writeFileSync(path.join(root, ".home/.chezmoidata/loadout.json"), "{}");
  fs.rmSync(path.join(root, "tools/zsh/home/dot_zshenv"));
  const plan = planBuild(root, layout())!;
  writeBuild(root, plan);
  expect(fs.existsSync(path.join(root, ".home/dot_zshenv"))).toBe(false);
  expect(fs.readFileSync(path.join(root, ".home/.chezmoidata/loadout.json"), "utf8")).toBe("{}");
  expect(drift(root, plan).stale).toEqual([]);
});

test("a snapshot names each symlink's tool file, repo-relative", () => {
  const root = repo(kit);
  const plan = planBuild(root, layout())!;
  writeBuild(root, plan);
  expect(snapshot(root, plan.home).get("private_dot_config/zsh/dot_zshrc.tmpl")).toEqual({
    kind: "link",
    source: "tools/zsh/home/private_dot_config/zsh/dot_zshrc.tmpl",
  });
});

test("names land as chezmoi lands them: its own answers, from chezmoi managed", () => {
  // Each pair is what chezmoi 2.73 said for that source name (no encryption configured).
  const files: [string, string][] = [
    ["after_install.sh", "after_install.sh"],
    ["before_x.txt", "before_x.txt"],
    ["create_empty_dot_ce", ".ce"],
    ["create_private_dot_c.tmpl", ".c"],
    ["dot_l.literal", ".l"],
    ["dot_t.tmpl", ".t"],
    ["dot_t2.tmpl.literal", ".t2.tmpl"],
    ["empty_dot_e", ".e"],
    ["encrypted_dot_ag.age", ".ag.age"],
    ["encrypted_private_dot_z.asc", ".z.asc"],
    ["executable_dot_x.tmpl", ".x"],
    ["executable_empty_dot_ee", "empty_dot_ee"],
    ["executable_private_y", "private_y"],
    ["literal_dot_lit", "dot_lit"],
    ["modify_private_dot_m", ".m"],
    ["once_upon.txt", "once_upon.txt"],
    ["onchange_x.txt", "onchange_x.txt"],
    ["private_executable_dot_pe", ".pe"],
    ["private_private_x", "private_x"],
    ["pubkey.asc", "pubkey.asc"],
    ["readonly_dot_ro", ".ro"],
    ["remove_dot_r", ".r"],
    ["run_once_before_init.sh", "init.sh"],
    ["run_onchange_after_reload.sh", "reload.sh"],
    ["run_x.sh", "x.sh"],
    ["symlink_dot_s.tmpl", ".s"],
  ];
  for (const [source, target] of files) expect([source, targetName(source, false)]).toEqual([source, target]);
  const dirs: [string, string][] = [
    ["exact_private_dot_dd", ".dd"],
    ["external_dot_xd", ".xd"],
    ["literal_dot_ld", "dot_ld"],
    ["private_exact_pe", "exact_pe"],
    ["readonly_private_dot_rp", "private_dot_rp"],
    ["remove_dot_rd", ".rd"],
    ["private_dot_config", ".config"],
  ];
  for (const [source, target] of dirs) expect([source, targetName(source, true)]).toEqual([source, target]);
  const root = repo(kit);
  const plan = planBuild(root, layout())!;
  expect(targetOf(plan.home, "private_dot_config/zsh/dot_zshrc.tmpl")).toBe("~/.config/zsh/.zshrc");
  expect(targetOf(plan.root!, "etc/udev/rules.d/50-k.rules")).toBe("/etc/udev/rules.d/50-k.rules");
});

test("names chezmoi keeps apart aren't a clash: after_install.sh beside install.sh, pubkey.asc beside pubkey", () => {
  const root = repo({ ...kit, "tools/zsh/home/after_install.sh": "", "tools/zsh/home/install.sh": "", "tools/zsh/home/pubkey.asc": "", "tools/zsh/home/pubkey": "" });
  expect(() => planBuild(root, layout())).not.toThrow();
});

test("what can't be built is refused by name: a dangling symlink, loadout's own data, one .chezmoi file in two tools", () => {
  const dangling = repo(kit);
  fs.symlinkSync("nowhere", path.join(dangling, "tools/zsh/home/dot_gone"));
  expect(() => planBuild(dangling, layout())).toThrow("tools/zsh/home/dot_gone is a symlink to nothing");
  expect(() => planBuild(repo({ ...kit, "tools/zsh/home/.chezmoidata/loadout.json": "{}" }), layout())).toThrow(
    "tools/zsh/home/.chezmoidata/loadout.json is loadout's own (the templates' data): rename it",
  );
  expect(() => planBuild(repo({ ...kit, "tools/zsh/home/.chezmoiexternal.toml": "", "tools/git/home/.chezmoiexternal.toml": "" }), layout())).toThrow(
    ".chezmoiexternal.toml is in both git and zsh: one tool keeps it",
  );
});

test("the tools glob matches folders, dot folders too", () => {
  const root = repo({ "tools/a/x": "", "tools/.b/x": "", "tools/a/deep/x": "", "tools/file": "" });
  expect(globDirs(root, "tools/*")).toEqual(["tools/.b", "tools/a"]);
  // `**` is zero or more segments, as include() reads it.
  expect(globDirs(root, "tools/**")).toEqual(["tools", "tools/.b", "tools/a", "tools/a/deep"]);
});

const manifestWith = (l: RepoLayout) => ({ ...newManifest(), layout: l });

test("refreshBuilds makes the builds and their templates' data, and leaves a chezmoi write alone", () => {
  const root = repo(kit);
  const m = manifestWith(layout());
  refreshBuilds(root, m, "");
  expect(fs.readlinkSync(path.join(root, ".home/dot_zshenv"))).toBe("../tools/zsh/home/dot_zshenv");
  expect(fs.readFileSync(path.join(root, ".home/.chezmoidata/loadout.json"), "utf8")).toContain('"loadout"');
  expect(fs.existsSync(path.join(root, ".home/.chezmoitemplates/loadout/machine"))).toBe(true);
  fs.rmSync(path.join(root, ".home/dot_zshenv"));
  fs.writeFileSync(path.join(root, ".home/dot_zshenv"), "edited\n");
  fs.writeFileSync(path.join(root, "tools/zsh/home/dot_zprofile"), "");
  refreshBuilds(root, m, "");
  expect(fs.readFileSync(path.join(root, ".home/dot_zshenv"), "utf8")).toBe("edited\n");
  expect(fs.existsSync(path.join(root, ".home/dot_zprofile"))).toBe(false);
});

test("a child builds its parent's tool folders into its own .loadout-parent/, writing nothing in the parent", () => {
  const parent = repo(kit);
  const child = repo({ "loadout.ts": "" });
  const m = manifestWith(
    newRepoLayout({
      state: "state",
      parent: { name: "dots", path: parent, state: "state", configs: ".home", rootConfigs: ".root", build: { tools: "tools/*" }, sources: [], hash: "" },
    }),
  );
  const before = fs.readdirSync(parent).sort();
  refreshBuilds(child, m, parent);
  expect(fs.readdirSync(parent).sort()).toEqual(before);
  expect(fs.realpathSync(path.join(child, ".loadout-parent/home/dot_zshenv"))).toBe(fs.realpathSync(path.join(parent, "tools/zsh/home/dot_zshenv")));
  expect(fs.realpathSync(path.join(child, ".loadout-parent/root/etc/udev/rules.d/50-k.rules"))).toBe(
    fs.realpathSync(path.join(parent, "tools/keychron/root/etc/udev/rules.d/50-k.rules")),
  );
  expect(fs.existsSync(path.join(child, ".loadout-parent/home/.chezmoidata/loadout.json"))).toBe(true);
  expect(drift(parent, parentPlan(m, parent, child)!)).toEqual({ writes: [], strays: [], stale: [] });
});

test("a joined file no part has any more is a leftover writeBuild removes, not a stray that blocks the repo", () => {
  const root = repo(kit);
  writeBuild(root, planBuild(root, layout())!);
  expect(fs.existsSync(path.join(root, ".home/.chezmoiignore"))).toBe(true);
  fs.rmSync(path.join(root, "tools/zsh/home/.chezmoiignore"));
  const plan = planBuild(root, layout())!;
  const d = drift(root, plan);
  expect(d.strays).toEqual([]);
  expect(d.stale).toEqual([".home/.chezmoiignore"]);
  writeBuild(root, plan);
  expect(fs.existsSync(path.join(root, ".home/.chezmoiignore"))).toBe(false);
  expect(driftMessage(drift(root, plan))).toBeUndefined();
});

// carryOver: what a chezmoi command did to a build, brought to the tool folders.

const snaps = (root: string, plan: ReturnType<typeof planBuild>): Map<"home" | "root", Snapshot> =>
  new Map([["home", snapshot(root, plan!.home)], ["root", snapshot(root, plan!.root!)]]);
const replaceLink = (root: string, rel: string, text: string) => {
  fs.rmSync(path.join(root, rel));
  fs.writeFileSync(path.join(root, rel), text);
};

test("carryOver: a symlink turned file is the tool file's new content, and so is one a plain chezmoi re-add left", () => {
  const root = repo(kit);
  let plan = planBuild(root, layout())!;
  writeBuild(root, plan);
  // A plain `chezmoi re-add` before: already a file when the command starts.
  replaceLink(root, ".home/dot_zshenv", "left by plain chezmoi\n");
  const before = snaps(root, plan);
  // This command's own write.
  replaceLink(root, ".root/etc/udev/rules.d/50-k.rules", "new rule\n");
  const done = carryOver(root, plan, before, undefined);
  expect(done.homeless).toEqual([]);
  expect(done.done.sort()).toEqual([
    "/etc/udev/rules.d/50-k.rules → tools/keychron/root/etc/udev/rules.d/50-k.rules",
    "~/.zshenv → tools/zsh/home/dot_zshenv",
  ]);
  expect(fs.readFileSync(path.join(root, "tools/zsh/home/dot_zshenv"), "utf8")).toBe("left by plain chezmoi\n");
  expect(fs.readFileSync(path.join(root, "tools/keychron/root/etc/udev/rules.d/50-k.rules"), "utf8")).toBe("new rule\n");
  plan = planBuild(root, layout())!;
  writeBuild(root, plan);
  expect(driftMessage(drift(root, plan))).toBeUndefined();
});

test("carryOver: a folder renamed (chattr) renames the tool's files, and the emptied folder goes", () => {
  const root = repo(kit);
  let plan = planBuild(root, layout())!;
  writeBuild(root, plan);
  const before = snaps(root, plan);
  fs.renameSync(path.join(root, ".home/private_dot_config/zsh"), path.join(root, ".home/private_dot_config/private_zsh"));
  const done = carryOver(root, plan, before, undefined);
  expect(done.done).toEqual(["tools/zsh/home/private_dot_config/zsh/dot_zshrc.tmpl → tools/zsh/home/private_dot_config/private_zsh/dot_zshrc.tmpl"]);
  expect(fs.existsSync(path.join(root, "tools/zsh/home/private_dot_config/zsh"))).toBe(false);
  plan = planBuild(root, layout())!; // no "two names for ~/.config/zsh"
  writeBuild(root, plan);
  expect(driftMessage(drift(root, plan))).toBeUndefined();
});

test("carryOver: a symlink gone (forget) deletes the tool file, and the folders it emptied, never a tool's home/", () => {
  const root = repo(kit);
  let plan = planBuild(root, layout())!;
  writeBuild(root, plan);
  const before = snaps(root, plan);
  fs.rmSync(path.join(root, ".home/private_dot_config/zsh/dot_zshrc.tmpl"));
  fs.rmSync(path.join(root, ".home/dot_zshenv"));
  const done = carryOver(root, plan, before, undefined);
  expect(done.done.sort()).toEqual(["removed tools/zsh/home/dot_zshenv", "removed tools/zsh/home/private_dot_config/zsh/dot_zshrc.tmpl"]);
  expect(fs.existsSync(path.join(root, "tools/zsh/home/private_dot_config"))).toBe(false);
  expect(fs.existsSync(path.join(root, "tools/zsh/home"))).toBe(true);
  plan = planBuild(root, layout())!;
  writeBuild(root, plan);
  expect(driftMessage(drift(root, plan))).toBeUndefined();
});

test("carryOver never removes a from tree, even emptied", () => {
  const root = repo({ ...kit, "legacy/dot_vimrc": "x\n" });
  const l = layout({ build: { tools: "tools/*", from: "legacy" } });
  const plan = planBuild(root, l)!;
  writeBuild(root, plan);
  const before = snaps(root, plan);
  fs.rmSync(path.join(root, ".home/dot_vimrc"));
  carryOver(root, plan, before, undefined);
  expect(fs.existsSync(path.join(root, "legacy"))).toBe(true);
});

test("carryOver: a new file goes into the tool's folder; with no tool nothing is touched", () => {
  const root = repo(kit);
  const plan = planBuild(root, layout())!;
  writeBuild(root, plan);
  let before = snaps(root, plan);
  fs.writeFileSync(path.join(root, ".home/dot_newrc"), "new\n");
  // The same command also re-added a file: with a homeless file, that waits too.
  replaceLink(root, ".home/dot_zshenv", "edited\n");
  const none = carryOver(root, plan, before, undefined);
  expect(none).toEqual({ done: [], homeless: [".home/dot_newrc"] });
  expect(fs.readFileSync(path.join(root, "tools/zsh/home/dot_zshenv"), "utf8")).toBe("export ZDOTDIR\n");
  expect(() => carryOver(root, plan, before, "nope")).toThrow("no tool folder nope");
  before = snaps(root, plan);
  const done = carryOver(root, plan, new Map([["home", new Map()], ["root", before.get("root")!]]), "git");
  expect(done.done).toContain("~/.newrc → tools/git/home/dot_newrc");
  expect(fs.readFileSync(path.join(root, "tools/git/home/dot_newrc"), "utf8")).toBe("new\n");
});
