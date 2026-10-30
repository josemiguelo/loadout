package cli

import (
	"strconv"
	"strings"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/spf13/cobra"
)

func newSetupCmd() *cobra.Command {
	var dryRun, yes, skipScripts bool
	cmd := subcommand("setup-new-machine", commandHelp(
		"Set up this machine: install every missing program, then run its setup scripts.",
		"--dry-run       print the plan, execute nothing",
		"--yes           skip the confirmation",
		"--skip-scripts  programs only",
	), nil, func(cmd *cobra.Command, args []string) error { return runSetup(dryRun, yes, skipScripts) })
	boolFlag(cmd, cmd.Flags(), &dryRun, "dry-run", "", "Show what would run without doing it")
	boolFlag(cmd, cmd.Flags(), &yes, "yes", "y", "Don't ask for confirmation")
	boolFlag(cmd, cmd.Flags(), &skipScripts, "skip-scripts", "", "Don't run setup scripts")
	return cmd
}

func runSetup(dryRun, yes, skipScripts bool) error {
	a := appCtx
	manifest, err := a.LoadManifest()
	if err != nil {
		return err
	}
	system := a.DetectSystem()

	plan, err := planPrograms(a, manifest, system, nil)
	if err != nil {
		return err
	}
	frame, err := a.Frame(system)
	if err != nil {
		return err
	}
	scripts := engine.NewScriptRunner(a.Runner, frame)
	enabled := manifest.Machines.Value(system.Machine).ScriptArgs()
	var scriptNames []string
	if !skipScripts {
		for _, name := range assemble.ScriptOrder(manifest, enabled.Keys()) {
			if enabled.Has(name) && manifest.Scripts.Value(name).RunsIn("setup") {
				scriptNames = append(scriptNames, name)
			}
		}
	}
	var extra []extraRow
	for _, name := range scriptNames {
		extra = append(extra, extraRow{name, "script"})
	}
	echoPlan(plan, system.Machine, extra)

	if len(plan.installs()) == 0 && len(scriptNames) == 0 {
		echo("\nNothing to do.")
		return nil
	}
	if dryRun {
		return nil
	}
	if err := confirmOrAbort(yes); err != nil {
		return err
	}
	needsSudo := false
	for _, item := range plan.installs() {
		needsSudo = needsSudo || item.Sudo
	}
	for _, name := range scriptNames {
		if needsSudo {
			break
		}
		step, args := manifest.Scripts.Value(name), enabled.Value(name)
		if scripts.NeedsSudo(step, args) {
			pending, err := scripts.Pending(step, false, args)
			if err != nil {
				return err
			}
			needsSudo = pending
		}
	}
	if err := askForSudoUpfront(a.Runner, needsSudo); err != nil {
		return err
	}

	outcomes, err := installPrograms(plan, manifest)
	if err != nil {
		return err
	}

	var results model.Map[coremodel.ScriptState]
	for _, name := range scriptNames {
		outcome, err := scripts.Run(manifest.Scripts.Value(name), false, enabled.Value(name))
		if err != nil {
			return err
		}
		if outcome.AlreadyDone {
			echo("\n" + Style.Accent("==> script "+name+":") + " already done " + Style.Dim("(check passed)"))
			continue
		}
		echo("\n" + Style.Accent("==> ran script "+name) + " (exit " + exitText(outcome.State.ExitCode) + ")")
		results.Set(name, outcome.State)
	}

	echo("")
	if err := spin("updating state…", func() error {
		_, err := a.RefreshAndWriteState(manifest, system, results)
		return err
	}); err != nil {
		return err
	}

	var failedScripts []string
	failedInstalls, skippedInstalls := installFailures(outcomes)
	succeeded := len(outcomes) - len(failedInstalls) - len(skippedInstalls)
	for name, s := range results.All() {
		if s.Status == coremodel.Failed {
			failedScripts = append(failedScripts, name)
		}
	}
	echo(" " + Style.Ok("✔") + "  " + strconv.Itoa(succeeded) + "/" + strconv.Itoa(len(outcomes)) + " programs installed, " +
		strconv.Itoa(results.Len()) + " scripts run")
	if len(failedInstalls) > 0 {
		echo(" " + Style.Error("✘") + "  failed installs: " + strings.Join(failedInstalls, ", "))
	}
	if len(skippedInstalls) > 0 {
		echo(" " + Style.Error("✘") + "  skipped installs: " + strings.Join(skippedInstalls, ", "))
	}
	if len(failedScripts) > 0 {
		echo(" " + Style.Error("✘") + "  failed scripts: " + strings.Join(failedScripts, ", "))
	}
	if len(failedInstalls) > 0 || len(skippedInstalls) > 0 || len(failedScripts) > 0 {
		return exitWith(1)
	}
	return nil
}

// exitText is a recorded exit code as Kotlin printed it ("null" for none).
func exitText(code *int) string {
	if code == nil {
		return "null"
	}
	return strconv.Itoa(*code)
}
