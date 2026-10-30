package hclconf

import (
	"slices"
	"testing"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/model"
)

// Assembly, its cases written in the manifest language: what
// assembly makes of HCL declarations. (The hand-built drafts are
// internal/assemble's.)

func TestViaInstallsEveryProgramInItsBlockThroughThatInstaller(t *testing.T) {
	m := manifestOf(t, `
program "git" {
  install_via = [
    dnf,
    brew,
  ]
}
program "jq" { install_via = [brew] }
program "vim" { install_via = [dnf, brew] }
locals {
  cli = [program.git, program.vim]
}
machine "m" {
  via "brew" {
    install = [local.cli, program.jq]
  }
}`)
	equalMaps(t, pmOf(t, m, "m"), map[string]string{"git": "brew", "jq": "brew", "vim": "brew"})
}

func TestAMachineInstallingThroughAVariantTheProgramLacksIsNamed(t *testing.T) {
	message := refusal(t, `
program "git" { install_via = [dnf] }
machine "m" {
  via "brew" { install = [program.git] }
}`)
	contains(t, message, "machine 'm' installs 'git' via 'brew', but it can't be installed that way (it can via: dnf)")
}

func TestInstallerDefaultsApplyPkgAndOverrides(t *testing.T) {
	m := manifestOf(t, `
installer "brew-cask" {
  probe   = "brew"
  install = "brew install --cask {pkg}"
  check   = "brew list --cask --versions {pkg}"
}
program "toolbox" {
  custom "linux" { command = "brew tap x/y && brew install --cask toolbox-linux" }
  install_via = [brew-cask]
}
program "toolbox-linux-cask" {
  via "brew-cask" { pkg = "toolbox-linux" }
}`)
	cask := m.ResolveInstall("toolbox", "brew-cask")
	equal(t, deref(cask.Command), "brew install --cask toolbox")
	equal(t, cask.Check.Command, "brew list --cask --versions toolbox")
	equal(t, deref(cask.Probe), "brew")
	equal(t, deref(m.ResolveInstall("toolbox-linux-cask", "brew-cask").Command), "brew install --cask toolbox-linux")
	// A custom variant has no installer: no probe, no derived check.
	if m.ResolveInstall("toolbox", "linux").Probe != nil {
		t.Error("a custom variant has no probe")
	}
	// The variants keep the order they're written in.
	equalSlices(t, m.Programs.Value("toolbox").Install.Keys(), []string{"linux", "brew-cask"})
}

func TestPresentIsTheYesNoForm(t *testing.T) {
	m := manifestOf(t, `
program "a" {
  custom {
    command = "x"
    present = "test -f /etc/a"
  }
}`)
	if m.ResolveInstall("a", "custom").Check.Regex != nil {
		t.Error("present() records no version")
	}
}

func TestAVariantWithNoCommandIsRefused(t *testing.T) {
	contains(t, refusal(t, "program \"a\" {\n  custom {}\n}"), "programs.a.install.custom resolves to no install command")
}

func TestInstallerParamsSubstituteIntoEveryPattern(t *testing.T) {
	m := manifestOf(t, `
installer "copr" {
  params  = ["copr"]
  install = "sudo dnf copr enable -y {copr} && sudo dnf install -y {pkg}"
  check   = "rpm -q {pkg} && echo {copr}"
}
program "kitty" {
  via "copr" {
    params = { copr = "solopasha/kitty" }
  }
}`)
	resolved := m.ResolveInstall("kitty", "copr")
	equal(t, deref(resolved.Command), "sudo dnf copr enable -y solopasha/kitty && sudo dnf install -y kitty")
	equal(t, resolved.Check.Command, "rpm -q kitty && echo solopasha/kitty")
}

