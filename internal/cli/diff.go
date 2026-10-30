package cli

import (
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/diff"
	"github.com/spf13/cobra"
)

func driftedLabel(cell diff.ConfigCell) string { return "drifted (" + strconv.Itoa(cell.Files) + ")" }

func flagsOf(row diff.ProgramRow) string {
	var flags []string
	if row.Drift() {
		flags = append(flags, "drift")
	}
	if row.Incomplete() {
		flags = append(flags, "incomplete")
	}
	return strings.Join(flags, ",")
}

func newDiffCmd() *cobra.Command {
	var machines string
	var given bool
	cmd := subcommand("diff", commandHelp(
		"Compare all machines' state files: missing installs, version drift and drifted configs. Exits 1 when something is off.",
		"--machines a,b  narrow the comparison to those machines",
	), nil, func(cmd *cobra.Command, args []string) error {
		given = cmd.Flags().Changed("machines")
		return runDiff(machines, given)
	})
	stringFlag(cmd, cmd.Flags(), &machines, "machines", "", "", "Comma-separated machine names to compare (default: all with a state file)")
	return cmd
}

func runDiff(machines string, given bool) error {
	a := appCtx
	manifest, err := a.LoadManifest()
	if err != nil {
		return err
	}
	var filter []string
	if given {
		filter = []string{}
		for _, m := range strings.Split(machines, ",") {
			if m = strings.TrimSpace(m); m != "" {
				filter = append(filter, m)
			}
		}
	}
	fleet, err := a.FleetStates()
	if err != nil {
		return err
	}
	var states []coremodel.MachineState
	for name, s := range fleet.All() {
		if filter == nil || slices.Contains(filter, name) {
			states = append(states, s)
		}
	}
	for _, w := range a.FleetWarnings() {
		echoErr("warning: " + w)
	}

	if len(states) == 0 {
		layout, err := a.Layout()
		if err != nil {
			return err
		}
		echo("No machine state files found in " + filepath.Join(a.RepoRoot, layout.State) + ". Run `status` or `sync` on your machines first.")
		return exitWith(1)
	}

	report := diff.Diff(manifest, states)

	nameWidth := 7
	for _, r := range report.Rows {
		nameWidth = max(nameWidth, runeLen(r.Program))
	}
	for _, c := range report.Configs {
		nameWidth = max(nameWidth, runeLen(c.Unit))
	}
	nameWidth += 2
	colWidth := 8
	for _, m := range report.Machines {
		colWidth = max(colWidth, runeLen(m))
	}
	for _, c := range report.Configs {
		for cell := range c.PerMachine.Values() {
			if cell.Kind == diff.ConfigDrifted {
				colWidth = max(colWidth, runeLen(driftedLabel(cell)))
			}
		}
	}
	colWidth += 2
	machineHeads := ""
	for _, m := range report.Machines {
		machineHeads += Style.Machine(padEnd(m, colWidth))
	}
	echo(Style.Header("  "+padEnd("PROGRAM", nameWidth+3)) + machineHeads)
	// Rows needing attention (drift, or a missing install somewhere) are
	// boxed by echoRows; the rest print with the same gutter.
	var rows []TableRow
	for _, r := range report.Rows {
		// Same marker language as status: ok / drift / missing-somewhere; a
		// program no compared machine has is a dim non-event.
		everywhereUnknown := true
		for cell := range r.PerMachine.Values() {
			everywhereUnknown = everywhereUnknown && cell.Kind == diff.Unknown
		}
		var marker string
		switch {
		case r.Incomplete():
			marker = Style.Error("✘")
		case r.Drift():
			marker = Style.Warn("!")
		case everywhereUnknown:
			marker = Style.Dim("·")
		default:
			marker = Style.Ok("✔")
		}
		cells := ""
		for _, m := range report.Machines {
			cell := r.PerMachine.Value(m)
			switch cell.Kind {
			case diff.Installed:
				// On a drifting row every version is a suspect — highlight them all.
				v := "ok"
				if cell.Version != nil {
					v = *cell.Version
				}
				v = padEnd(v, colWidth)
				if r.Drift() {
					v = Style.Warn(v)
				}
				cells += v
			case diff.Missing:
				cells += Style.Error(padEnd("missing", colWidth))
			default:
				cells += Style.Dim(padEnd("-", colWidth))
			}
		}
		line := marker + "  " + padEnd(r.Program, nameWidth) + cells
		if flags := flagsOf(r); flags != "" {
			line += Style.Warn("  !" + flags)
		}
		var severity *bool
		if r.Incomplete() {
			severity = severe
		} else if r.Drift() {
			severity = attention
		}
		rows = append(rows, TableRow{[]string{line}, severity})
	}
	echoRows(rows)

	printDiffConfigs(report, nameWidth, colWidth)

	driftCount, missingCount, configCount := 0, 0, 0
	for _, r := range report.Rows {
		if r.Drift() {
			driftCount++
		}
		if r.Incomplete() {
			missingCount++
		}
	}
	for _, c := range report.Configs {
		if c.Drifted() {
			configCount++
		}
	}
	if driftCount > 0 || missingCount > 0 || configCount > 0 {
		echo("")
		tail := "."
		if len(report.Configs) > 0 {
			tail = ", " + strconv.Itoa(configCount) + " config(s) drifted."
		}
		echo(" " + Style.Warn("!") + "  " + strconv.Itoa(driftCount) + " program(s) with version drift, " +
			strconv.Itoa(missingCount) + " with missing installs" + tail)
		return exitWith(1)
	}
	echo("")
	echo(" " + Style.Ok("✔") + "  all " + strconv.Itoa(len(report.Machines)) + " machine(s) in sync")
	return nil
}

// A unit a machine doesn't report is "-": chezmoi ignores it there, or that
// machine's state predates configs.
func printDiffConfigs(report diff.DiffReport, nameWidth, colWidth int) {
	if len(report.Configs) == 0 {
		return
	}
	echo("")
	machineHeads := ""
	for _, m := range report.Machines {
		machineHeads += Style.Machine(padEnd(m, colWidth))
	}
	echo(Style.Header("  "+padEnd("CONFIG", nameWidth+3)) + machineHeads)
	var rows []TableRow
	for _, c := range report.Configs {
		marker := Style.Ok("✔")
		if c.Drifted() {
			marker = Style.Warn("✘")
		}
		cells := ""
		for _, m := range report.Machines {
			cell := c.PerMachine.Value(m)
			switch cell.Kind {
			case diff.ConfigApplied:
				cells += padEnd("applied", colWidth)
			case diff.ConfigDrifted:
				cells += Style.Warn(padEnd(driftedLabel(cell), colWidth))
			default:
				cells += Style.Dim(padEnd("-", colWidth))
			}
		}
		var severity *bool
		if c.Drifted() {
			severity = attention
		}
		rows = append(rows, TableRow{[]string{marker + "  " + padEnd(c.Unit, nameWidth) + cells}, severity})
	}
	echoRows(rows)
}
