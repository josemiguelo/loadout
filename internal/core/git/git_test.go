package git

import (
	"slices"
	"testing"

	"github.com/josemiguelo/loadout/internal/core/exec/fakeexec"
)

func TestAFailedGitCommandSaysWhatGitSaid(t *testing.T) {
	runner := fakeexec.New().OnCommand("git pull --rebase --autostash", fakeexec.Exit(1), fakeexec.Stderr("fatal: no remote\n"))
	err := New(runner, "/repo").PullRebase()
	if err == nil || err.Error() != "git pull failed (exit 1): fatal: no remote" {
		t.Errorf("%v", err)
	}
	if c := runner.Received()[0]; c.Cwd != "/repo" {
		t.Error(c.Cwd)
	}
}

func TestACommitStagesEachPathAndSkipsWhenNothingChanged(t *testing.T) {
	runner := fakeexec.New().OnCommand("git add 'state/m.json'").OnCommand("git diff --cached --quiet")
	if committed, err := New(runner, "/repo").AddCommit([]string{"state/m.json"}, "x"); err != nil || committed {
		t.Errorf("%v %v", err, committed)
	}
	runner = fakeexec.New().
		OnCommand("git add 'state/m.json'").
		OnCommand("git diff --cached --quiet", fakeexec.Exit(1)).
		OnCommand(`git commit -m 'loadout: m'\''s state'`)
	if committed, err := New(runner, "/repo").AddCommit([]string{"state/m.json"}, "loadout: m's state"); err != nil || !committed {
		t.Errorf("%v %v", err, committed)
	}
	if !slices.Contains(runner.Executed(), `git commit -m 'loadout: m'\''s state'`) {
		t.Error(runner.Executed())
	}
}
