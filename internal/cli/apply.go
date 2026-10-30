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

func newApplyCmd() *cobra.Command {
	var force bool
	cmd := subcommand("apply", commandHelp(
		"Write the repo's configs to this machine (chezmoi apply), then refresh its state.",
		"<configs...>  config names as status lists them (default: all)",
		"--force       also replace files edited on this machine",
	), []argSpec{{name: "configs", help: "Config names, as status lists them", optional: true, multiple: true}},
		func(cmd *cobra.Command, args []string) error { return runApply(args, force) })
	boolFlag(cmd, cmd.Flags(), &force, "force", "", "Replace files edited on this machine")
	return cmd
}

func runApply(names []string, force bool) error {
	a := appCtx
	configs, err := a.Configs()
	if err != nil {
		return err
	}
	if configs == nil {
		return &engine.ConfigException{Message: "this repo has no configs (layout configs)"}
	}
	manifest, err := a.LoadManifest()
	if err != nil {
		return err
	}
	system := a.DetectSystem()

	units, err := configs.Units()
	if err != nil {
		return err
	}
	var unknown []string
	for _, name := range names {
		found := false
		for _, u := range units {
			found = found || u.Name == name
		}
		if !found {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		return usageErr("Unknown configs: " + strings.Join(unknown, ", ") + " (loadout status lists them)")
	}
	var targets []string
	if len(names) > 0 {
		targets = []string{}
		for _, u := range units {
			if contains(names, u.Name) {
				targets = append(targets, u.Targets...)
			}
		}
	}
	if !force {
		if err := refuseEdited(configs, targets); err != nil {
			return err
		}
	}

	apply, err := configs.ApplyCommand(targets, force)
	if err != nil {
		return err
	}
	code, err := a.Runner.Inherit(apply)
	if err != nil {
		return err
	}
	if code != 0 {
		return &engine.ConfigException{Message: "chezmoi apply failed (exit " + strconv.Itoa(code) + ")"}
	}

	after, err := spinning("updating state…", func() (coremodel.MachineState, error) {
		return a.RefreshAndWriteState(manifest, system, model.Map[coremodel.ScriptState]{})
	})
	if err != nil {
		return err
	}
	applied := names
	if len(names) == 0 {
		applied = after.Configs.Keys()
	}
	var stillDrifted []string
	for _, name := range applied {
		if c, ok := after.Configs.Get(name); ok && c.Status == coremodel.ConfigDrifted && !contains(stillDrifted, name) {
			stillDrifted = append(stillDrifted, name)
		}
	}
	sort.Strings(stillDrifted)
	what := "every config"
	if len(names) > 0 {
		what = strings.Join(names, ", ")
	}
	echo(" " + Style.Ok("✔") + "  applied " + what)
	if len(stillDrifted) > 0 {
		echo(" " + Style.Warn("!") + "  still drifted: " + strings.Join(stillDrifted, ", "))
		return exitWith(1)
	}
	return nil
}

// refuseEdited stops when a file apply would replace (targets; nil = all)
// was edited on this machine: chezmoi would ask, and only the user knows
// which version to keep.
func refuseEdited(configs *engine.ConfigEngine, targets []string) error {
	edited, err := configs.Edited(targets)
	if err != nil {
		return err
	}
	if len(edited) == 0 {
		return nil
	}
	return &engine.ConfigException{Message: strconv.Itoa(len(edited)) + " config file(s) edited on this machine: " + strings.Join(edited, ", ") + " — " +
		"keep your edits with `chezmoi re-add`, or replace them with `loadout apply --force`"}
}
