// Package fakeexec is a scripted exec.ProcessRunner for tests.
package fakeexec

import (
	"sync"

	"github.com/josemiguelo/loadout/internal/core/exec"
)

// Runner answers registered command lines; an unregistered one fails with
// exit 127, like a missing binary would. Engines run checks concurrently,
// so it is safe for concurrent use.
type Runner struct {
	mu        sync.Mutex
	responses map[string]exec.ExecResult
	received  []exec.ShellCommand
}

// New is a runner that knows no commands yet.
func New() *Runner { return &Runner{responses: map[string]exec.ExecResult{}} }

// Option shapes a registered response.
type Option func(*exec.ExecResult)

// Exit sets the exit code (default 0).
func Exit(code int) Option { return func(r *exec.ExecResult) { r.ExitCode = code } }

// Stdout sets what the command prints.
func Stdout(s string) Option { return func(r *exec.ExecResult) { r.Stdout = s } }

// Stderr sets what the command prints on stderr.
func Stderr(s string) Option { return func(r *exec.ExecResult) { r.Stderr = s } }

// OnCommand registers line's response: exit 0 and no output unless options say otherwise.
func (f *Runner) OnCommand(line string, options ...Option) *Runner {
	var result exec.ExecResult
	for _, o := range options {
		o(&result)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.responses[line] = result
	return f
}

// Received is every command with its cwd and env, in execution order.
func (f *Runner) Received() []exec.ShellCommand {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]exec.ShellCommand(nil), f.received...)
}

// Executed is every command line, in execution order.
func (f *Runner) Executed() []string {
	var lines []string
	for _, c := range f.Received() {
		lines = append(lines, c.Line)
	}
	return lines
}

// Capture implements exec.ProcessRunner.
func (f *Runner) Capture(command exec.ShellCommand) (exec.ExecResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.received = append(f.received, command)
	if r, ok := f.responses[command.Line]; ok {
		return r, nil
	}
	return exec.ExecResult{ExitCode: 127, Stderr: "sh: command not found"}, nil
}

// Inherit implements exec.ProcessRunner.
func (f *Runner) Inherit(command exec.ShellCommand) (int, error) {
	r, err := f.Capture(command)
	return r.ExitCode, err
}
