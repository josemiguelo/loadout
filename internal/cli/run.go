package cli

import (
	"sort"
	"strings"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/spf13/cobra"
)

func newRunCmd() *cobra.Command {
	var all, force bool
	cmd := subcommand("run", commandHelp(
		"Run the named scripts from the manifest.",
		"<scripts...>  script names (must be opted in by this machine)",
		"--all         every script this machine opts into, instead of names",
		"--force       run even when the check already passes",
	), []argSpec{{name: "scripts", help: "Script names from the manifest", optional: true, multiple: true}},
		func(cmd *cobra.Command, args []string) error { return runScripts(args, all, force) })
	boolFlag(cmd, cmd.Flags(), &all, "all", "", "Run every script this machine opts into (modes ignored, like any run)")
	boolFlag(cmd, cmd.Flags(), &force, "force", "", "Run even if the script's check passes")
	return cmd
}

func runScripts(names []string, all, force bool) error {
	a := appCtx
	manifest, err := a.LoadManifest()
	if err != nil {
		return err
	}
	system := a.DetectSystem()
	if all && len(names) > 0 {
		return usageErr("Give script names or --all, not both")
	}
	if !all && len(names) == 0 {
		return usageErr("Give at least one script, or --all")
	}
	var unknown []string
	for _, name := range names {
		if !manifest.Scripts.Has(name) {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		return usageErr("Unknown scripts: " + strings.Join(unknown, ", "))
	}
	enabled := manifest.Machines.Value(system.Machine).ScriptArgs()
	disabled := false
	for _, name := range names {
		if !enabled.Has(name) {
			echo("error: script '" + name + "' is not run on machine '" + system.Machine + "' " +
				"(run it in machine '" + system.Machine + "' or a profile it extends)")
			disabled = true
		}
	}
	if disabled {
		return exitWith(1)
	}

	// --all is the machine's opt-in list itself — membership, not modes:
	// `run` is the explicit escape hatch and ignores setup/maintain. Acting
	// on the last status's verdict is the home screen's job (its scripts row
	// pre-ticks what isn't done); here you name what you want.
	targets := names
	if all {
		targets = enabled.Keys()
	}
	if len(targets) == 0 {
		echo(Style.Dim("No scripts opted in for " + system.Machine + "."))
		return nil
	}

	frame, err := a.Frame(system)
	if err != nil {
		return err
	}
	runner := engine.NewScriptRunner(a.Runner, frame)
	var ordered []string
	for _, name := range assemble.ScriptOrder(manifest, targets) {
		if contains(targets, name) {
			ordered = append(ordered, name)
		}
	}
	needsSudo := false
	for _, name := range ordered {
		step, args := manifest.Scripts.Value(name), enabled.Value(name)
		if runner.NeedsSudo(step, args) {
			pending, err := runner.Pending(step, force, args)
			if err != nil {
				return err
			}
			if pending {
				needsSudo = true
				break
			}
		}
	}
	if err := askForSudoUpfront(a.Runner, needsSudo); err != nil {
		return err
	}
	var results model.Map[coremodel.ScriptState]
	for _, name := range ordered {
		outcome, err := runner.Run(manifest.Scripts.Value(name), force, enabled.Value(name))
		if err != nil {
			return err
		}
		if outcome.AlreadyDone {
			echo(" " + Style.Ok("✔") + "  skipped " + name + " " + Style.Dim("(already done; use --force to run anyway)"))
			continue
		}
		mark := Style.Error("✘")
		if code := outcome.State.ExitCode; code != nil && *code == 0 {
			mark = Style.Ok("✔")
		}
		echo(" " + mark + "  ran " + name + " (exit " + exitText(outcome.State.ExitCode) + ")")
		results.Set(name, outcome.State)
	}

	if !results.IsEmpty() {
		after, err := spinning("updating state…", func() (coremodel.MachineState, error) {
			return a.RefreshAndWriteState(manifest, system, results)
		})
		if err != nil {
			return err
		}
		echo(Style.Dim("State updated."))
		// The check decides, not the exit code: name scripts still pending,
		// with the first line their check printed.
		var stillNot []string
		for name, now := range after.Scripts.All() {
			if results.Has(name) && now.Status != coremodel.Done {
				stillNot = append(stillNot, name)
			}
		}
		sort.Strings(stillNot)
		if len(stillNot) > 0 {
			detail := a.LastScriptDetail()
			var named []string
			for _, name := range stillNot {
				if d, ok := detail[name]; ok {
					first, _, _ := strings.Cut(d, "\n")
					named = append(named, name+" ("+first+")")
				} else {
					named = append(named, name)
				}
			}
			echo(" " + Style.Warn("!") + "  still not done: " + strings.Join(named, ", "))
		}
	}
	for _, s := range results.All() {
		if s.Status == coremodel.Failed {
			return exitWith(1)
		}
	}
	return nil
}
