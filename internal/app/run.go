package app

import (
	"os"
	osexec "os/exec"
	"strings"

	"github.com/josemiguelo/loadout/internal/core/platform"
)

// RunCommand is the child loadout running closed's command in the home
// screen's run panel (a pseudo-terminal it reads through internal/tui/term):
// this same binary, with the global options as given (SelfArgv), from the
// current directory. Its env is this process's plus LOADOUT_HANDOFF=1 (it
// traps Ctrl-C and exits 130, read as "interrupted") and PAGER=cat,
// GIT_PAGER=cat: a pager would work in the panel, but its screen would leave
// nothing in the run's log, which is what stays once the run ends. The
// terminal sets TERM. ok false (nil, nil) means there is nothing to run.
func (a *AppContext) RunCommand(closed Closed) (*osexec.Cmd, error) {
	name, args, ok := closed.Command()
	if !ok {
		return nil, nil
	}
	self := platform.SelfExecutable()
	if self == "" {
		return nil, &HandoffException{"can't find loadout's own binary to run the command"}
	}
	return a.childCommand(self, name, args), nil
}

func (a *AppContext) childCommand(self, name string, args []string) *osexec.Cmd {
	argv := a.SelfArgv(self, append([]string{name}, args...)...)
	cmd := osexec.Command(argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "LOADOUT_HANDOFF=1", "PAGER=cat", "GIT_PAGER=cat")
	return cmd
}

// SelfArgv is the argv that runs this same loadout on this repo as this
// machine (the global options as given), then args: a run's child, or the
// sync an upgrade starts. self is the binary to run.
func (a *AppContext) SelfArgv(self string, args ...string) []string {
	argv := []string{self, "--repo", a.RepoRoot}
	if a.MachineOverride != "" {
		argv = append(argv, "--machine", a.MachineOverride)
	}
	if a.Verbose {
		argv = append(argv, "-v")
	}
	return append(argv, args...)
}

// HandoffException is a run that couldn't start.
type HandoffException struct{ Message string }

func (e *HandoffException) Error() string { return e.Message }

// Refusal marks it a refusal.
func (*HandoffException) Refusal() {}

// ShQuote is s single-quoted for sh.
func ShQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