func TestAMissingOrUndeclaredParamIsAnError(t *testing.T) {
	copr := `
installer "copr" {
  params  = ["copr"]
  install = "dnf copr enable {copr} && dnf install {pkg}"
}
`
	contains(t, refusal(t, copr+`program "kitty" { install_via = [copr] }`), "needs a value for 'copr'")
	contains(t, refusal(t, copr+`program "kitty" {
  via "copr" {
    params = { copr = "x", extra = "y" }
  }
}`), "sets 'extra', which installer 'copr' does not declare in params")
	contains(t, refusal(t, `program "kitty" {
  custom {
    command = "x"
    params  = { copr = "y" }
  }
}`), "sets 'copr' but resolves to no installer")
	contains(t, refusal(t, `installer "bad" {
  params  = ["pkg"]
  install = "x {pkg}"
}`), "installers.bad declares param 'pkg', which is always available")
}

func TestInstallOrderPutsDependenciesFirst(t *testing.T) {
	m := manifestOf(t, `
program "git" { install_via = [dnf] }
program "ripgrep" {
  depends_on  = [program.git]
  install_via = [dnf]
}
program "rustup" {
  custom { command = "x" }
}`)
	equalSlices(t, assemble.InstallOrder(m, []string{"ripgrep"}, model.Map[string]{}), []string{"git", "ripgrep"})
	equalSlices(t, assemble.InstallOrder(m, nil, model.Map[string]{}), []string{"git", "ripgrep", "rustup"})
}

func TestScriptModesDefaultToBothSurfaces(t *testing.T) {
	m := manifestOf(t, `
script "bootstrap" {
  run        = "true"
  setup_only = true
}
script "tidy" {
  run           = "true"
  maintain_only = true
}
script "everyday" { run = "true" }`)
	scripts := m.Scripts
	equal(t, scripts.Value("bootstrap").RunsIn("setup"), true)
	equal(t, scripts.Value("bootstrap").RunsIn("maintain"), false)
	equal(t, scripts.Value("tidy").RunsIn("setup"), false)
	equal(t, scripts.Value("everyday").RunsIn("setup"), true)
	equal(t, scripts.Value("everyday").RunsIn("maintain"), true)
}

func TestAScriptHasExactlyOneOfAFileOrACommand(t *testing.T) {
	contains(t, refusalInRepo(t, `script "s" {
  file = "s.sh"
  run  = "true"
}`, "s.sh"), "scripts.s must define exactly one of a file or an inline command")
	contains(t, refusal(t, `script "s" {}`), "scripts.s must define exactly one of a file or an inline command")
	contains(t, refusalInRepo(t, `script "s" {
  run = "true"
  variant "a" { file = "a.sh" }
}`, "a.sh"), "scripts.s has variants, so its file or command belongs in each variant")
}

func TestArgumentsNeedAFileScript(t *testing.T) {
	message := refusal(t, `
script "inline" { run = "echo hi" }
machine "m" { run = [args(script.inline, "x")] }`)
	contains(t, message, "machine 'm' passes arguments to script 'inline', which is an inline command")
}

func TestDeclaringOrRunningTwiceIsAnError(t *testing.T) {
	twice := refusal(t, `
script "s" { run = "true" }
program "p" {
  custom { command = "x" }
}
machine "m" {
  run     = [script.s, script.s]
  install = [program.p, program.p]
}`)
	contains(t, twice, "machine 'm' runs 's' twice", "machine 'm' installs 'p' twice")
	variants := refusal(t, `
program "p" {
  custom { command = "x" }
  custom { command = "y" }
}`)
	contains(t, variants, "program 'p' has two 'custom' variants")
}

func TestProfilesFlattenIntoMachinesAndAreDropped(t *testing.T) {
	m := inRepo(t, `
program "git" { install_via = [dnf, brew] }
program "kitty" { install_via = [dnf] }
script "dotfiles" { file = "dotfiles.sh" }
script "setup-ssh" { file = "ssh.sh" }
profile "base" {
  via "dnf" {
    install = [program.git, program.kitty]
  }
  run = [script.dotfiles, args(script.setup-ssh, "basekey")]
}
profile "linux" { extends = [profile.base] }
machine "laptop" {
  extends = [profile.linux]
  via "brew" {
    install = [program.git]
  }
  run = [args(script.setup-ssh, "laptopkey")]
}`, "dotfiles.sh", "ssh.sh")
	equalSlices(t, m.Machines.Keys(), []string{"laptop"})
	laptop := m.Machines.Value("laptop")
	equalMaps(t, pmOf(t, m, "laptop"), map[string]string{"git": "brew", "kitty": "dnf"})
	args := map[string]string{}
	for k, v := range laptop.ScriptArgs().All() {
		args[k] = v
	}
	equalMaps(t, args, map[string]string{"dotfiles": "", "setup-ssh": "laptopkey"})
	equalSlices(t, laptop.Extends, []string{"linux"})
}

