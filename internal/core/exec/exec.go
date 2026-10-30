// Package exec runs shell commands: every process loadout starts goes
// through ProcessRunner, so tests script them (fakeexec).
package exec

// ExecResult is a finished command's exit code and output.
type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

// Success says whether the command exited 0.
func (r ExecResult) Success() bool { return r.ExitCode == 0 }

// ShellCommand is one shell command line and the frame it runs in: Cwd
// ("" = the caller's) and Env, added to the inherited environment.
type ShellCommand struct {
	Line string
	Cwd  string
	Env  map[string]string
}

// Line is a plain command line run in workDir ("" = the caller's): git,
// probes, self-version. Manifest commands get theirs from a CommandFrame.
func Line(line, workDir string) ShellCommand { return ShellCommand{Line: line, Cwd: workDir} }

// ProcessRunner runs shell commands. All commands go through `sh -c`, so
// pipes, redirects and env-var references work as they would in a terminal.
// The only error is *InterruptedByUser: Ctrl-C in a home-screen run's child loadout.
type ProcessRunner interface {
	// Capture runs command capturing stdout/stderr (version checks, probes, git plumbing).
	Capture(command ShellCommand) (ExecResult, error)
	// Inherit runs command with stdio inherited from the parent terminal, so
	// interactive prompts (sudo) and progress bars work. Returns the exit code.
	Inherit(command ShellCommand) (int, error)
}

// InterruptedByUser is Ctrl-C stopping a command the home screen handed the terminal to.
type InterruptedByUser struct{}

func (*InterruptedByUser) Error() string { return "interrupted" }

// Refusal marks it a refusal.
func (*InterruptedByUser) Refusal() {}
