package hclconf

import (
	"testing"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/model"
)

// What the manifest language means, and the
// mistakes it refuses.

func TestAOneVariantProgramIsInstalledWithoutNamingIt(t *testing.T) {
	m := inRepo(t, `
program "jq" { install_via = [brew] }
program "fd" { install_via = [brew, omarchy] }
machine "m" {
  install = [program.jq]
  via "omarchy" {
    install = [program.fd]
  }
}`)
	equalMaps(t, pmOf(t, m, "m"), map[string]string{"jq": "brew", "fd": "omarchy"})
}

func TestAProgramWithSeveralVariantsMustSayWhich(t *testing.T) {
	message := refusal(t, `
program "fd" { install_via = [brew, omarchy] }
machine "m" { install = [program.fd] }`)
	contains(t, message, "machine 'm' installs 'fd' without saying how (it has: brew, omarchy)")
}

func TestAnInstallerRequirementBecomesEveryProgramsDependencyButItsOwn(t *testing.T) {
	m := inRepo(t, `
program "setup-dnf" {
  via "dnf" {
    present = "true"
    command = "true"
  }
}
program "curl" { install_via = [dnf] }
requires "dnf" { programs = [program.setup-dnf] }
machine "m" {
  via "dnf" {
    install = [program.setup-dnf, program.curl]
  }
}`)
	equalSlices(t, m.DependenciesOf("curl", model.Ptr("dnf")), []string{"setup-dnf"})
	equalSlices(t, m.DependenciesOf("setup-dnf", model.Ptr("dnf")), nil)
	equalSlices(t, assemble.InstallOrder(m, []string{"curl", "setup-dnf"}, m.Machines.Value("m").PM), []string{"setup-dnf", "curl"})
}

func TestAYesNoCheckRecordsNoVersion(t *testing.T) {
	m := inRepo(t, `
program "setup-dnf" {
  via "dnf" { managed_by = "setup-dnf.sh" }
}`, "setup-dnf.sh")
	check := m.ResolveInstall("setup-dnf", "dnf").Check
	equal(t, check.Command, "file:setup-dnf.sh check")
	if check.Regex != nil {
		t.Errorf("a yes/no check has no regex: %q", *check.Regex)
	}
}

func TestAManagingScriptWithARegexReadsAVersion(t *testing.T) {
	m := manifestOf(t, `
program "tool" {
  custom {
    managed_by = "tool.sh"
    regex      = "v([0-9.]+)"
  }
}`)
	v := m.Programs.Value("tool").Install.Value("custom")
	equal(t, deref(v.Command), "file:tool.sh install")
	equal(t, deref(v.Check), "file:tool.sh check")
	equal(t, deref(v.Regex), "v([0-9.]+)")
	equal(t, v.Present, false)
}

func TestAMachinePicksAScriptVariant(t *testing.T) {
	m := inRepo(t, `
script "keyboard" {
  description = "fn swap"
  needs_sudo  = true
  variant "arch" { managed_by = "arch.sh" }
  variant "fedora" { managed_by = "fedora.sh" }
}
machine "m" { run = [variant(script.keyboard, "arch")] }`, "arch.sh", "fedora.sh")
	step := m.ForMachine("m").Scripts.Value("keyboard")
	equal(t, deref(step.File), "arch.sh")
	equal(t, step.Sudo, true)
	equal(t, step.Description, "fn swap")
}

func TestAScriptWithVariantsNeedsOnePicked(t *testing.T) {
	message := refusalInRepo(t, `
script "s" {
  variant "a" { managed_by = "a.sh" }
}
machine "m" { run = [script.s] }`, "a.sh")
	contains(t, message, "machine 'm' runs 's' without saying which variant (has: a)")
}

const dataSchemaSrc = `
data {
  work = flag(false)
  kitty {
    opacity = number(0.85)
  }
}
`

func TestDataIsTypedAndMergedLikeContractTwo(t *testing.T) {
	m := inRepo(t, dataSchemaSrc+`
profile "work" { data = { work = true } }
machine "m" {
  extends = [profile.work]
  data    = { kitty = { opacity = 0.9 } }
}`)
	data := m.Machines.Value("m").Data
	equal(t, model.JSONString(data.Value("work")), "true")
	equal(t, model.JSONString(data.Value("kitty")), `{"opacity":0.9}`)
}

func TestTwoProfilesSettingADataKeyDifferentlyIsAnError(t *testing.T) {
	message := refusal(t, dataSchemaSrc+`
profile "a" { data = { work = true } }
profile "b" { data = { work = false } }
machine "m" { extends = [profile.a, profile.b] }`)
	contains(t, message, "machine 'm': profiles 'a' and 'b' set data key 'work' differently")
}

