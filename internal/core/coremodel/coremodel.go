// Package coremodel is what the binary observes, as opposed to what the lock
// declares: a machine's state file
// and the system it runs on.
package coremodel

import (
	"slices"

	"github.com/josemiguelo/loadout/internal/model"
)

// SchemaVersion is the highest state-file schema this build understands.
const SchemaVersion = 1

// MachineState is `<state>/<machine>.json`: what one machine last observed.
type MachineState struct {
	// SchemaVersion is the file's schema; 0 is written as SchemaVersion.
	SchemaVersion int
	Machine       string
	Os            string
	Distro        *string
	Arch          string
	ToolVersion   string
	// UpdatedAt is the ISO-8601 UTC timestamp of the last state refresh.
	UpdatedAt string
	Programs  model.Map[ProgramState]
	Scripts   model.Map[ScriptState]
	// Configs is the config units (`layout configs`), keyed by unit name. Left
	// out of the file when empty, so a repo without configs writes what it
	// always did.
	Configs model.Map[ConfigState]
}

// ConfigState is one config unit as chezmoi reported it.
type ConfigState struct {
	Status ConfigStatus
	// Files is the targets `chezmoi apply` would change, relative to the destination (Drifted).
	Files []string
	// Reason is why chezmoi couldn't answer (Unknown). Text for a person; never parsed.
	Reason *string
}

// ConfigStatus is a config unit's verdict.
type ConfigStatus string

const (
	ConfigApplied ConfigStatus = "applied"
	ConfigDrifted ConfigStatus = "drifted"
	ConfigUnknown ConfigStatus = "unknown"
)

// ProgramState is one program as its version check saw it.
type ProgramState struct {
	Status  ProgramStatus
	Version *string
	// Reason is why the check couldn't answer (Unknown: "brew: command not
	// found") or what the tool said when it said no (Missing, when it said
	// anything). Text for a person; never parsed.
	Reason *string
}

// ProgramStatus is a program's verdict.
type ProgramStatus string

const (
	Installed ProgramStatus = "installed"
	Missing   ProgramStatus = "missing"
	// Unknown: the program declares no version check, or the check couldn't run.
	Unknown ProgramStatus = "unknown"
)

// ScriptState is one script's verdict and its last run by loadout.
type ScriptState struct {
	Status   ScriptStatus
	LastRun  *string
	ExitCode *int
}

// ScriptStatus is a script's verdict.
type ScriptStatus string

const (
	Done    ScriptStatus = "done"
	Failed  ScriptStatus = "failed"
	Pending ScriptStatus = "pending"
)

// OsFamily is the operating system, as LOADOUT_OS and state files name it.
type OsFamily string

const (
	Linux OsFamily = "linux"
	MacOS OsFamily = "macos"
)

// OsFamilyFromID is the family id names, or "" when none.
func OsFamilyFromID(id string) OsFamily {
	switch OsFamily(id) {
	case Linux, MacOS:
		return OsFamily(id)
	}
	return ""
}

// SystemInfo is the machine loadout runs on.
type SystemInfo struct {
	Machine string
	Os      OsFamily
	Distro  *string
	Arch    string
}

// Equal is value equality: maps compare by content, in any order.
func (s MachineState) Equal(o MachineState) bool {
	return schema(s.SchemaVersion) == schema(o.SchemaVersion) &&
		s.Machine == o.Machine && s.Os == o.Os && eqPtr(s.Distro, o.Distro) && s.Arch == o.Arch &&
		s.ToolVersion == o.ToolVersion && s.UpdatedAt == o.UpdatedAt &&
		mapsEqual(s.Programs, o.Programs, ProgramState.Equal) &&
		mapsEqual(s.Scripts, o.Scripts, ScriptState.Equal) &&
		mapsEqual(s.Configs, o.Configs, ConfigState.Equal)
}

// Equal is value equality.
func (p ProgramState) Equal(o ProgramState) bool {
	return p.Status == o.Status && eqPtr(p.Version, o.Version) && eqPtr(p.Reason, o.Reason)
}

// Equal is value equality.
func (s ScriptState) Equal(o ScriptState) bool {
	return s.Status == o.Status && eqPtr(s.LastRun, o.LastRun) && eqPtr(s.ExitCode, o.ExitCode)
}

// Equal is value equality.
func (c ConfigState) Equal(o ConfigState) bool {
	return c.Status == o.Status && slices.Equal(c.Files, o.Files) && eqPtr(c.Reason, o.Reason)
}

func schema(v int) int {
	if v == 0 {
		return SchemaVersion
	}
	return v
}

func eqPtr[T comparable](a, b *T) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func mapsEqual[V any](a, b model.Map[V], eq func(V, V) bool) bool {
	if a.Len() != b.Len() {
		return false
	}
	for k, v := range a.All() {
		w, ok := b.Get(k)
		if !ok || !eq(v, w) {
			return false
		}
	}
	return true
}
