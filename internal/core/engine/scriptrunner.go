package engine

import (
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/platform"
	"github.com/josemiguelo/loadout/internal/model"
)

// ScriptOutcome is what Run did: AlreadyDone (its check exited 0), or ran with State.
type ScriptOutcome struct {
	AlreadyDone bool
	State       coremodel.ScriptState
}

// ScriptRunner runs scripts and asks their checks.
type ScriptRunner struct {
	runner exec.ProcessRunner
	frame  exec.CommandFrame
}

// NewScriptRunner is a runner running scripts in frame.
func NewScriptRunner(runner exec.ProcessRunner, frame exec.CommandFrame) *ScriptRunner {
	return &ScriptRunner{runner, frame}
}

// WithArgs gives command (a check, `file:` prefix allowed) the machine's
// script arguments as positional parameters.
func WithArgs(command, args string) string {
	expanded := model.ExpandFilePrefix(command)
	if args == "" {
		return expanded
	}
	return "set -- " + args + "; " + expanded
}

// CommandFor is the shell command that executes step itself (not its check).
func CommandFor(step model.ScriptStep, args string) string {
	if step.File != nil {
		command := "sh '" + *step.File + "'"
		if args != "" {
			command += " " + args
		}
		return command
	}
	return deref(step.Run)
}

// NeedsSudo says whether running step needs sudo's password: it says so, or its command runs sudo.
func (r *ScriptRunner) NeedsSudo(step model.ScriptStep, args string) bool {
	return step.Sudo || CommandNeedsSudo(CommandFor(step, args))
}

// Pending says whether Run would execute step: its `check` doesn't pass (or
// force). Asks the check, as Run will again.
func (r *ScriptRunner) Pending(step model.ScriptStep, force bool, args string) (bool, error) {
	if force || step.Check == nil {
		return true, nil
	}
	result, err := r.runner.Capture(r.frame.Command(WithArgs(*step.Check, args), step.Origin))
	return !result.Success(), err
}

// Run runs step unless its `check` already passes (or force). args is the
// machine's argument string; it reaches both the `check` (as positional
// parameters) and a `file` script's argv. Output goes straight to the terminal.
func (r *ScriptRunner) Run(step model.ScriptStep, force bool, args string) (ScriptOutcome, error) {
	if !force && step.Check != nil {
		result, err := r.runner.Capture(r.frame.Command(WithArgs(*step.Check, args), step.Origin))
		if err != nil {
			return ScriptOutcome{}, err
		}
		if result.Success() {
			return ScriptOutcome{AlreadyDone: true}, nil
		}
	}
	// Validation guarantees exactly one of file/run is set, and that args
	// are only used with file scripts.
	exit, err := r.runner.Inherit(r.frame.Command(CommandFor(step, args), step.Origin))
	if err != nil {
		return ScriptOutcome{}, err
	}
	status := coremodel.Failed
	if exit == 0 {
		status = coremodel.Done
	}
	now := platform.NowIso()
	return ScriptOutcome{State: coremodel.ScriptState{Status: status, LastRun: &now, ExitCode: &exit}}, nil
}