func TestSiblingProfilesMustAgreeAndTheMachineOverridesThem(t *testing.T) {
	agree := inRepo(t, `
program "git" { install_via = [dnf, brew] }
script "ssh" { file = "ssh.sh" }
profile "a" {
  via "dnf" { install = [program.git] }
  run = [args(script.ssh, "one")]
}
profile "b" {
  via "dnf" { install = [program.git] }
  run = [args(script.ssh, "one")]
}
machine "m" {
  extends = [profile.a, profile.b]
  via "brew" { install = [program.git] }
}`, "ssh.sh")
	equal(t, agree.Machines.Value("m").PM.Value("git"), "brew")
	equal(t, agree.Machines.Value("m").ScriptArgs().Value("ssh"), "one")

	disagree := refusalInRepo(t, `
data {
  omarchy = flag(false)
}
program "git" { install_via = [dnf, brew] }
script "ssh" { file = "ssh.sh" }
script "keyboard" {
  variant "one" { file = "k1.sh" }
  variant "two" { file = "k2.sh" }
}
profile "a" {
  via "dnf" { install = [program.git] }
  run  = [args(script.ssh, "one"), variant(script.keyboard, "one")]
  data = { omarchy = true }
}
profile "b" {
  via "brew" { install = [program.git] }
  run  = [args(script.ssh, "two"), variant(script.keyboard, "two")]
  data = { omarchy = false }
}
machine "m" { extends = [profile.a, profile.b] }`, "ssh.sh", "k1.sh", "k2.sh")
	contains(t, disagree,
		"machine 'm': profiles 'a' and 'b' map 'git' differently ('dnf' vs 'brew')",
		"machine 'm': profiles 'a' and 'b' run 'ssh' with different arguments",
		"machine 'm': profiles 'a' and 'b' run 'keyboard' as different variants ('one' vs 'two')",
		"machine 'm': profiles 'a' and 'b' set data key 'omarchy' differently",
	)
}

const flagsSchema = `
data {
  omarchy = flag(false)
  tags    = list(["a"])
  kitty {
    opacity = number(0.85)
    font    = text("mono")
  }
}
`

func TestDataMergesDefaultsProfilesAndMachine(t *testing.T) {
	m := manifestOf(t, flagsSchema+`
profile "omarchy" {
  data = {
    omarchy = true
    kitty   = { font = "fira" }
  }
}
machine "m" {
  extends = [profile.omarchy]
  data = {
    kitty = { opacity = 0.9 }
    tags  = ["b"]
  }
}
machine "bare" {}`)
	// Defaults under profile under machine; tables merge key by key, lists replace.
	equalSlices(t, model.DataLines(m.Machines.Value("m").Data, ""), []model.DataLine{
		{Key: "kitty.font", Value: `"fira"`}, {Key: "kitty.opacity", Value: "0.9"}, {Key: "omarchy", Value: "true"}, {Key: "tags", Value: `["b"]`},
	})
	// Every machine carries every declared key.
	equal(t, model.JSONString(m.Machines.Value("bare").Data), model.JSONString(m.Data))
	equal(t, model.JSONString(m.Data), `{"omarchy":false,"tags":["a"],"kitty":{"opacity":0.85,"font":"mono"}}`)
}

func TestUndeclaredOrMistypedDataIsAnError(t *testing.T) {
	schema := "data {\n  work = flag(false)\n}\n"
	contains(t, refusal(t, schema+`machine "m" { data = { wrok = true } }`),
		"machine 'm': data key 'wrok' is not declared in the data schema")
	contains(t, refusal(t, schema+`machine "m" { data = { work = "yes" } }`),
		"machine 'm': data key 'work' is a string, but the data schema declares a boolean")
}

