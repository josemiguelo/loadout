package cli

import (
	"sort"
	"strconv"
	"strings"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/core/platform"
	"github.com/spf13/cobra"
)

func newOutdatedCmd() *cobra.Command {
	return subcommand("outdated", commandHelp(
		"Ask each program's remote source (dnf/brew/flathub/...) for newer versions — the loadout binary included.",
	), nil, func(cmd *cobra.Command, args []string) error { return runOutdated(appCtx) })
}

func runOutdated(a *app.AppContext) error {
	manifest, err := a.LoadManifest()
	if err != nil {
		return err
	}
	system := a.DetectSystem()
	store, err := a.StateStore()
	if err != nil {
		return err
	}
	observed := store.Read(system.Machine)
	if observed == nil {
		echo("error: no state for " + system.Machine + " yet — run `loadout status` first")
		return exitWith(1)
	}

	extra := ""
	if n := manifest.Outdated.Len(); n > 0 {
		extra = " and " + strconv.Itoa(n) + " extra source(s)"
	}
	report, err := spinning("asking the remotes"+extra+"…", func() (app.OutdatedReport, error) {
		return a.OutdatedReport(manifest, system, *observed, true)
	})
	if err != nil {
		return err
	}
	updates := report.Updates

	// The doctor's line per tool first: what upgrading it would mean,
	// declared or not — the program rows below are the part loadout knows
	// by name.
	if len(report.Tools) > 0 {
		toolWidth := 0
		for _, t := range report.Tools {
			toolWidth = max(toolWidth, runeLen(t.Tool))
		}
		toolWidth += 2
		for _, t := range report.Tools {
			mark := Style.Warn("↑")
			if t.Total == 0 {
				mark = Style.Ok("✔")
			}
			count := strconv.Itoa(t.Total) + " updates"
			if t.Total == 1 {
				count = "1 update"
			}
			var what string
			switch {
			case t.Total == 0:
				what = Style.Dim("up to date")
			case len(t.Declared) == 0:
				what = count + Style.Dim(" · none in your loadout")
			default:
				what = count + Style.Dim(" · "+strconv.Itoa(len(t.Declared))+" in your loadout")
			}
			how := ""
			if t.Command != nil {
				how = Style.Dim("  loadout upgrade " + t.Installers[0] + "  →  " + *t.Command)
			}
			echo(" " + mark + "  " + padEnd(t.Tool, toolWidth) + what + how)
		}
		echo("")
	}

	// Same visual language as status: markers + color as signal only.
	if len(updates) == 0 && len(report.Errors) == 0 {
		echo(" " + Style.Ok("✔") + "  everything is up to date")
	} else if len(updates) > 0 {
		// A column is as wide as its heading or its longest value, so the
		// heading never runs into the next one.
		nameWidth, currentWidth, candidateWidth, sourceWidth := 7, 7, 9, 6
		for _, u := range updates {
			nameWidth = max(nameWidth, runeLen(u.Name))
			currentWidth = max(currentWidth, runeLen(u.Current))
			candidateWidth = max(candidateWidth, runeLen(u.Candidate))
			sourceWidth = max(sourceWidth, runeLen(u.Source))
		}
		nameWidth, currentWidth, candidateWidth, sourceWidth = nameWidth+2, currentWidth+2, candidateWidth+2, sourceWidth+2
		echo(Style.Header(" " + padEnd("PROGRAM", nameWidth+3) + padEnd("CURRENT", currentWidth+3) + padEnd("CANDIDATE", candidateWidth) + "SOURCE"))
		for _, u := range updates {
			annotation := ""
			if u.Note != "" {
				annotation += Style.Dim("  " + u.Note)
			}
			if u.Link != nil {
				annotation += Style.Dim("  " + *u.Link)
			}
			echo(" " + Style.Warn("↑") + "  " + padEnd(u.Name, nameWidth) + padEnd(u.Current, currentWidth) +
				Style.Dim("-> ") + Style.Warn(padEnd(u.Candidate, candidateWidth)) + Style.Dim(padEnd("["+u.Source+"]", sourceWidth)) + annotation)
		}
		echo("")
		echo(" " + Style.Warn("↑") + "  " + strconv.Itoa(len(updates)) + " update(s) available" +
			// Converge adds what's MISSING; a newer version of something
			// already installed is the package manager's business.
			Style.Dim(" — neither `setup-new-machine` nor `install --all` upgrades them; both only install what's MISSING. "+
				"Upgrade with the package manager, or `loadout upgrade <program>` for one that declares its own upgrade; then `loadout status`"))
	}
	// A broken oracle is a different severity sitting under a long list of
	// ordinary updates — box it, the one place in this screen where a row
	// contrasts with its neighbours. The message carries a stderr tail, so
	// clamp it to the terminal: a box that wraps is worse than a plain line.
	if len(report.Errors) > 0 {
		tail := " — its results are missing this run"
		cols := platform.TerminalColumns()
		if cols == 0 {
			cols = 100
		}
		budget := cols - 6 - runeLen(tail)
		var rows []TableRow
		for _, e := range report.Errors {
			head := "  outdated source [" + e.Label + "] failed: " + e.Reason
			if runeLen(head) > budget {
				head = string([]rune(head)[:max(budget-1, 0)]) + "…"
			}
			rows = append(rows, TableRow{[]string{Style.Error("✖") + head + Style.Dim(tail)}, severe})
		}
		echoRows(rows)
	}
	if len(report.Unchecked) > 0 {
		unchecked := append([]string{}, report.Unchecked...)
		sort.Strings(unchecked)
		echo(Style.Dim(" ·  " + strconv.Itoa(len(unchecked)) + " installed programs have no outdated oracle: " + strings.Join(unchecked, ", ")))
	}
	return nil
}
