// Package diff compares the fleet: manifest × states -> DiffReport. Pure.
package diff

import (
	"slices"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/model"
)

// InstallKind is what a machine's state says of a program.
type InstallKind int

const (
	// Unknown: no state entry for this program (stale state file or check failed to parse).
	Unknown InstallKind = iota
	Installed
	Missing
)

// InstallState is one program on one machine; Version only when Installed.
type InstallState struct {
	Kind    InstallKind
	Version *string
}

// ProgramRow is one program across the machines.
type ProgramRow struct {
	Program    string
	PerMachine model.Map[InstallState]
}

// Drift says two or more machines report distinct installed versions.
func (r ProgramRow) Drift() bool {
	var versions []string
	for s := range r.PerMachine.Values() {
		if s.Kind == Installed && s.Version != nil {
			versions = append(versions, *s.Version)
		}
	}
	return len(model.Distinct(versions)) > 1
}

// Incomplete says at least one machine is missing this program.
func (r ProgramRow) Incomplete() bool {
	for s := range r.PerMachine.Values() {
		if s.Kind == Missing {
			return true
		}
	}
	return false
}

// ConfigKind is what a machine's state says of a config unit.
type ConfigKind int

const (
	// ConfigUnknown: no state entry: the unit isn't on this machine, or chezmoi couldn't answer.
	ConfigUnknown ConfigKind = iota
	ConfigApplied
	ConfigDrifted
)

// ConfigCell is one unit on one machine; Files (how many drifted) only when ConfigDrifted.
type ConfigCell struct {
	Kind  ConfigKind
	Files int
}

// ConfigRow is one config unit across the machines.
type ConfigRow struct {
	Unit       string
	PerMachine model.Map[ConfigCell]
}

// Drifted says at least one machine's files differ from the repo.
func (r ConfigRow) Drifted() bool {
	for c := range r.PerMachine.Values() {
		if c.Kind == ConfigDrifted {
			return true
		}
	}
	return false
}

// DiffReport is the fleet compared.
type DiffReport struct {
	Machines []string
	Rows     []ProgramRow
	// Configs is every config unit any compared machine reports; empty without configs.
	Configs []ConfigRow
}

// HasDrift says some program's versions differ between machines.
func (r DiffReport) HasDrift() bool { return slices.ContainsFunc(r.Rows, ProgramRow.Drift) }

// HasMissing says some machine is missing some program.
func (r DiffReport) HasMissing() bool { return slices.ContainsFunc(r.Rows, ProgramRow.Incomplete) }

// HasConfigDrift says some machine's configs differ from the repo.
func (r DiffReport) HasConfigDrift() bool { return slices.ContainsFunc(r.Configs, ConfigRow.Drifted) }

// Diff compares states against manifest's programs.
func Diff(manifest model.Manifest, states []coremodel.MachineState) DiffReport {
	var machines []string
	byMachine := map[string]coremodel.MachineState{}
	for _, s := range states {
		machines = append(machines, s.Machine)
		byMachine[s.Machine] = s
	}
	slices.Sort(machines)

	var rows []ProgramRow
	for _, program := range slices.Sorted(slices.Values(manifest.Programs.Keys())) {
		var per model.Map[InstallState]
		for _, machine := range machines {
			entry, ok := byMachine[machine].Programs.Get(program)
			cell := InstallState{Kind: Unknown}
			switch {
			case ok && entry.Status == coremodel.Installed:
				cell = InstallState{Installed, entry.Version}
			case ok && entry.Status == coremodel.Missing:
				cell = InstallState{Kind: Missing}
			}
			per.Set(machine, cell)
		}
		rows = append(rows, ProgramRow{program, per})
	}

	var units []string
	for _, s := range states {
		units = append(units, s.Configs.Keys()...)
	}
	units = model.Distinct(units)
	slices.Sort(units)
	var configs []ConfigRow
	for _, unit := range units {
		var per model.Map[ConfigCell]
		for _, machine := range machines {
			entry, ok := byMachine[machine].Configs.Get(unit)
			cell := ConfigCell{Kind: ConfigUnknown}
			switch {
			case ok && entry.Status == coremodel.ConfigApplied:
				cell = ConfigCell{Kind: ConfigApplied}
			case ok && entry.Status == coremodel.ConfigDrifted:
				cell = ConfigCell{ConfigDrifted, len(entry.Files)}
			}
			per.Set(machine, cell)
		}
		configs = append(configs, ConfigRow{unit, per})
	}
	return DiffReport{machines, rows, configs}
}
