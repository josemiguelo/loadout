package exec

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/josemiguelo/loadout/internal/core/platform"
)

// The real runner: `sh -c`, the frame's cwd and env, a signal's -1.

func TestTheShellRunsTheLineInItsDirectoryWithItsVariables(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	r, err := NewShellRunner().Capture(ShellCommand{Line: `pwd -P; echo "$LOADOUT_X"; echo oops >&2; exit 3`, Cwd: dir, Env: map[string]string{"LOADOUT_X": "x"}})
	if err != nil {
		t.Fatal(err)
	}
	if r.ExitCode != 3 || r.Stdout != dir+"\nx\n" || r.Stderr != "oops\n" {
		t.Errorf("%+v", r)
	}
}

func TestAChildKilledByASignalReportsMinusOne(t *testing.T) {
	r, _ := NewShellRunner().Capture(Line("kill -TERM $$", ""))
	if r.ExitCode != -1 {
		t.Errorf("%+v", r)
	}
	exit, _ := NewShellRunner().Inherit(Line("kill -TERM $$", ""))
	if exit != -1 {
		t.Error(exit)
	}
}

func TestAMissingDirectoryIsAFailureNotACrash(t *testing.T) {
	r, err := NewShellRunner().Capture(ShellCommand{Line: "true", Cwd: "/nonexistent/loadout"})
	if err != nil || r.Success() {
		t.Errorf("%v %+v", err, r)
	}
}

func TestAFrameRunsAParentsDeclarationInTheParent(t *testing.T) {
	bare := NewCommandFrame("", nil, nil).Command("x", "programs")
	if bare.Cwd != "" || len(bare.Env) != 0 {
		t.Errorf("%+v", bare)
	}
	frame := NewCommandFrame("/child", map[string]string{"A": "child"}, &FrameParent{"/parent", map[string]string{"A": "parent"}})
	if c := frame.Command("x", "parent:"); c.Cwd != "/parent" || c.Env["A"] != "parent" || c.Env["LOADOUT_FRAGMENT_DIR"] != "/parent" {
		t.Errorf("%+v", c)
	}
	if c := frame.Command("x", "lib"); c.Cwd != "/child/lib" || c.Env["A"] != "child" {
		t.Errorf("%+v", c)
	}
}

func TestCtrlCDuringAHandOffStopsTheCommandToo(t *testing.T) {
	platform.TrapInterrupts(true)
	defer platform.TrapInterrupts(false)
	// The terminal's Ctrl-C reaches loadout and its child alike.
	_, err := NewShellRunner().Inherit(Line("kill -INT $PPID; kill -INT $$", ""))
	var interrupted *InterruptedByUser
	if !errors.As(err, &interrupted) {
		t.Errorf("%v", err)
	}
	if platform.TakeInterrupt() {
		t.Error("taken twice")
	}
}
