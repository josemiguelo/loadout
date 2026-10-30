package cli

import (
	"strconv"
	"strings"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/spf13/cobra"
)

// newInstallCmd is the targeted installer: named programs (or --all, this
// machine's whole mapped membership), dependencies first. Scripts are
// `run`'s job; programs *and* scripts together are `setup-new-machine`'s.
func newInstallCmd() *cobra.Command {
	var all, dryRun, yes bool
	cmd := subcommand("install", commandHelp(
		"Install the named programs on this machine, dependencies first.",
		"<programs...>  programs from the manifest (+ depends-on)",
		"--all          every program this machine maps, instead of names",
		"--dry-run      print the plan, execute nothing",
		"--yes          skip the confirmation",
	), []argSpec{{name: "programs", help: "Programs to install", optional: true, multiple: true}},
		func(cmd *cobra.Command, args []string) error { return runInstall(args, all, dryRun, yes) })
	boolFlag(cmd, cmd.Flags(), &all, "all", "", "Install every program mapped for this machine (same membership as setup-new-machine)")
	boolFlag(cmd, cmd.Flags(), &dryRun, "dry-run", "", "Show what would run without doing it")
	boolFlag(cmd, cmd.Flags(), &yes, "yes", "y", "Don't ask for confirmation")
	return cmd
}

func runInstall(names []string, all, dryRun, yes bool) error {
	a := appCtx
	manifest, err := a.LoadManifest()
	if err != nil {
		return err
	}
	system := a.DetectSystem()
	if all && len(names) > 0 {
		return usageErr("Give program names or --all, not both")
	}
	if !all && len(names) == 0 {
		return usageErr("Give at least one program, or --all")
	}
	var unknown []string
	for _, name := range names {
		if !manifest.Programs.Has(name) {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		return usageErr("Unknown programs: " + strings.Join(unknown, ", "))
	}

	plan, err := planPrograms(a, manifest, system, names)
	if err != nil {
		return err
	}
	echoPlan(plan, system.Machine, nil)

	installs := plan.installs()
	if len(installs) == 0 {
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
	for _, item := range installs {
		needsSudo = needsSudo || item.Sudo
	}
	if err := askForSudoUpfront(a.Runner, needsSudo); err != nil {
		return err
	}

	outcomes, err := installPrograms(plan, manifest)
	if err != nil {
		return err
	}

	echo("")
	if err := spin("updating state…", func() error {
		_, err := a.RefreshAndWriteState(manifest, system, model.Map[coremodel.ScriptState]{})
		return err
	}); err != nil {
		return err
	}

	failed, skipped := installFailures(outcomes)
	echo(" " + Style.Ok("✔") + "  " + strconv.Itoa(len(outcomes)-len(failed)-len(skipped)) + "/" + strconv.Itoa(len(outcomes)) + " programs installed")
	if len(failed) > 0 {
		echo(" " + Style.Error("✘") + "  failed installs: " + strings.Join(failed, ", "))
	}
	if len(skipped) > 0 {
		echo(" " + Style.Error("✘") + "  skipped installs: " + strings.Join(skipped, ", "))
	}
	if len(failed) > 0 || len(skipped) > 0 {
		return exitWith(1)
	}
	return nil
}
