package engine

import (
	"testing"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	ct "github.com/josemiguelo/loadout/internal/core/coretest"
	"github.com/josemiguelo/loadout/internal/core/exec/fakeexec"
	"github.com/josemiguelo/loadout/internal/model"
)

func statusManifest(t *testing.T) model.Manifest {
	return ct.ManifestOf(t, func(b *ct.Draft) {
		b.Program("git", model.Program{
			Version: ct.Version("git --version", "git version ([0-9.]+)"),
			Install: ct.Variants(model.E("dnf", model.InstallVariant{Command: s("sudo dnf install -y git")})),
		})
		b.Script("dotfiles", model.ScriptStep{Run: s("echo setup"), Check: s("test -d $HOME/.dotfiles")})
		b.Script("uncheckable", model.ScriptStep{Run: s("echo once")})
		b.Script("not-opted-in", model.ScriptStep{Run: s("echo never"), Check: s("true")})
		b.Machine("laptop", model.MachineConfig{PM: ct.PM("git", "dnf"), Scripts: []string{"dotfiles", "uncheckable"}})
	})
}

var laptop = coremodel.SystemInfo{Machine: "laptop", Os: coremodel.Linux, Distro: s("fedora"), Arch: "x86_64"}

func refresh(t *testing.T, runner *fakeexec.Runner, previous *coremodel.MachineState, runs model.Map[coremodel.ScriptState]) coremodel.MachineState {
	t.Helper()
	engine := NewStatusEngine(NewVersionChecker(runner, repoFrame), runner, repoFrame, nil)
	return must[coremodel.MachineState](t)(engine.Refresh(statusManifest(t), laptop, previous, runs))
}

var history = coremodel.ScriptState{Status: coremodel.Done, LastRun: s("2026-08-17T10:00:00Z"), ExitCode: model.Ptr(0)}

func TestCheckedScriptObservedAsDoneEvenIfNeverRunByTool(t *testing.T) {
	runner := fakeexec.New().
		OnCommand("git --version", fakeexec.Stdout("git version 2.55.0")).
		OnCommand("test -d $HOME/.dotfiles")
	state := refresh(t, runner, nil, model.Map[coremodel.ScriptState]{})
	if d := state.Scripts.Value("dotfiles"); d.Status != coremodel.Done || d.LastRun != nil {
		t.Errorf("%+v", d)
	}
}

func TestCheckedScriptObservedAsPendingWhenCheckFails(t *testing.T) {
	state := refresh(t, fakeexec.New(), nil, model.Map[coremodel.ScriptState]{})
	eq(t, coremodel.Pending, state.Scripts.Value("dotfiles").Status)
}

func TestScriptsWithoutOptInAreNotObserved(t *testing.T) {
	state := refresh(t, fakeexec.New(), nil, model.Map[coremodel.ScriptState]{})
	if state.Scripts.Has("not-opted-in") {
		t.Error("observed")
	}
}

func TestUncheckableScriptKeepsRunHistoryOnly(t *testing.T) {
	runner := fakeexec.New()
	if refresh(t, runner, nil, model.Map[coremodel.ScriptState]{}).Scripts.Has("uncheckable") {
		t.Error("observed without history")
	}
	withRun := refresh(t, runner, nil, model.MapOf(model.E("uncheckable", history)))
	if !withRun.Scripts.Value("uncheckable").Equal(history) {
		t.Errorf("%+v", withRun.Scripts.Value("uncheckable"))
	}
	// ...and it survives later refreshes via the previous state.
	later := refresh(t, runner, &withRun, model.Map[coremodel.ScriptState]{})
	if !later.Scripts.Value("uncheckable").Equal(history) {
		t.Errorf("%+v", later.Scripts.Value("uncheckable"))
	}
}

func TestCheckOverridesFreshRunStatusButKeepsHistory(t *testing.T) {
	// The tool just ran the script "successfully", but the check still fails.
	state := refresh(t, fakeexec.New(), nil, model.MapOf(model.E("dotfiles", history)))
	entry := state.Scripts.Value("dotfiles")
	if entry.Status != coremodel.Pending || *entry.LastRun != "2026-08-17T10:00:00Z" || *entry.ExitCode != 0 {
		t.Errorf("%+v", entry)
	}
}
