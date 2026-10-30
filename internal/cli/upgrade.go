package cli

import (
	"sort"
	"strconv"
	"strings"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/spf13/cobra"
)

// newUpgradeCmd is the one verb that moves installed programs to newer
// versions, and it moves them a whole mechanism at a time: `dnf upgrade
// -y`, not a package list. Converge installs what's MISSING and never
// upgrades (contract 15).
func newUpgradeCmd() *cobra.Command {
	var all, dryRun, yes bool
	var items []string
	cmd := subcommand("upgrade", commandHelp(
		"Upgrade everything a package manager on this machine manages — the whole mechanism, never single packages (the binary itself is `self-upgrade`).",
		"<installers...>  which mechanisms to upgrade (dnf, brew, flatpak, ...)",
		"--all            every mechanism this machine's mapping uses",
		"--item <source>/<name>  one item of an outdated.<source> (a tmux plugin, a pinned tool); repeatable",
		"--dry-run        print the commands, run nothing",
		"--yes            skip the confirmation",
	), []argSpec{{name: "installers", help: "Installers to upgrade", optional: true, multiple: true}},
		func(cmd *cobra.Command, args []string) error { return runUpgrade(args, all, items, dryRun, yes) })
	boolFlag(cmd, cmd.Flags(), &all, "all", "", "Every mechanism this machine uses")
	stringsFlag(cmd, cmd.Flags(), &items, "item", "", "One item of a custom outdated source, as <source>/<name>")
	boolFlag(cmd, cmd.Flags(), &dryRun, "dry-run", "", "Show the commands without running them")
	boolFlag(cmd, cmd.Flags(), &yes, "yes", "y", "Don't ask for confirmation")
	return cmd
}

func runUpgrade(names []string, all bool, items []string, dryRun, yes bool) error {
	a := appCtx
	if all && len(names) > 0 {
		return usageErr("Give installer names or --all, not both")
	}
	if !all && len(names) == 0 && len(items) == 0 {
		return usageErr("Give at least one installer, --all, or --item <source>/<name>")
	}
	// Items run one at a time, grouped by source, in the order given.
	var bySource model.Map[[]string]
	for _, given := range items {
		source, item, found := strings.Cut(given, "/")
		if !found || source == "" || item == "" {
			return usageErr("--item takes <source>/<name>, not '" + given + "'")
		}
		bySource.Set(source, append(bySource.Value(source), item))
	}

	manifest, err := a.LoadManifest()
	if err != nil {
		return err
	}
	system := a.DetectSystem()
	store, err := a.StateStore()
	if err != nil {
		return err
	}
	var before model.Map[coremodel.ProgramState]
	if previous := store.Read(system.Machine); previous != nil {
		before = previous.Programs
	}
	for _, w := range store.LastWarnings() {
		echoErr("warning: " + w)
	}

	for _, source := range bySource.Keys() {
		if !manifest.Outdated.Has(source) {
			return usageErr("Unknown outdated source '" + source + "' (sources are the manifest's outdated.* tables)")
		}
	}
	// A program with its own upgrade command is upgraded alone; every other
	// name is a mechanism, planned whole.
	var programs, targets []string
	if all {
		targets = engine.UpgradableInstallers(manifest, system.Machine).Keys()
	} else {
		for _, name := range names {
			if p, ok := manifest.Programs.Get(name); ok && p.Outdated != nil && p.Outdated.Upgrade != nil {
				programs = append(programs, name)
			} else {
				targets = append(targets, name)
			}
		}
	}
	if len(targets) == 0 && len(programs) == 0 && bySource.IsEmpty() {
		echo(Style.Dim("No mechanism on " + system.Machine + " declares an upgrade command."))
		return nil
	}
	plan, err := engine.PlanUpgrade(manifest, system.Machine, targets)
	if err != nil {
		return err
	}
	programSteps, err := engine.PlanProgramUpgrades(manifest, system.Machine, programs)
	if err != nil {
		return err
	}
	plan = append(plan, programSteps...)
	for source, sourceItems := range bySource.All() {
		steps, err := engine.PlanSourceItems(manifest, source, sourceItems)
		if err != nil {
			return err
		}
		plan = append(plan, steps...)
	}

	echo("")
	echo(Style.Header("Upgrade on ") + Style.Machine(system.Machine) + Style.Header(":"))
	sweep, needsSudo := false, false
	for _, step := range plan {
		echo("  " + Style.Warn("↑") + " " + Style.Dim("["+step.Label()+"]") + " " + step.Command)
		if len(step.Covers) > 0 {
			echo("      " + Style.Dim("covers "+strconv.Itoa(len(step.Covers))+" mapped program(s): "+strings.Join(step.Covers, ", ")))
		}
		sweep = sweep || step.Sweep
		needsSudo = needsSudo || step.Sudo
	}
	echo("")
	// A whole-mechanism upgrade touches everything that mechanism has, not
	// only what this repo declares. Say so before it runs.
	if sweep {
		echo(Style.Dim("  This upgrades everything each mechanism manages — including packages loadout doesn't declare."))
	}
	if dryRun {
		return nil
	}
	if err := confirmOrAbort(yes); err != nil {
		return err
	}
	if err := askForSudoUpfront(a.Runner, needsSudo); err != nil {
		return err
	}

	// Inherited stdio: sudo may prompt, dnf shows progress. A failing
	// mechanism doesn't stop the rest — they're independent.
	frame, err := a.Frame(system)
	if err != nil {
		return err
	}
	var failed []string
	for _, step := range plan {
		echo("\n" + Style.Accent("==> upgrading "+step.Label()))
		code, err := a.Runner.Inherit(frame.Command(step.Command, step.Origin))
		if err != nil {
			return err
		}
		if code != 0 {
			failed = append(failed, step.Label())
		}
	}

	echo("")
	// The transaction moved what it moved: re-observe everything, the same
	// way `status` does, and say what changed.
	after, err := spinning("re-checking every program…", func() (coremodel.MachineState, error) {
		return a.RefreshAndWriteState(manifest, system, model.Map[coremodel.ScriptState]{})
	})
	if err != nil {
		return err
	}
	var changed []string
	for name, now := range after.Programs.All() {
		was := before.Value(name).Version
		if now.Status == coremodel.Installed && now.Version != nil && (was == nil || *now.Version != *was) {
			changed = append(changed, name)
		}
	}
	sort.Strings(changed)
	echo(" " + Style.Ok("✔") + "  " + strconv.Itoa(len(changed)) + " declared program(s) changed version")
	for _, name := range changed {
		was := "?"
		if v := before.Value(name).Version; v != nil {
			was = *v
		}
		echo("      " + name + Style.Dim("  "+was+" -> ") + Style.Warn(*after.Programs.Value(name).Version))
	}
	if len(failed) > 0 {
		echo(" " + Style.Error("✘") + "  failed: " + strings.Join(failed, ", "))
		return exitWith(1)
	}
	return nil
}
