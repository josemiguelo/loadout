package engine

import (
	"maps"
	"testing"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	ct "github.com/josemiguelo/loadout/internal/core/coretest"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/exec/fakeexec"
	"github.com/josemiguelo/loadout/internal/model"
)

const (
	cz        = "chezmoi --source '/repo/configs' --no-pager"
	czManaged = cz + " managed --include files,symlinks"
	czStatus  = cz + " status --include files,symlinks"
)

func configs(runner *fakeexec.Runner) *ConfigEngine {
	return NewSingleConfigEngine(runner, "/repo/configs")
}

const managedOut = ".config/tmux/tmux.conf\n.config/zsh/.zshrc\n.config/zsh/conf.d/a.zsh\n.config/starship.toml\n.zshenv\n.local/bin/x\n"

func applied() coremodel.ConfigState { return coremodel.ConfigState{Status: coremodel.ConfigApplied} }

func configEq(t *testing.T, want coremodel.ConfigState, got coremodel.ConfigState) {
	t.Helper()
	if !want.Equal(got) {
		t.Errorf("\nwant %+v\n got %+v", want, got)
	}
}

func TestUnitsAreAConfigFolderOrATopLevelName(t *testing.T) {
	runner := fakeexec.New().OnCommand(czManaged, fakeexec.Stdout(managedOut))
	units := must[[]ConfigUnit](t)(configs(runner).Units())
	var names []string
	for _, u := range units {
		names = append(names, u.Name)
	}
	eq(t, []string{".local", ".zshenv", "starship.toml", "tmux", "zsh"}, names)
	eq(t, []string{".config/zsh/.zshrc", ".config/zsh/conf.d/a.zsh"}, units[4].Targets)
}

func TestAUnitDriftsWhenApplyWouldChangeOneOfItsFiles(t *testing.T) {
	runner := fakeexec.New().
		OnCommand(czManaged, fakeexec.Stdout(managedOut)).
		// Second column: apply would change it. First column alone: edited
		// here but already what the repo says, so nothing to apply.
		OnCommand(czStatus, fakeexec.Stdout(" M .config/zsh/.zshrc\nM  .config/tmux/tmux.conf\n A .config/zsh/conf.d/a.zsh\n"))
	observed := must[model.Map[coremodel.ConfigState]](t)(configs(runner).Observe(model.Map[coremodel.ConfigState]{}))
	configEq(t, coremodel.ConfigState{Status: coremodel.ConfigDrifted, Files: []string{".config/zsh/.zshrc", ".config/zsh/conf.d/a.zsh"}}, observed.Value("zsh"))
	configEq(t, applied(), observed.Value("tmux"))
	configEq(t, applied(), observed.Value(".zshenv"))
	eq(t, 5, observed.Len())
}

func TestOnlyFilesEditedHereThatApplyWouldReplaceNeedADecision(t *testing.T) {
	runner := fakeexec.New().OnCommand(czStatus, fakeexec.Stdout("MM .config/zsh/.zshrc\n M .zshenv\nM  .config/tmux/tmux.conf\n"))
	engine := configs(runner)
	eq(t, []string{".config/zsh/.zshrc"}, must[[]string](t)(engine.Edited(nil)))
	eq(t, []string(nil), must[[]string](t)(engine.Edited([]string{".zshenv"})))
}

func TestWithoutChezmoiTheUnitsLastSeenAreUnknown(t *testing.T) {
	engine := configs(fakeexec.New()) // every command: exit 127
	observed := must[model.Map[coremodel.ConfigState]](t)(engine.Observe(model.MapOf(model.E("zsh", applied()))))
	eq(t, []string{"zsh"}, observed.Keys())
	configEq(t, coremodel.ConfigState{Status: coremodel.ConfigUnknown, Reason: s("chezmoi is not on PATH")}, observed.Value("zsh"))
	eq(t, "chezmoi is not on PATH", *engine.LastReason())
}

