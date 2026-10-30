package app

import (
	"slices"
	"strings"
	"testing"
)

func TestRunCommandIsTheChildLoadoutWithTheHandoffEnv(t *testing.T) {
	t.Setenv("PAGER", "less")
	a := &AppContext{RepoRoot: "/repo", MachineOverride: "m1"}
	cmd := a.childCommand("/bin/loadout", "install", []string{"a b", "--yes"})
	want := []string{"/bin/loadout", "--repo", "/repo", "--machine", "m1", "install", "a b", "--yes"}
	if cmd.Path != "/bin/loadout" || !slices.Equal(cmd.Args, want) {
		t.Errorf("path %s args %q", cmd.Path, cmd.Args)
	}
	last := map[string]string{}
	for _, kv := range cmd.Env {
		k, v, _ := strings.Cut(kv, "=")
		last[k] = v
	}
	for k, v := range map[string]string{"LOADOUT_HANDOFF": "1", "PAGER": "cat", "GIT_PAGER": "cat"} {
		if last[k] != v {
			t.Errorf("%s=%q, want %q", k, last[k], v)
		}
	}
	if cmd.Dir != "" || cmd.Stdin != nil {
		t.Errorf("dir %q stdin %v", cmd.Dir, cmd.Stdin)
	}
}

func TestRunCommandRunsClosedsCommand(t *testing.T) {
	a := &AppContext{RepoRoot: "/repo"}
	cmd, err := a.RunCommand(Closed{Action: ActionHandOff, Handoff: &Handoff{Kind: PaneScripts, Args: []string{"s1"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cmd.Args[1:], []string{"--repo", "/repo", "run", "s1", "--force"}) {
		t.Errorf("args %q", cmd.Args)
	}
	if cmd, err := a.RunCommand(Closed{Action: ActionNone}); cmd != nil || err != nil {
		t.Errorf("nothing to run gave %v, %v", cmd, err)
	}
}

func TestQuotingSurvivesSpacesAndSingleQuotes(t *testing.T) {
	for in, want := range map[string]string{"plain": "'plain'", "a b": "'a b'", "it's": `'it'\''s'`} {
		if got := ShQuote(in); got != want {
			t.Errorf("ShQuote(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestSelfArgvCarriesTheGlobalOptions(t *testing.T) {
	a := &AppContext{RepoRoot: "repo", MachineOverride: "m1", Verbose: true}
	got := a.SelfArgv("/bin/loadout", "run", "x")
	want := []string{"/bin/loadout", "--repo", "repo", "--machine", "m1", "-v", "run", "x"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