func TestAManagingScriptsCheckGetsTheArguments(t *testing.T) {
	m := inRepo(t, `
script "setup-ssh" { managed_by = "setup-ssh.sh" }
machine "m" { run = [args(script.setup-ssh, "id_ed25519")] }`, "setup-ssh.sh")
	equal(t, deref(m.Scripts.Value("setup-ssh").Check), `file:setup-ssh.sh check "$@"`)
	equalSlices(t, m.Machines.Value("m").Scripts, []string{"setup-ssh id_ed25519"})
}

func TestSeveralCommandsMustAllPass(t *testing.T) {
	m := manifestOf(t, `
script "remote" {
  run   = ["git remote set-url origin a", "git config remote.origin.pushurl b"]
  check = ["test -f x", "test \"$(uname -s)\" != Linux || systemctl is-enabled y"]
}`)
	step := m.Scripts.Value("remote")
	equal(t, deref(step.Run), "git remote set-url origin a && git config remote.origin.pushurl b")
	// One holding || is grouped, so the && can't bind into it.
	equal(t, deref(step.Check), `test -f x && { test "$(uname -s)" != Linux || systemctl is-enabled y; }`)
}

func TestOneCommandStillGoesThroughAllOf(t *testing.T) {
	m := manifestOf(t, `
script "s" {
  run   = "a; b"
  check = "x || y"
}`)
	step := m.Scripts.Value("s")
	equal(t, deref(step.Run), "{ a; b; }")
	equal(t, deref(step.Check), "{ x || y; }")
}

func TestUpdatesManagedByAScriptListAndUpdateThroughIt(t *testing.T) {
	m := manifestFiles(t, map[string]string{
		"tmux/.tmux.loadout.hcl": `
script "tmux-plugins" {
  managed_by         = "plugins.sh"
  updates_managed_by = "outdated-plugins.sh"
}`,
		"zsh/.zsh.loadout.hcl": `
script "zsh-plugins" {
  managed_by = "plugins.sh"
  outdated {
    name    = "antidote"
    command = run_script("outdated-antidote.sh")
    upgrade = run_script("outdated-antidote.sh update {item}")
  }
}`,
		"claude/.claude.loadout.hcl": `
program "claude" {
  custom { command = "true" }
  version            = "claude --version"
  updates_managed_by = "outdated-claude.sh"
}`,
	})
	tmux := m.Outdated.Value("tmux-plugins")
	equal(t, deref(tmux.Command), "file:outdated-plugins.sh")
	equal(t, deref(tmux.Upgrade), "file:outdated-plugins.sh update {item}")
	equal(t, tmux.Origin, "tmux")
	equal(t, deref(m.Outdated.Value("antidote").Command), "file:outdated-antidote.sh")
	claude := m.Programs.Value("claude").Outdated
	equal(t, claude.Command, "file:outdated-claude.sh")
	equal(t, deref(claude.Upgrade), "file:outdated-claude.sh update")
}

func TestAScriptsOutdatedSourceIsNamedAfterIt(t *testing.T) {
	draft, _ := draftOf(t, map[string]string{"tmux/.tmux.loadout.hcl": `
script "tmux-plugins" {
  managed_by = "plugins.sh"
  outdated {
    command = run_script("outdated.sh")
    upgrade = run_script("outdated.sh update {item}")
  }
}`})
	m, err := assemble.Assemble(draft, repoFS("tmux/plugins.sh", "tmux/outdated.sh"), nil)
	if err != nil {
		t.Fatal(err)
	}
	equal(t, m.Outdated.Value("tmux-plugins").Origin, "tmux")
}

func TestAMissingFileIsNamed(t *testing.T) {
	draft, _ := draftOf(t, map[string]string{"git/.git.loadout.hcl": `script "setup-git" { managed_by = "setup-git.sh" }`})
	_, err := assemble.Assemble(draft, repoFS(), nil)
	if err == nil {
		t.Fatal("assembled without the file")
	}
	contains(t, err.Error(), "scripts.setup-git: file 'setup-git.sh' not found (relative to git/)")
}

func TestTheLockRoundTrips(t *testing.T) {
	m := inRepo(t, `
program "jq" { install_via = [brew] }
machine "m" { install = [program.jq] }`)
	lock := model.Lock{ToolVersion: "3.0.0", Sources: "abc", Manifest: m}
	text := model.EncodeLock(lock)
	back, err := model.DecodeLock(text, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	equal(t, model.EncodeLock(back), text)
}

func TestDeclaringAProgramTwiceIsAnError(t *testing.T) {
	message := refusal(t, `
program "jq" { install_via = [brew] }
program "jq" { install_via = [brew] }`)
	contains(t, message, "duplicate program 'jq'")
}
