import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { newManifest, newRepoLayout, type RepoLayout } from "../../model/index.ts";
import { drift, driftMessage, globDirs, parentPlan, planBuild, refreshBuilds, snapshot, targetName, targetOf, writeBuild } from "./configbuild.ts";

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
  expect(driftMessage(d)).toContain("keep it with `loadout chezmoi re-add ~/.zshenv`, or drop it with `git restore .home/dot_zshenv`");
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

test("names land as chezmoi lands them", () => {
  expect(targetName("private_dot_config", true)).toBe(".config");
  expect(targetName("exact_private_dot_ssh", true)).toBe(".ssh");
  expect(targetName("executable_dot_x.tmpl", false)).toBe(".x");
  expect(targetName("run_onchange_after_reload.sh", false)).toBe("reload.sh");
  expect(targetName("literal_dot_x", false)).toBe("dot_x");
  const root = repo(kit);
  const plan = planBuild(root, layout())!;
  expect(targetOf(plan.home, "private_dot_config/zsh/dot_zshrc.tmpl")).toBe("~/.config/zsh/.zshrc");
  expect(targetOf(plan.root!, "etc/udev/rules.d/50-k.rules")).toBe("/etc/udev/rules.d/50-k.rules");
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
