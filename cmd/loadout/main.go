// Command loadout sets up a machine from a shared config repo and tracks
// installed program versions.
package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/josemiguelo/loadout/internal/cli"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/platform"
	"github.com/josemiguelo/loadout/internal/theme"
	// The home screen registers itself (app.NewScreen) from its package's init.
	_ "github.com/josemiguelo/loadout/internal/tui"
)

// interrupted is the exit a shell reports for a command stopped by Ctrl-C (128 + SIGINT).
const interrupted = 130

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	// Checked first, before anything styles output: an unreadable value is
	// a refusal, never a silent dark default.
	env, _ := platform.EnvVar("LOADOUT_THEME")
	if _, _, err := theme.ForcedDark(env); err != nil {
		fmt.Println("error: " + err.Error())
		return 1
	}
	// A home-screen run's child (see app.RunCommand) takes Ctrl-C here, on
	// the run panel's terminal it shares with its command: it stops and
	// exits 130, which the screen reads as "interrupted".
	if v, _ := platform.EnvVar("LOADOUT_HANDOFF"); v == "1" {
		platform.TrapInterrupts(true)
	}
	return report(cli.Execute(args))
}

// report is err as loadout's exit (contract 9): every refusal and OS error
// is one clean `error: <message>` line, never a stack trace.
func report(err error) int {
	var usage *cli.UsageError
	var exit *cli.ExitError
	var stopped *exec.InterruptedByUser
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exit):
		return exit.Code
	case errors.As(err, &stopped):
		return interrupted
	case errors.As(err, &usage):
		fmt.Fprintln(os.Stderr, usage.Render())
		return 1
	}
	fmt.Println("error: " + err.Error())
	return 1
}
