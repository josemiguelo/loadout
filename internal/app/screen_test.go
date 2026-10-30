package app

import (
	"strings"
	"testing"
)

func TestEachConfirmedActionRunsTheCommandItNames(t *testing.T) {
	cases := []struct {
		closed Closed
		want   string
	}{
		{Closed{Action: ActionUpgrade}, "self-upgrade"},
		{Closed{Action: ActionSync}, "sync"},
		{Closed{Action: ActionSetup}, "setup-new-machine"},
		// The pane already asked: the command's own confirmation is skipped.
		{Closed{ActionHandOff, &Handoff{PaneInstall, []string{"fd", "rg"}}}, "install fd rg --yes"},
		{Closed{ActionHandOff, &Handoff{PaneScripts, []string{"dots"}}}, "run dots --force"},
		// The screen already refused files edited here; never --force from it.
		{Closed{ActionHandOff, &Handoff{PaneConfigs, []string{"zsh"}}}, "apply zsh"},
		{Closed{ActionHandOff, &Handoff{PaneUpgrade, []string{"brew"}}}, "upgrade brew --yes"},
		{Closed{ActionHandOff, &Handoff{PaneList, []string{"--item", "pins/x"}}}, "upgrade --item pins/x --yes"},
	}
	for _, c := range cases {
		name, args, ok := c.closed.Command()
		if got := strings.Join(append([]string{name}, args...), " "); !ok || got != c.want {
			t.Errorf("%+v: got %q (%v), want %q", c.closed, got, ok, c.want)
		}
	}
}

func TestQuittingOrARowVerbRunsNothing(t *testing.T) {
	for _, action := range []HomeAction{ActionNone, ActionRunScripts, ActionInstallMissing, ActionApplyConfigs, ActionReviewOutdated, ActionShowDiff} {
		if _, _, ok := (Closed{Action: action}).Command(); ok {
			t.Errorf("action %d runs a command", action)
		}
	}
	if _, _, ok := (Closed{Action: ActionHandOff}).Command(); ok {
		t.Error("a hand-off without its command runs one")
	}
}

func TestAHandoffsArgsAreNotChanged(t *testing.T) {
	h := &Handoff{PaneInstall, []string{"fd"}}
	Closed{ActionHandOff, h}.Command()
	if len(h.Args) != 1 {
		t.Errorf("the screen's args changed: %v", h.Args)
	}
}
