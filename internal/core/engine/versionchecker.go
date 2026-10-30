package engine

import (
	"fmt"
	"sync"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/model"
)

// parallelism bounds the concurrent read-only checks.
const parallelism = 8

// VersionChecker runs version checks.
type VersionChecker struct {
	runner exec.ProcessRunner
	// frame is where manifest commands run and what they get (contract 5).
	frame exec.CommandFrame
}

// NewVersionChecker is a checker running commands in frame.
func NewVersionChecker(runner exec.ProcessRunner, frame exec.CommandFrame) *VersionChecker {
	return &VersionChecker{runner, frame}
}

// Check is versionCheck's verdict:
//   - no version check declared -> Unknown
//   - a check that asks THROUGH a tool (it has a Probe) and dies with the
//     shell's own "command not found" (127; 126 = not executable) ->
//     Unknown, with the reason: the tool never answered, so "missing" would
//     be a confident lie — `brew` off PATH once reported every brew program
//     missing. A check with no probe IS the program (`rg --version`), so
//     there 127 means what it says.
//   - command exits non-zero otherwise (the tool said no) -> Missing, with
//     the tool's last stderr line when it said anything
//   - command succeeds and regex matches -> Installed with the captured version
//   - command succeeds but regex does not match -> Installed without a version
func (c *VersionChecker) Check(versionCheck *model.VersionCheck) (coremodel.ProgramState, error) {
	if versionCheck == nil {
		return coremodel.ProgramState{Status: coremodel.Unknown}, nil
	}
	result, err := c.runner.Capture(c.frame.Command(model.ShellLine(versionCheck.Command, versionCheck.Path), versionCheck.Origin))
	if err != nil {
		return coremodel.ProgramState{}, err
	}
	said := lastNonEmptyTrimmed(result.Stderr)
	if versionCheck.Probe != nil && (result.ExitCode == 127 || result.ExitCode == 126) {
		// The shell already names what wasn't there ("sh: brew: command not
		// found"); that is the whole explanation.
		reason := fmt.Sprintf("the check could not run (exit %d)", result.ExitCode)
		if said != nil {
			reason = *said
		}
		return coremodel.ProgramState{Status: coremodel.Unknown, Reason: &reason}, nil
	}
	if !result.Success() {
		return coremodel.ProgramState{Status: coremodel.Missing, Reason: said}, nil
	}
	output := ifBlank(result.Stdout, result.Stderr)
	// A yes/no check (no regex) records presence alone.
	var version *string
	if versionCheck.Regex != nil {
		version = group1(*versionCheck.Regex, output)
	}
	return coremodel.ProgramState{Status: coremodel.Installed, Version: version}, nil
}

// CheckAll checks all checks (program name -> version check) concurrently
// with bounded parallelism, in checks' order.
func (c *VersionChecker) CheckAll(checks model.Map[*model.VersionCheck]) (model.Map[coremodel.ProgramState], error) {
	names := checks.Keys()
	states := make([]coremodel.ProgramState, len(names))
	errs := make([]error, len(names))
	forEach(len(names), parallelism, func(i int) {
		states[i], errs[i] = c.Check(checks.Value(names[i]))
	})
	var out model.Map[coremodel.ProgramState]
	for i, name := range names {
		if errs[i] != nil {
			return model.Map[coremodel.ProgramState]{}, errs[i]
		}
		out.Set(name, states[i])
	}
	return out, nil
}

// forEach runs f(0..n-1) concurrently, at most limit at a time (0 = no limit), and waits.
func forEach(n, limit int, f func(i int)) {
	if limit <= 0 {
		limit = n
	}
	var wg sync.WaitGroup
	permits := make(chan struct{}, max(limit, 1))
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			permits <- struct{}{}
			defer func() { <-permits }()
			f(i)
		}()
	}
	wg.Wait()
}

// firstError is the first non-nil of errs.
func firstError(errs []error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}
