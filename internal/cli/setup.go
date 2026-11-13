package cli

import (
	"slices"
	"strconv"
	"strings"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/spf13/cobra"
)

func newSetupCmd() *cobra.Command {
	var dryRun, yes, skipScripts, skipLater bool
	cmd := subcommand("setup-new-machine", commandHelp(
		"Set up this machine: install every missing program, then run its setup scripts; what's marked later comes last.",
		"--dry-run       print the plan, execute nothing",
		"--yes           skip the confirmation",
		"--skip-scripts  programs only",
		"--skip-later    stop before the programs and scripts marked later",
	), nil, func(cmd *cobra.Command, args []string) error { return runSetup(dryRun, yes, skipScripts, skipLater) })
	boolFlag(cmd, cmd.Flags(), &dryRun, "dry-run", "", "Show what would run without doing it")
	boolFlag(cmd, cmd.Flags(), &yes, "yes", "y", "Don't ask for confirmation")
	boolFlag(cmd, cmd.Flags(), &skipScripts, "skip-scripts", "", "Don't run setup scripts")
	boolFlag(cmd, cmd.Flags(), &skipLater, "skip-later", "", "Don't install or run what's marked later")
	return cmd
}

// runSetup converges in two phases: core (programs, then scripts), then
// later (the programs and scripts marked `later`, programs then scripts),
// so a slow, optional step never holds up the rest. Compile refuses a core
// step that waits on a later one, so the order holds.
func runSetup(dryRun, yes, skipScripts, skipLater bool) error {
	a := appCtx
	manifest, err := a.LoadManifest()
	if err != nil {
		return err
	}
	if err := ensureBun(a, manifest); err != nil {
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
	var coreScripts, laterScripts []string
	if !skipScripts {
		for _, name := range assemble.ScriptOrder(manifest, enabled.Keys()) {
			step := manifest.Scripts.Value(name)
			if !enabled.Has(name) || !step.RunsIn("setup") {
				continue
			}
			if step.Later != "" {
				laterScripts = append(laterScripts, name)
			} else {
				coreScripts = append(coreScripts, name)
			}
		}
	}
	core, later := programPlan{engine: plan.engine}, programPlan{engine: plan.engine}
	for _, item := range plan.items {
		if manifest.Programs.Value(item.ProgramName()).Later != "" {
			later.items = append(later.items, item)
		} else {
			core.items = append(core.items, item)
		}
	}
	laterTitle := "Later, after everything above:"
	if skipLater {
		laterTitle = "Later, skipped (--skip-later):"
	}
	echoSections(system.Machine, []planSection{
		{items: core.items, extra: scriptRows(coreScripts)},
		{title: laterTitle, items: later.items, extra: scriptRows(laterScripts)},
	})
	if skipLater {
		later.items, laterScripts = nil, nil
	}

	if len(core.installs()) == 0 && len(later.installs()) == 0 && len(coreScripts) == 0 && len(laterScripts) == 0 {
		echo("\nNothing to do.")
		return nil
	}
	if dryRun {
		return nil
	}
	if err := confirmOrAbort(yes); err != nil {
		return err
	}
	// One password for both phases, kept fresh until the later phase ends.
	needsSudo := false
	for _, item := range append(core.installs(), later.installs()...) {
		needsSudo = needsSudo || item.Sudo
	}
	for _, name := range append(slices.Clone(coreScripts), laterScripts...) {
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

	var results model.Map[coremodel.ScriptState]
	runScripts := func(names []string) error {
		for _, name := range names {
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
		return nil
	}

	outcomes, err := installPrograms(core, manifest)
	if err != nil {
		return err
	}
	if err := runScripts(coreScripts); err != nil {
		return err
	}
	if len(later.installs()) > 0 || len(laterScripts) > 0 {
		echo("\n" + Style.Header("==> later: what can wait") + Style.Dim(" (the rest of the machine is set up; run this again to finish if you stop it)"))
		laterOutcomes, err := installProgramsAfter(later, manifest, outcomes)
		outcomes = append(outcomes, laterOutcomes...)
		if err != nil {
			return err
		}
		if err := runScripts(laterScripts); err != nil {
			return err
		}
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

// scriptRows is names as the plan's script rows.
func scriptRows(names []string) []extraRow {
	var rows []extraRow
	for _, name := range names {
		rows = append(rows, extraRow{name, "script"})
	}
	return rows
}

// exitText is a recorded exit code as Kotlin printed it ("null" for none).
func exitText(code *int) string {
	if code == nil {
		return "null"
	}
	return strconv.Itoa(*code)
}
