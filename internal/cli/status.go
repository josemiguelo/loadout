package cli

import (
	"sort"
	"strings"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/core/state"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/version"
	"github.com/spf13/cobra"
)

func newStatusCmd() *cobra.Command {
	var jsonOut, noWrite bool
	cmd := subcommand("status", commandHelp(
		"Observe this machine: every program version and script check re-asked, drift explained, state file updated.",
		"--json      print the full state as JSON",
		"--no-write  observe without touching the state file",
	), nil, func(cmd *cobra.Command, args []string) error {
		return runStatus(appCtx, jsonOut, noWrite)
	})
	boolFlag(cmd, cmd.Flags(), &jsonOut, "json", "", "Print the machine state as JSON")
	boolFlag(cmd, cmd.Flags(), &noWrite, "no-write", "", "Don't update the state file")
	return cmd
}

// observed is one refresh and what it couldn't answer.
type observed struct {
	state       coremodel.MachineState
	detail      map[string]string
	toolsDown   []engine.ToolDown
	configsDown *string
}

func runStatus(a *app.AppContext, jsonOut, noWrite bool) error {
	manifest, err := a.LoadManifest()
	if err != nil {
		return err
	}
	system := a.DetectSystem()
	store, err := a.StateStore()
	if err != nil {
		return err
	}
	subjects := "programs and scripts"
	if configs, err := a.Configs(); err != nil {
		return err
	} else if configs != nil {
		subjects = "programs, scripts and configs"
	}
	seen, err := spinning("checking "+subjects+"…", func() (observed, error) {
		if noWrite {
			observer, err := a.StatusEngine(system)
			if err != nil {
				return observed{}, err
			}
			s, err := observer.Refresh(manifest, system, store.Read(system.Machine), model.Map[coremodel.ScriptState]{})
			return observed{s, observer.LastScriptDetail(), observer.LastToolsDown(), observer.LastConfigsDown()}, err
		}
		s, err := a.RefreshAndWriteState(manifest, system, model.Map[coremodel.ScriptState]{})
		return observed{s, a.LastScriptDetail(), a.LastToolsDown(), a.LastConfigsDown()}, err
	})
	if err != nil {
		return err
	}
	for _, w := range store.LastWarnings() {
		echoErr("warning: " + w)
	}

	if jsonOut {
		echo(strings.TrimSuffix(state.Encode(seen.state), "\n"))
		return nil
	}
	printStatusTable(seen.state, seen.detail)
	// The per-row boxes say WHICH programs; this says what happened, once,
	// in words: the tool the checks go through wasn't there.
	for _, down := range seen.toolsDown {
		echo("")
		echo(" " + Style.Warn("⚠") + "  " + Style.Warn(down.Message()) + Style.Dim("  ("+strings.Join(down.Programs, ", ")+")"))
	}
	if seen.configsDown != nil {
		echo("")
		echo(" " + Style.Warn("⚠") + "  " + Style.Warn("configs not checked: "+*seen.configsDown))
	}
	// The one self-knowledge carve-out: is this binary itself behind?
	if latest := app.BehindRelease(a.Runner, true); latest != "" {
		echo("")
		echo(" " + Style.Warn("↑") + "  loadout " + version.Version + " — " + latest + " available " + Style.Dim("(run: loadout self-upgrade)"))
	}
	if !noWrite {
		echo(Style.Dim("\nState written to " + store.PathFor(system.Machine)))
	}
	return nil
}

// sortedKeys is m's keys in name order.
func sortedKeys[V any](m model.Map[V]) []string {
	keys := m.Keys()
	sort.Strings(keys)
	return keys
}

