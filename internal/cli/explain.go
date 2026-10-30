package cli

import (
	"errors"
	"sort"
	"strings"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/spf13/cobra"
)

func newExplainCmd() *cobra.Command {
	return subcommand("explain", commandHelp(
		"Explain programs, scripts or configs: the fully expanded definition exactly as the engine sees it.",
		"[names...]  programs, scripts or configs (default: every program and script)",
	), []argSpec{{name: "names", help: "Program, script or config names (default: every program and script)", optional: true, multiple: true}},
		func(cmd *cobra.Command, args []string) error { return runExplain(appCtx, args) })
}

// row is one `label  value` line of explain's output.
type row struct{ label, value string }

func echoLabelled(rows []row) {
	width := 0
	for _, r := range rows {
		width = max(width, runeLen(r.label))
	}
	for _, r := range rows {
		echo("  " + Style.Dim(padEnd(r.label, width)) + "  " + r.value)
	}
}

func runExplain(a *app.AppContext, names []string) error {
	manifest, err := a.LoadManifest()
	if err != nil {
		return err
	}
	layout, err := a.Layout()
	if err != nil {
		return err
	}
	system := a.DetectSystem()
	if _, err := a.StateStore(); err != nil {
		return err
	}
	machine, declared := manifest.Machines.Get(system.Machine)
	mapping := machine.PM

	// Everything explained starts with the machine: the profiles it extends,
	// what it installs and runs (its profiles' included), and its merged
	// data (what its chezmoi templates see).
	if len(names) == 0 {
		echo(Style.Header("machine ") + Style.Bold(system.Machine))
		if !declared {
			echo("  " + Style.Warn("! not declared in the repo — showing the data defaults"))
		}
		var rows []row
		if layout.Parent != nil {
			rows = append(rows, row{"parent", layout.Parent.Name + " (" + layout.Parent.Path + ")"})
		}
		if declared && len(machine.Extends) > 0 {
			rows = append(rows, row{"extends", strings.Join(machine.Extends, ", ")})
		}
		// What it installs, grouped by the variant each program uses.
		byVariant := map[string][]string{}
		for program, variant := range mapping.All() {
			byVariant[variant] = append(byVariant[variant], program)
		}
		variants := make([]string, 0, len(byVariant))
		for v := range byVariant {
			variants = append(variants, v)
		}
		sort.Strings(variants)
		for _, v := range variants {
			programs := byVariant[v]
			sort.Strings(programs)
			rows = append(rows, row{"install " + v, strings.Join(programs, ", ")})
		}
		if declared && len(machine.Scripts) > 0 {
			var entries []string
			for _, entry := range machine.Scripts {
				name, _ := model.ScriptEntry(entry)
				if variant, ok := machine.ScriptVariants.Get(name); ok {
					name += " (" + variant + ")"
				}
				entries = append(entries, name)
			}
			rows = append(rows, row{"run", strings.Join(entries, ", ")})
		}
		data := manifest.Data
		if declared {
			data = machine.Data
		}
		lines := model.DataLines(data, "")
		for _, line := range lines {
			rows = append(rows, row{"data." + line.Key, line.Value})
		}
		if len(lines) == 0 {
			echo("  " + Style.Dim("no data declared"))
		}
		echoLabelled(rows)
		echo("")
	}

	explained, err := a.Explain(names)
	for index, named := range explained {
		if index > 0 {
			echo("")
		}
		for j, item := range named.Items {
			if j > 0 {
				echo("")
			}
			title := Style.Header(item.Kind+" ") + Style.Bold(item.Name)
			switch {
			case item.Kind == "config":
				title += Style.Dim("  " + item.Folder)
			case item.Description != "":
				title += Style.Dim("  — " + item.Description)
			}
			echo(title)
			rows := make([]row, len(item.Rows))
			for i, r := range item.Rows {
				value := r.Value
				if r.Machine != "" {
					value += Style.Machine("   <- " + r.Machine)
				}
				rows[i] = row{r.Label, value}
			}
			echoLabelled(rows)
			for _, note := range item.Notes {
				echo("  " + Style.Warn(note))
			}
		}
	}
	var unknown *app.NoSuchItemError
	if errors.As(err, &unknown) {
		if len(explained) > 0 {
			echo("")
		}
		echo("error: " + unknown.Message)
		return exitWith(1)
	}
	return err
}