func TestPathsAreRelativeToTheDeclaringDirectoryAndStayInTheRepo(t *testing.T) {
	tmux := map[string]string{"configs/tmux/.tmux.loadout.hcl": `script "tmux-plugins" { managed_by = "plugins.sh" }`}
	draft, _ := draftOf(t, tmux)
	_, err := assemble.Assemble(draft, repoFS("plugins.sh"), nil)
	if err == nil {
		t.Fatal("the file is in the wrong folder")
	}
	contains(t, err.Error(), "scripts.tmux-plugins: file 'plugins.sh' not found (relative to configs/tmux/)")
	m, err := assemble.Assemble(draft, repoFS("configs/tmux/plugins.sh"), nil)
	if err != nil {
		t.Fatal(err)
	}
	equal(t, m.Scripts.Value("tmux-plugins").Origin, "configs/tmux")

	escaping, _ := draftOf(t, map[string]string{"a/b/x.loadout.hcl": `script "x" { file = "../../../outside.sh" }`})
	_, err = assemble.Assemble(escaping, repoFS(), nil)
	contains(t, err.Error(), "file '../../../outside.sh' leaves the repo")
	// `..` that stays inside the repo reaches a shared helper.
	helper, _ := draftOf(t, map[string]string{"a/b/x.loadout.hcl": `script "x" { file = "../lib/helper.sh" }`})
	m, err = assemble.Assemble(helper, repoFS("a/lib/helper.sh"), nil)
	if err != nil {
		t.Fatal(err)
	}
	equal(t, deref(m.Scripts.Value("x").File), "../lib/helper.sh")
}

func TestEveryFileCommandIsChecked(t *testing.T) {
	message := refusalInRepo(t, `
program "tool" {
  custom "script" {
    command = run_script("scripts/tool.sh install --verbose")
    version = run_script("scripts/tool-check.sh")
  }
}
script "setup" {
  run   = "true"
  check = run_script("scripts/setup.sh check")
}
outdated "pins" {
  command = run_script("pins.sh")
  upgrade = run_script("pins.sh bump {item}")
}`)
	// The path is named alone, never its arguments.
	contains(t, message,
		"programs.tool.install.script: file 'scripts/tool.sh' not found",
		"programs.tool.install.script check: file 'scripts/tool-check.sh' not found",
		"scripts.setup.check: file 'scripts/setup.sh' not found",
		"outdated.pins: file 'pins.sh' not found",
		"outdated.pins.upgrade: file 'pins.sh' not found",
	)
}

func TestAnInstallRunsWhereItsCommandWasWritten(t *testing.T) {
	m := manifestFiles(t, map[string]string{
		"programs/installers/pm.loadout.hcl": `
installer "pm" {
  install = "pm add {pkg}"
  check   = "pm query {pkg}"
}`,
		"programs/cli/cli.loadout.hcl": `
program "jq" { install_via = [pm] }
program "odd" {
  via "pm" { command = "make install" }
}`,
	})
	jq := m.ResolveInstall("jq", "pm")
	equal(t, jq.CommandOrigin, "programs/installers")
	equal(t, jq.Check.Origin, "programs/installers")
	odd := m.ResolveInstall("odd", "pm")
	equal(t, odd.CommandOrigin, "programs/cli")
	equal(t, odd.Check.Origin, "programs/installers")
}

