package engine

import (
	"maps"
	"testing"

	ct "github.com/josemiguelo/loadout/internal/core/coretest"
	"github.com/josemiguelo/loadout/internal/core/exec/fakeexec"
	"github.com/josemiguelo/loadout/internal/model"
)

// Which steps need sudo's password: what makes a run ask for it upfront.

func TestACommandNeedsSudoOnlyWhenItRunsSudo(t *testing.T) {
	for command, want := range map[string]bool{
		"sudo pacman -S --noconfirm kitty": true,
		"cd /tmp && sudo -E make install":  true,
		"x=1; sudo tee /etc/x.conf":        true,
		"script -q pseudo-tty":             false,
		"sudoku --solve":                   false,
		"omarchy pkg add kitty":            false,
		"sh 'setup.sh' install":            false,
	} {
		if CommandNeedsSudo(command) != want {
			t.Errorf("%q: want %v", command, want)
		}
	}
}

func sudoManifest(t *testing.T) model.Manifest {
	return ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("sneaky", model.Installer{Install: s("helper add {pkg}"), Upgrade: s("helper update"), Sudo: true})
		b.Installer("plain", model.Installer{Install: s("plain add {pkg}"), Upgrade: s("plain update")})
		b.Program("visible", model.Program{Install: ct.Variants(model.E("pacman", model.InstallVariant{Command: s("sudo pacman -S visible")}))})
		b.Program("declared", model.Program{Install: ct.Via("sneaky")})
		b.Program("opted-out", model.Program{Install: ct.Variants(model.E("sneaky", model.InstallVariant{Sudo: model.Ptr(false)}))})
		b.Program("own-script", model.Program{Install: ct.Variants(model.E("plain", model.InstallVariant{Command: s("sh setup.sh"), Sudo: model.Ptr(true)}))})
		b.Program("none", model.Program{Install: ct.Via("plain")})
		b.Machine("m", model.MachineConfig{PM: ct.PM("visible", "pacman", "declared", "sneaky", "opted-out", "sneaky", "own-script", "plain", "none", "plain")})
	})
}

func TestAnInstallNeedsSudoWhenItsCommandRunsItOrItsVariantOrInstallerSaysSo(t *testing.T) {
	runner := fakeexec.New()
	plan := must[[]PlanItem](t)(NewInstallEngine(runner, NewVersionChecker(runner, repoFrame), repoFrame).
		Plan(sudoManifest(t), "m", []string{"visible", "declared", "opted-out", "own-script", "none"}, model.Map[cs]{}, func(string) bool { return true }))
	sudo := map[string]bool{}
	for _, item := range Installs(plan) {
		sudo[item.Program] = item.Sudo
	}
	want := map[string]bool{"visible": true, "declared": true, "opted-out": false, "own-script": true, "none": false}
	if !maps.Equal(want, sudo) {
		t.Errorf("%v", sudo)
	}
}

func TestAnUpgradeNeedsSudoWhenItsInstallerSaysSo(t *testing.T) {
	steps := must[[]UpgradeStep](t)(PlanUpgrade(sudoManifest(t), "m", []string{"sneaky", "plain"}))
	sudo := map[string]bool{}
	for _, step := range steps {
		sudo[step.Command] = step.Sudo
	}
	if !maps.Equal(map[string]bool{"helper update": true, "plain update": false}, sudo) {
		t.Errorf("%v", sudo)
	}
}

func TestAScriptNeedsSudoWhenItSaysSoOrItsCommandRunsIt(t *testing.T) {
	runner := NewScriptRunner(fakeexec.New(), repoFrame)
	for _, c := range []struct {
		step model.ScriptStep
		want bool
	}{
		{model.ScriptStep{File: s("x.sh"), Sudo: true}, true},
		{model.ScriptStep{Run: s("sudo systemctl enable --now x")}, true},
		{model.ScriptStep{File: s("x.sh")}, false},
		{model.ScriptStep{Run: s("systemctl --user enable x")}, false},
	} {
		if runner.NeedsSudo(c.step, "") != c.want {
			t.Errorf("%+v: want %v", c.step, c.want)
		}
	}
}

func TestAScriptIsPendingUnlessItsCheckPasses(t *testing.T) {
	fake := fakeexec.New().OnCommand("test -f done")
	runner := NewScriptRunner(fake, repoFrame)
	pending := func(step model.ScriptStep, force bool) bool { return must[bool](t)(runner.Pending(step, force, "")) }
	if pending(model.ScriptStep{File: s("x.sh"), Check: s("test -f done")}, false) {
		t.Error("a passing check is not pending")
	}
	if !pending(model.ScriptStep{File: s("x.sh"), Check: s("test -f done")}, true) {
		t.Error("force is pending")
	}
	if !pending(model.ScriptStep{File: s("x.sh"), Check: s("test -f missing")}, false) {
		t.Error("a failing check is pending")
	}
	if !pending(model.ScriptStep{File: s("x.sh")}, false) {
		t.Error("no check is pending")
	}
}
