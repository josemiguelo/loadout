package engine

import (
	"regexp"

	"github.com/josemiguelo/loadout/internal/core/exec"
)

// A step needs sudo's password when its command visibly runs sudo, or when
// it declares `needs_sudo` because it calls sudo from inside (`omarchy pkg
// add`, a `file:` script). Declared, never guessed: nothing reads a script
// to find sudo in it. A run whose plan holds such a step asks for the
// password once, before the first step (the CLI's askForSudoUpfront).
var sudo = regexp.MustCompile(`(^|[^-\w])sudo\b`)

// CommandNeedsSudo says whether command itself invokes sudo (not "pseudo-tty", not "sudoku").
func CommandNeedsSudo(command string) bool { return sudo.MatchString(command) }

// SudoKeepalive keeps sudo's credentials fresh until loadout exits: a shell
// loop in the background, not a goroutine, running `sudo -n -v` every 50s
// while loadout's process ($PPID of the `sh -c` that starts it) lives. It
// looks every second, so it ends within one of loadout, however loadout
// ends. It shares loadout's terminal, the one sudo keys its credentials to.
const SudoKeepalive = "( while :; do i=0; while [ $i -lt 50 ]; do kill -0 $PPID 2>/dev/null || exit 0; sleep 1; i=$((i + 1)); done; " +
	"sudo -n -v 2>/dev/null || exit 0; done ) </dev/null >/dev/null 2>&1 &"

// SudoValid says whether sudo's credentials are valid now, so asking would ask nothing.
func SudoValid(runner exec.ProcessRunner) (bool, error) {
	r, err := runner.Capture(exec.Line("sudo -n true", ""))
	return r.Success(), err
}

// StartSudoKeepalive starts the SudoKeepalive loop.
func StartSudoKeepalive(runner exec.ProcessRunner) error {
	_, err := runner.Capture(exec.Line(SudoKeepalive, ""))
	return err
}