func TestAChezmoiErrorIsTheReasonInItsOwnWords(t *testing.T) {
	runner := fakeexec.New().
		OnCommand(czManaged, fakeexec.Stdout(managedOut)).
		OnCommand(czStatus, fakeexec.Exit(1), fakeexec.Stderr("chezmoi: .bad: template: dot_bad.tmpl:1:8: map has no entry for key \"nope\"\n"))
	engine := configs(runner)
	observed := must[model.Map[coremodel.ConfigState]](t)(engine.Observe(model.MapOf(model.E("tmux", applied()))))
	eq(t, coremodel.ConfigUnknown, observed.Value("tmux").Status)
	contains(t, *engine.LastReason(), "chezmoi: .bad: template")

	// The next good answer clears it.
	runner.OnCommand(czStatus)
	must[model.Map[coremodel.ConfigState]](t)(engine.Observe(observed))
	if engine.LastReason() != nil {
		t.Error(*engine.LastReason())
	}
}

func applyLine(t *testing.T, engine *ConfigEngine, targets []string, force bool) string {
	t.Helper()
	return must[exec.ShellCommand](t)(engine.ApplyCommand(targets, force)).Line
}

func TestApplyNamesAbsoluteTargetsAndForcesOnlyWhenAsked(t *testing.T) {
	engine := configs(fakeexec.New().OnCommand(cz+" target-path", fakeexec.Stdout("/home/me\n")))
	eq(t, cz+" apply --no-tty", applyLine(t, engine, nil, false))
	eq(t, cz+` apply --no-tty --force '/home/me/.config/zsh/.zshrc' '/home/me/it'\''s'`,
		applyLine(t, engine, []string{".config/zsh/.zshrc", "it's"}, true))
}

func TestAChezmoiThatCantAnswerIsARefusal(t *testing.T) {
	_, err := configs(fakeexec.New()).Units()
	refused[*ConfigException](t, err)
}

// ─── a child repo: its parent's source and its own (contract 18) ──

const (
	parentCz = "chezmoi --source '/dots/configs' --no-pager"
	childCz  = "chezmoi --source '/work/configs' --no-pager"
)

var loadoutEnv = map[string]string{"LOADOUT_REPO": "/work", "LOADOUT_MACHINE": "work"}

func both(runner *fakeexec.Runner) *ConfigEngine {
	return NewConfigEngine(runner, []ConfigSource{{"/dots/configs", "parent dots"}, {Dir: "/work/configs"}}, loadoutEnv)
}

func twoSources(parentManaged, childManaged, parentStatus, childStatus string) *fakeexec.Runner {
	return fakeexec.New().
		OnCommand(parentCz+" managed --include files,symlinks", fakeexec.Stdout(parentManaged)).
		OnCommand(childCz+" managed --include files,symlinks", fakeexec.Stdout(childManaged)).
		OnCommand(parentCz+" status --include files,symlinks", fakeexec.Stdout(parentStatus)).
		OnCommand(childCz+" status --include files,symlinks", fakeexec.Stdout(childStatus)).
		OnCommand(parentCz+" target-path", fakeexec.Stdout("/home/u\n")).
		OnCommand(childCz+" target-path", fakeexec.Stdout("/home/u\n"))
}

func TestAUnitSpansBothSourcesAndDriftsWhenEitherWould(t *testing.T) {
	runner := twoSources(".config/zsh/.zshrc\n.zshenv\n", ".config/zsh/conf.d/zz-work.zsh\n", "", " M .config/zsh/conf.d/zz-work.zsh\n")
	engine := both(runner)
	units := must[[]ConfigUnit](t)(engine.Units())
	eq(t, "zsh", units[1].Name)
	eq(t, []string{".config/zsh/.zshrc", ".config/zsh/conf.d/zz-work.zsh"}, units[1].Targets)
	observed := must[model.Map[coremodel.ConfigState]](t)(engine.Observe(model.Map[coremodel.ConfigState]{}))
	configEq(t, coremodel.ConfigState{Status: coremodel.ConfigDrifted, Files: []string{".config/zsh/conf.d/zz-work.zsh"}}, observed.Value("zsh"))
	eq(t, coremodel.ConfigApplied, observed.Value(".zshenv").Status)
	// chezmoi sees the repo and machine loadout runs as.
	for _, c := range runner.Received() {
		if !maps.Equal(loadoutEnv, c.Env) {
			t.Errorf("%s: %v", c.Line, c.Env)
		}
	}
}