func TestAFileWithValueIsAPathNextToItsProgram(t *testing.T) {
	apps := map[string]string{"programs/apps/apps.loadout.hcl": `
program "code" {
  via "dnf-repo" {
    params = { repofile = file("repos/code.repo") }
  }
}
program "teams" {
  via "dnf-repo" {
    params = { repofile = "https://example.com/teams.repo" }
  }
}`}
	draft, _ := draftOf(t, apps)
	m, err := assemble.Assemble(draft, repoFS("programs/apps/repos/code.repo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	contains(t, deref(m.ResolveInstall("code", "dnf-repo").Command), "--from-repofile=$LOADOUT_REPO/programs/apps/repos/code.repo")
	// Unmarked values (a URL) pass through as written.
	contains(t, deref(m.ResolveInstall("teams", "dnf-repo").Command), "--from-repofile=https://example.com/teams.repo")
	_, err = assemble.Assemble(draft, repoFS(), nil)
	contains(t, err.Error(), "programs.code.install.dnf-repo.with.repofile: file 'repos/code.repo' not found (relative to programs/apps/)")
}

func TestAParentsFilesResolveInItsCheckout(t *testing.T) {
	parent, err := Decode(filesOf(map[string]string{"maintenance/lib/lib.loadout.hcl": `script "helper" { managed_by = "helper.sh" }`}), Options{AsParent: true})
	if err != nil {
		t.Fatal(err)
	}
	child, err := Decode(filesOf(map[string]string{"scripts/mine.loadout.hcl": `script "mine" { managed_by = "mine.sh" }`}), Options{Parent: parent})
	if err != nil {
		t.Fatal(err)
	}
	draft, err := child.DraftOver(parent, "dots")
	if err != nil {
		t.Fatal(err)
	}
	draft.Manifest.Layout.State = "state"
	m, err := assemble.Assemble(draft, repoFS("scripts/mine.sh"), repoFS("maintenance/lib/helper.sh"))
	if err != nil {
		t.Fatal(err)
	}
	equal(t, m.Scripts.Value("helper").Origin, "parent:maintenance/lib")
	// The same file in the child's root is not the parent's.
	_, err = assemble.Assemble(draft, repoFS("maintenance/lib/helper.sh", "scripts/mine.sh"), repoFS())
	contains(t, err.Error(), "scripts.helper: file 'helper.sh' not found (relative to parent:maintenance/lib/)")
}

func TestBuiltInsResolveWithoutBeingDeclared(t *testing.T) {
	m := manifestOf(t, `program "ripgrep" { install_via = [dnf] }`)
	resolved := m.ResolveInstall("ripgrep", "dnf")
	equal(t, deref(resolved.Command), "sudo dnf install -y ripgrep")
	equal(t, resolved.Check.Command, "rpm -q ripgrep")
	equal(t, deref(resolved.Probe), "dnf")
	equal(t, slices.Contains(m.BuiltinInstallers, "dnf"), true)
}

func TestARepoInstallerReplacesTheBuiltInOfTheSameName(t *testing.T) {
	m := manifestOf(t, `
installer "dnf" {
  probe   = "dnf"
  install = "sudo dnf5 install -y {pkg}"
}
program "ripgrep" { install_via = [dnf] }
program "fd" { install_via = [installer.dnf] }`)
	equal(t, deref(m.ResolveInstall("ripgrep", "dnf").Command), "sudo dnf5 install -y ripgrep")
	equal(t, deref(m.ResolveInstall("fd", "dnf").Command), "sudo dnf5 install -y fd")
	// Replaced outright, not merged: the built-in's oracle is gone with it.
	equal(t, slices.Contains(m.BuiltinInstallers, "dnf"), false)
	if m.Installers.Value("dnf").OutdatedAll != nil {
		t.Error("the built-in's oracle is gone")
	}
	equal(t, slices.Contains(m.BuiltinInstallers, "brew"), true)
}

func TestARequirementOnABuiltInKeepsItBuiltIn(t *testing.T) {
	m := inRepo(t, `
program "setup-dnf" {
  via "dnf" { managed_by = "setup-dnf.sh" }
}
requires "dnf" { programs = [program.setup-dnf] }
program "curl" { install_via = [dnf] }`, "setup-dnf.sh")
	equalSlices(t, m.Installers.Value("dnf").Requires, []string{"setup-dnf"})
	equal(t, slices.Contains(m.BuiltinInstallers, "dnf"), true)
}

func TestMetaVersionIsADottedNumber(t *testing.T) {
	contains(t, refusal(t, `repo {
  name             = "x"
  state            = "state"
  min_tool_version = "soon"
}`), "meta min-tool-version 'soon' is not a dotted version number")
}