// Same visual language as the home screen: ✔/✘/· markers, color as signal
// only (ok/warn/error/dim), dim detail lines under failing rows.
func printStatusTable(s coremodel.MachineState, detail map[string]string) {
	distro := ""
	if s.Distro != nil {
		distro = "/" + *s.Distro
	}
	echo(Style.Dim("machine ") + Style.Machine(s.Machine) + Style.Dim(" │ "+string(s.Os)+distro+" │ "+s.Arch))
	echo("")
	nameWidth := 7
	for _, keys := range [][]string{s.Programs.Keys(), s.Scripts.Keys(), s.Configs.Keys()} {
		for _, k := range keys {
			nameWidth = max(nameWidth, runeLen(k))
		}
	}
	echo(Style.Header("  " + padEnd("PROGRAM", nameWidth+4) + padEnd("STATUS", 13) + "VERSION"))
	// Rows that aren't settled get boxed by echoRows, same as diff's drift
	// rows: a missing install is severe, a pending script is not.
	var rows []TableRow
	for _, name := range sortedKeys(s.Programs) {
		program := s.Programs.Value(name)
		var mark, status string
		var severity *bool
		switch program.Status {
		case coremodel.Installed:
			mark, status = Style.Ok("✔"), Style.Ok(padEnd("installed", 13))
		case coremodel.Missing:
			mark, status, severity = Style.Error("✘"), Style.Error(padEnd("missing", 13)), severe
		default:
			// An unknown WITH a reason is a check that couldn't run (brew off
			// PATH): unsettled, boxed amber, the reason inside the box — never
			// a quiet "-" that reads as nothing wrong.
			if program.Reason == nil {
				mark, status = Style.Dim("·"), Style.Dim(padEnd("unknown", 13))
			} else {
				mark, status, severity = Style.Warn("?"), Style.Warn(padEnd("not checked", 13)), attention
			}
		}
		version := "-"
		if program.Version != nil {
			version = *program.Version
		}
		lines := []string{mark + "  " + padEnd(name, nameWidth+1) + status + version}
		if program.Reason != nil {
			lines = append(lines, Style.Dim("     "+*program.Reason))
		}
		rows = append(rows, TableRow{lines, severity})
	}
	echoRows(rows)
	printStatusScripts(s, detail, nameWidth)
	printStatusConfigs(s, nameWidth)
}

func printStatusScripts(s coremodel.MachineState, detail map[string]string, nameWidth int) {
	if s.Scripts.IsEmpty() {
		return
	}
	echo("")
	echo(Style.Header("  " + padEnd("SCRIPT", nameWidth+4) + "STATUS"))
	var rows []TableRow
	for _, name := range sortedKeys(s.Scripts) {
		var mark, status string
		var severity *bool
		switch s.Scripts.Value(name).Status {
		case coremodel.Done:
			mark, status = Style.Ok("✔"), Style.Ok("done")
		case coremodel.Pending:
			mark, status, severity = Style.Warn("✘"), Style.Warn("pending"), attention
		default:
			mark, status, severity = Style.Error("✘"), Style.Error("failed"), severe
		}
		lines := []string{mark + "  " + padEnd(name, nameWidth+1) + status}
		// What the failing check reported — the "missing: ..." lines, inside
		// the box with the row they explain.
		if d, ok := detail[name]; ok {
			for _, line := range strings.Split(d, "\n") {
				lines = append(lines, Style.Dim(padEnd("", nameWidth+5)+line))
			}
		}
		rows = append(rows, TableRow{lines, severity})
	}
	echoRows(rows)
}

// A drifted unit lists the files apply would change, inside its box.
func printStatusConfigs(s coremodel.MachineState, nameWidth int) {
	if s.Configs.IsEmpty() {
		return
	}
	echo("")
	echo(Style.Header("  " + padEnd("CONFIG", nameWidth+4) + "STATUS"))
	var rows []TableRow
	for _, name := range sortedKeys(s.Configs) {
		config := s.Configs.Value(name)
		var mark, status string
		var severity *bool
		switch config.Status {
		case coremodel.ConfigApplied:
			mark, status = Style.Ok("✔"), Style.Ok("applied")
		case coremodel.ConfigDrifted:
			mark, status, severity = Style.Warn("✘"), Style.Warn("drifted"), attention
		default:
			mark, status, severity = Style.Warn("?"), Style.Warn("not checked"), attention
		}
		lines := []string{mark + "  " + padEnd(name, nameWidth+1) + status}
		extra := append([]string{}, config.Files...)
		if config.Reason != nil {
			extra = append(extra, *config.Reason)
		}
		for _, line := range extra {
			lines = append(lines, Style.Dim(padEnd("", nameWidth+5)+line))
		}
		rows = append(rows, TableRow{lines, severity})
	}
	echoRows(rows)
}
