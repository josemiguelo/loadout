package diff

import (
	"reflect"
	"testing"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	ct "github.com/josemiguelo/loadout/internal/core/coretest"
	"github.com/josemiguelo/loadout/internal/model"
)

type ps = coremodel.ProgramState

func installed(v string) ps { return ps{Status: coremodel.Installed, Version: &v} }

var missing = ps{Status: coremodel.Missing}

func state(machine string, programs ...model.Entry[ps]) coremodel.MachineState {
	return coremodel.MachineState{
		Machine: machine, Os: "linux", Arch: "x86_64", ToolVersion: "0.1.0",
		UpdatedAt: "2026-08-14T12:00:00Z", Programs: model.MapOf(programs...),
	}
}

func row(r DiffReport, program string) ProgramRow {
	for _, p := range r.Rows {
		if p.Program == program {
			return p
		}
	}
	panic(program)
}

func eq(t *testing.T, want, got any) {
	t.Helper()
	if !reflect.DeepEqual(want, got) {
		t.Errorf("\nwant %#v\n got %#v", want, got)
	}
}

func TestDetectsDriftMissingAndUnknown(t *testing.T) {
	laptop := state("laptop", model.E("git", installed("2.46.0")), model.E("ripgrep", installed("14.1.0")), model.E("rustup", missing))
	desktop := state("desktop", model.E("git", installed("2.43.0")), model.E("ripgrep", installed("14.1.0")))
	// no rustup entry at all on desktop -> Unknown

	report := Diff(ct.Example(t), []coremodel.MachineState{laptop, desktop})
	eq(t, []string{"desktop", "laptop"}, report.Machines)
	var programs []string
	for _, r := range report.Rows {
		programs = append(programs, r.Program)
	}
	eq(t, []string{"git", "ripgrep", "rustup"}, programs)

	git := row(report, "git")
	eq(t, true, git.Drift())
	eq(t, false, git.Incomplete())
	ripgrep := row(report, "ripgrep")
	eq(t, false, ripgrep.Drift())
	eq(t, false, ripgrep.Incomplete())
	rustup := row(report, "rustup")
	eq(t, false, rustup.Drift())
	eq(t, true, rustup.Incomplete())
	eq(t, Unknown, rustup.PerMachine.Value("desktop").Kind)
	eq(t, Missing, rustup.PerMachine.Value("laptop").Kind)

	eq(t, true, report.HasDrift())
	eq(t, true, report.HasMissing())
}

func TestCleanReportHasNoFlags(t *testing.T) {
	all := []model.Entry[ps]{model.E("git", installed("2.46.0")), model.E("ripgrep", installed("14.1.0")), model.E("rustup", installed("1.27.1"))}
	report := Diff(ct.Example(t), []coremodel.MachineState{state("a", all...), state("b", all...)})
	eq(t, false, report.HasDrift())
	eq(t, false, report.HasMissing())
	eq(t, 0, len(report.Configs))
}

func TestConfigUnitsComparePerMachine(t *testing.T) {
	a := state("a")
	a.Configs = model.MapOf(
		model.E("zsh", coremodel.ConfigState{Status: coremodel.ConfigDrifted, Files: []string{".config/zsh/.zshrc", ".zshenv"}}),
		model.E("mise", coremodel.ConfigState{Status: coremodel.ConfigApplied}),
	)
	b := state("b")
	b.Configs = model.MapOf(model.E("zsh", coremodel.ConfigState{Status: coremodel.ConfigApplied}))

	report := Diff(ct.Example(t), []coremodel.MachineState{a, b})
	eq(t, "mise", report.Configs[0].Unit)
	eq(t, "zsh", report.Configs[1].Unit)
	zsh := report.Configs[1]
	eq(t, ConfigCell{ConfigDrifted, 2}, zsh.PerMachine.Value("a"))
	eq(t, ConfigCell{Kind: ConfigApplied}, zsh.PerMachine.Value("b"))
	// A unit one machine doesn't have (ignored there) is no drift.
	mise := report.Configs[0]
	eq(t, ConfigCell{Kind: ConfigUnknown}, mise.PerMachine.Value("b"))
	eq(t, false, mise.Drifted())
	eq(t, true, report.HasConfigDrift())
}
