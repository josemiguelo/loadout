package engine

import (
	"testing"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	ct "github.com/josemiguelo/loadout/internal/core/coretest"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/exec/fakeexec"
	"github.com/josemiguelo/loadout/internal/model"
)

var noFrame = exec.CommandFrame{}

var ripgrepCheck = ct.Version("rg --version", "ripgrep ([0-9][0-9a-zA-Z.-]*)")

func check(t *testing.T, runner exec.ProcessRunner, vc *model.VersionCheck) coremodel.ProgramState {
	t.Helper()
	return must[coremodel.ProgramState](t)(NewVersionChecker(runner, noFrame).Check(vc))
}

func versionOf(state coremodel.ProgramState) string {
	if state.Version == nil {
		return "<nil>"
	}
	return *state.Version
}

func TestInstalledWithVersion(t *testing.T) {
	runner := fakeexec.New().OnCommand("rg --version", fakeexec.Stdout("ripgrep 14.1.0\nfeatures: -simd128\n"))
	state := check(t, runner, ripgrepCheck)
	if state.Status != coremodel.Installed || versionOf(state) != "14.1.0" {
		t.Errorf("%+v", state)
	}
}

func TestMissingWhenCommandFails(t *testing.T) {
	// The check IS the program (no probe): command not found = not installed.
	if state := check(t, fakeexec.New(), ripgrepCheck); state.Status != coremodel.Missing {
		t.Errorf("%+v", state)
	}
}

func TestACheckThroughAToolThatIsNotThereIsUnknownNotMissing(t *testing.T) {
	// brew off PATH once reported every brew program missing. The check
	// asks THROUGH brew (probe set), so a 127 is brew's absence, not bat's.
	viaBrew := &model.VersionCheck{Command: "brew list --versions bat", Regex: s("([0-9.]+)"), Probe: s("brew")}
	gone := check(t, fakeexec.New(), viaBrew)
	if gone.Status != coremodel.Unknown || *gone.Reason != "sh: command not found" {
		t.Errorf("%+v", gone)
	}

	// brew present and saying no is a real missing, with what it said.
	runner := fakeexec.New().OnCommand("brew list --versions bat", fakeexec.Exit(1), fakeexec.Stderr("Error: No such keg: bat"))
	missing := check(t, runner, viaBrew)
	if missing.Status != coremodel.Missing || *missing.Reason != "Error: No such keg: bat" {
		t.Errorf("%+v", missing)
	}
}

func TestResolvedChecksCarryTheirInstallersProbe(t *testing.T) {
	manifest := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("pm", model.Installer{Probe: s("pm"), Install: s("pm install {pkg}"), Check: s("pm query {pkg}"), Regex: s("([0-9.]+)")})
		b.Program("bat", model.Program{Install: ct.Via("pm")})
		b.Program("rg", model.Program{
			Version: ct.Version("rg --version", "([0-9.]+)"),
			Install: ct.Variants(model.E("pm", model.InstallVariant{Check: s("rg --version"), Regex: s("([0-9.]+)")})),
		})
	})
	// A check through the mechanism knows the tool it asks through...
	if p := manifest.CheckFor("bat", s("pm")).Probe; p == nil || *p != "pm" {
		t.Errorf("bat: %v", p)
	}
	// ...even when the variant overrides the command: it's still asked
	// through the mechanism the variant is keyed by.
	if p := manifest.CheckFor("rg", s("pm")).Probe; p == nil || *p != "pm" {
		t.Errorf("rg: %v", p)
	}
	// The program's own version carries none: it IS the program.
	if p := manifest.CheckFor("rg", nil).Probe; p != nil {
		t.Errorf("rg's own: %v", *p)
	}
}

func TestInstalledWithoutVersionWhenRegexDoesNotMatch(t *testing.T) {
	state := check(t, fakeexec.New().OnCommand("rg --version", fakeexec.Stdout("something unexpected")), ripgrepCheck)
	if state.Status != coremodel.Installed || state.Version != nil {
		t.Errorf("%+v", state)
	}
}

func TestUnknownWhenNoVersionCheckDeclared(t *testing.T) {
	if state := check(t, fakeexec.New(), nil); state.Status != coremodel.Unknown {
		t.Errorf("%+v", state)
	}
}

func TestFileCheckCommandsRunAsRepoScripts(t *testing.T) {
	runner := fakeexec.New().OnCommand("sh 'scripts/ver.sh' check", fakeexec.Stdout("tool 2.0"))
	if v := versionOf(check(t, runner, ct.Version("file:scripts/ver.sh check", "tool ([0-9.]+)"))); v != "2.0" {
		t.Error(v)
	}
}

func TestReadsVersionFromStderrWhenStdoutEmpty(t *testing.T) {
	runner := fakeexec.New().OnCommand("rg --version", fakeexec.Stderr("ripgrep 13.0.0"))
	if v := versionOf(check(t, runner, ripgrepCheck)); v != "13.0.0" {
		t.Error(v)
	}
}

func TestCheckAllChecksEveryProgram(t *testing.T) {
	manifest := ct.Example(t)
	runner := fakeexec.New().
		OnCommand("git --version", fakeexec.Stdout("git version 2.46.0")).
		OnCommand("rg --version", fakeexec.Stdout("ripgrep 14.1.0"))
	// rustup unregistered -> exit 127 -> Missing
	checks := model.MapValues(manifest.Programs, func(_ string, p model.Program) *model.VersionCheck { return p.Version })
	results := must[model.Map[coremodel.ProgramState]](t)(NewVersionChecker(runner, noFrame).CheckAll(checks))
	if git := results.Value("git"); git.Status != coremodel.Installed || versionOf(git) != "2.46.0" {
		t.Errorf("git: %+v", git)
	}
	if rg := results.Value("ripgrep"); rg.Status != coremodel.Installed {
		t.Errorf("ripgrep: %+v", rg)
	}
	if rustup := results.Value("rustup"); rustup.Status != coremodel.Missing {
		t.Errorf("rustup: %+v", rustup)
	}
	if keys := results.Keys(); len(keys) != 3 || keys[0] != "git" || keys[2] != "rustup" {
		t.Errorf("in the checks' order: %v", keys)
	}
}

func TestAYesNoCheckRecordsInstalledWithNoVersion(t *testing.T) {
	runner := fakeexec.New().OnCommand("test -f /etc/dnf/dnf.conf", fakeexec.Stdout("anything 1.2.3"))
	state := check(t, runner, &model.VersionCheck{Command: "test -f /etc/dnf/dnf.conf"})
	if state.Status != coremodel.Installed || state.Version != nil {
		t.Errorf("%+v", state)
	}
	// ...and a failing one is missing, as any check.
	if missing := check(t, fakeexec.New(), &model.VersionCheck{Command: "test -f /nope"}); missing.Status != coremodel.Missing {
		t.Errorf("%+v", missing)
	}
}

func TestAProgramsPathComesFirstForItsCheck(t *testing.T) {
	runner := fakeexec.New().OnCommand(`PATH="$HOME/.local/bin:$PATH"; export PATH; ngrok version`, fakeexec.Stdout("ngrok version 3.4.0"))
	vc := &model.VersionCheck{Command: "ngrok version", Regex: s("([0-9.]+)"), Path: []string{"$HOME/.local/bin"}}
	if v := versionOf(check(t, runner, vc)); v != "3.4.0" {
		t.Error(v)
	}
}
