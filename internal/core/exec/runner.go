package exec

import (
	"bytes"
	"errors"
	"fmt"
	"maps"
	"os"
	osexec "os/exec"
	"slices"
	"syscall"
	"time"

	"github.com/josemiguelo/loadout/internal/core/platform"
)

// killed is the exit code reported for a child killed by a signal, which has none.
const killed = -1

// ShellRunner is the real ProcessRunner: `sh -c <line>`.
type ShellRunner struct{}

// NewShellRunner is the runner the binary uses.
func NewShellRunner() *ShellRunner { return &ShellRunner{} }

func command(c ShellCommand) *osexec.Cmd {
	cmd := osexec.Command("sh", "-c", c.Line)
	cmd.Dir = c.Cwd
	if len(c.Env) > 0 {
		env := os.Environ()
		for _, k := range slices.Sorted(maps.Keys(c.Env)) {
			env = append(env, k+"="+c.Env[k])
		}
		cmd.Env = env
	}
	return cmd
}

// Capture implements ProcessRunner. Stdin is empty: a check never waits on the keyboard.
func (*ShellRunner) Capture(c ShellCommand) (ExecResult, error) {
	cmd := command(c)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	exit, err := exitOf(cmd, err)
	if err != nil {
		// sh never started (its cwd is gone): a failure, not a crash.
		return ExecResult{ExitCode: killed, Stderr: err.Error()}, nil
	}
	return ExecResult{exit, stdout.String(), stderr.String()}, stopIfInterrupted(cmd)
}

// Inherit implements ProcessRunner.
func (*ShellRunner) Inherit(c ShellCommand) (int, error) {
	cmd := command(c)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := cmd.Run()
	exit, err := exitOf(cmd, err)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sh: %v\n", err)
		return killed, nil
	}
	return exit, stopIfInterrupted(cmd)
}

// exitOf is the child's exit code: a child killed by a signal (Ctrl-C, the
// OOM killer) has none and reports killed. The error is a child that never ran.
func exitOf(cmd *osexec.Cmd, err error) (int, error) {
	var exitErr *osexec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		return killed, err
	}
	return cmd.ProcessState.ExitCode(), nil
}

// stopIfInterrupted: after a Ctrl-C in a home-screen run's child loadout,
// stop the command too, not just its child process, so it doesn't go on to
// its next step. Elsewhere Ctrl-C ends loadout itself (see platform.TrapInterrupts).
func stopIfInterrupted(cmd *osexec.Cmd) error {
	interrupted := false
	if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() && status.Signal() == syscall.SIGINT {
		// The child died of the Ctrl-C loadout got too; the runtime may not
		// have handed loadout's copy over yet.
		interrupted = platform.TakeInterruptWithin(100 * time.Millisecond)
	} else {
		interrupted = platform.TakeInterrupt()
	}
	if interrupted {
		return &InterruptedByUser{}
	}
	return nil
}
