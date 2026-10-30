package cli

import (
	"strings"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/model"
)

// The program half of converging, shared by `install` and
// `setup-new-machine` — observe, plan, show, confirm, execute. The two
// commands differ in what they target and in what ELSE they do (scripts are
// setup's alone), never in this sequence; keeping it in one place is what
// stops one of them quietly growing a behavior the other lacks.

// programPlan is what converging the programs would do, and the engine that does it.
type programPlan struct {
	engine *engine.InstallEngine
	items  []engine.PlanItem
}

func (p programPlan) installs() []engine.InstallItem { return engine.Installs(p.items) }

// planPrograms re-asks every check this machine's mapping covers (plus any
// explicitly requested program), then resolves what would happen. Empty
// requested = the machine's whole mapped membership.
func planPrograms(a *app.AppContext, manifest model.Manifest, system coremodel.SystemInfo, requested []string) (programPlan, error) {
	frame, err := a.Frame(system)
	if err != nil {
		return programPlan{}, err
	}
	checker := engine.NewVersionChecker(a.Runner, frame)
	installs := engine.NewInstallEngine(a.Runner, checker, frame)
	mapped := manifest.Machines.Value(system.Machine).PM
	var checks model.Map[*model.VersionCheck]
	for _, name := range manifest.Programs.Keys() {
		key, isMapped := mapped.Get(name)
		if !isMapped && !contains(requested, name) {
			continue
		}
		var keyPtr *string
		if isMapped {
			keyPtr = &key
		}
		checks.Set(name, manifest.CheckFor(name, keyPtr))
	}
	current, err := spinning("checking current state…", func() (model.Map[coremodel.ProgramState], error) {
		return checker.CheckAll(checks)
	})
	if err != nil {
		return programPlan{}, err
	}
	items, err := installs.Plan(manifest, system.Machine, requested, current, a.BinaryAvailable)
	if err != nil {
		return programPlan{}, err
	}
	return programPlan{installs, items}, nil
}

// extraRow is a step a command adds to the plan beyond programs (setup's scripts).
type extraRow struct{ name, label string }

// echoPlan prints the plan. extraRows count toward the column width, so
// the table stays one table.
func echoPlan(plan programPlan, machine string, extraRows []extraRow) {
	nameWidth := 1
	for _, item := range plan.items {
		nameWidth = max(nameWidth, runeLen(item.ProgramName()))
	}
	for _, row := range extraRows {
		nameWidth = max(nameWidth, runeLen(row.name))
	}
	echo("")
	echo(Style.Header("Plan for ") + Style.Machine(machine) + Style.Header(":"))
	for _, item := range plan.items {
		switch it := item.(type) {
		case engine.InstallItem:
			echo("  " + Style.Warn("+") + " " + padEnd(it.Program, nameWidth) + "  " + Style.Dim("["+it.InstallKey+"]") + " " + it.Command)
		case engine.InstalledItem:
			version := "installed"
			if it.Version != nil {
				version = *it.Version
			}
			echo("  " + Style.Ok("=") + " " + padEnd(it.Program, nameWidth) + "  " + Style.Dim(version))
		}
	}
	for _, row := range extraRows {
		echo("  " + Style.Accent("~") + " " + padEnd(row.name, nameWidth) + "  " + Style.Dim(row.label))
	}
}

// confirmOrAbort is the [y/N] gate. `--yes` skips it; anything but y/yes
// aborts with exit 1.
func confirmOrAbort(yes bool) error {
	if yes {
		return nil
	}
	echoNoNewline("\nProceed? [y/N] ")
	answer, _ := readLine()
	answer = strings.ToLower(answer)
	if answer != "y" && answer != "yes" {
		echo("Aborted.")
		return exitWith(1)
	}
	return nil
}

// askForSudoUpfront asks for sudo's password once, now, before the first
// step, when needed (a step of the run needs it), instead of in the middle
// of the run whenever sudo's credentials have run out. Then it keeps them
// fresh until loadout exits (engine.SudoKeepalive): a step an hour in finds
// them as valid as the first. Nothing is asked when they're still valid.
// Refusing stops the run before anything ran.
func askForSudoUpfront(runner exec.ProcessRunner, needed bool) error {
	if !needed {
		return nil
	}
	valid, err := engine.SudoValid(runner)
	if err != nil {
		return err
	}
	if !valid {
		echo("\n" + Style.Accent("A step needs your sudo password."))
		code, err := runner.Inherit(exec.Line("sudo -v", ""))
		if err != nil {
			return err
		}
		if code != 0 {
			echoErr("Aborted: the steps that need sudo can't run without it.")
			return exitWith(1)
		}
	}
	return engine.StartSudoKeepalive(runner)
}

// installPrograms runs the plan, announcing each install as it starts.
func installPrograms(plan programPlan, manifest model.Manifest) ([]engine.InstallOutcome, error) {
	return plan.engine.Execute(manifest, plan.items, func(item engine.InstallItem) {
		echo("\n" + Style.Accent("==> installing "+item.Program))
	}, func(item engine.InstallItem, dependency string) {
		echo("\n" + Style.Accent("==> skipping "+item.Program) + Style.Dim(" (needs "+dependency+", which didn't install)"))
	})
}

// installFailures is outcomes' failed installs and, apart, the skipped ones as
// "name (needs dependency)".
func installFailures(outcomes []engine.InstallOutcome) (failed, skipped []string) {
	for _, o := range outcomes {
		switch {
		case o.SkippedFor != "":
			skipped = append(skipped, o.Program+" (needs "+o.SkippedFor+")")
		case !o.Success():
			failed = append(failed, o.Program)
		}
	}
	return failed, skipped
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func runeLen(s string) int { return len([]rune(s)) }