func TestAFileBothSourcesManageIsUnknownAndApplyRefusesIt(t *testing.T) {
	engine := both(twoSources(".config/git/config\n.zshenv\n", ".config/git/config\n", "", ""))
	git := must[model.Map[coremodel.ConfigState]](t)(engine.Observe(model.Map[coremodel.ConfigState]{})).Value("git")
	eq(t, coremodel.ConfigUnknown, git.Status)
	eq(t, ".config/git/config is managed by parent dots and this repo — a file belongs to one repo", *git.Reason)
	_, err := engine.ApplyCommand([]string{".config/git/config"}, false)
	contains(t, refused[*ConfigException](t, err), "a file belongs to one repo")
	_, err = engine.ApplyCommand(nil, false)
	refused[*ConfigException](t, err)
	// A target only one repo manages still applies.
	eq(t, parentCz+" apply --no-tty '/home/u/.zshenv'", applyLine(t, engine, []string{".zshenv"}, false))
}

func TestApplyRunsEachSourceOnItsOwnTargetsTheParentsFirst(t *testing.T) {
	engine := both(twoSources(".zshenv\n", ".config/work/x\n", "", ""))
	eq(t, parentCz+" apply --no-tty && "+childCz+" apply --no-tty", applyLine(t, engine, nil, false))
	eq(t, parentCz+" apply --no-tty --force '/home/u/.zshenv' && "+childCz+" apply --no-tty --force '/home/u/.config/work/x'",
		applyLine(t, engine, []string{".config/work/x", ".zshenv"}, true))
	eq(t, loadoutEnv, must[exec.ShellCommand](t)(engine.ApplyCommand(nil, false)).Env)
}

// The refresh says once what couldn't answer: a tool its checks go through, and chezmoi.
func TestARefreshNamesTheToolsAndConfigsThatCouldNotAnswer(t *testing.T) {
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("pm", model.Installer{Probe: s("pm"), Install: s("pm add {pkg}"), Check: s("pm query {pkg}")})
		b.Program("bat", model.Program{Install: ct.Via("pm")})
		b.Script("dotfiles", model.ScriptStep{Run: s("echo setup"), Check: s("test -d $HOME/.dotfiles")})
		b.Machine("laptop", model.MachineConfig{PM: ct.PM("bat", "pm"), Scripts: []string{"dotfiles"}})
	})
	runner := fakeexec.New()
	checks := NewVersionChecker(runner, repoFrame)
	engine := NewStatusEngine(checks, runner, repoFrame, configs(runner))
	previous := coremodel.MachineState{Configs: model.MapOf(model.E("zsh", applied()))}
	state := must[coremodel.MachineState](t)(engine.Refresh(m, laptop, &previous, model.Map[coremodel.ScriptState]{}))
	eq(t, coremodel.ConfigUnknown, state.Configs.Value("zsh").Status)
	eq(t, "chezmoi is not on PATH", *engine.LastConfigsDown())
	eq(t, map[string]string{"dotfiles": "sh: command not found"}, engine.LastScriptDetail())
	// bat's check goes through pm, which isn't there.
	down := engine.LastToolsDown()
	eq(t, 1, len(down))
	eq(t, "pm is not on PATH — 1 program(s) not checked", down[0].Message())
	eq(t, []string{"bat"}, down[0].Programs)
}
