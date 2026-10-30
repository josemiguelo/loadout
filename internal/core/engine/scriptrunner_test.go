package engine

import (
	"slices"
	"testing"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/exec/fakeexec"
	"github.com/josemiguelo/loadout/internal/model"
)

func runScript(t *testing.T, fake *fakeexec.Runner, step model.ScriptStep, force bool, args string) ScriptOutcome {
	t.Helper()
	return must[ScriptOutcome](t)(NewScriptRunner(fake, repoFrame).Run(step, force, args))
}

func TestSkipsWhenCheckPasses(t *testing.T) {
	fake := fakeexec.New().OnCommand("test -d $HOME/.dotfiles")
	if !runScript(t, fake, model.ScriptStep{File: s("x.sh"), Check: s("test -d $HOME/.dotfiles")}, false, "").AlreadyDone {
		t.Error("ran")
	}
}

func TestFileCheckExpandsToShAndKeepsArgs(t *testing.T) {
	fake := fakeexec.New().OnCommand("set -- fedora; sh 'scripts/x.sh' check")
	if !runScript(t, fake, model.ScriptStep{File: s("scripts/x.sh"), Check: s("file:scripts/x.sh check")}, false, "fedora").AlreadyDone {
		t.Error("ran")
	}
}

func TestForceIgnoresCheck(t *testing.T) {
	fake := fakeexec.New().OnCommand("test -d $HOME/.dotfiles").OnCommand("echo hi")
	outcome := runScript(t, fake, model.ScriptStep{Run: s("echo hi"), Check: s("test -d $HOME/.dotfiles")}, true, "")
	if outcome.AlreadyDone || outcome.State.Status != coremodel.Done {
		t.Errorf("%+v", outcome)
	}
}

func TestRunsScriptFileThroughSh(t *testing.T) {
	fake := fakeexec.New().OnCommand("sh 'scripts/setup.sh'")
	outcome := runScript(t, fake, model.ScriptStep{File: s("scripts/setup.sh")}, false, "")
	if outcome.AlreadyDone || outcome.State.Status != coremodel.Done {
		t.Errorf("%+v", outcome)
	}
	if !slices.Contains(fake.Executed(), "sh 'scripts/setup.sh'") {
		t.Error(fake.Executed())
	}
}

func TestArgsReachFileScriptAndCheck(t *testing.T) {
	// Check receives args as positional params via `set --`; fails -> script runs.
	fake := fakeexec.New().
		OnCommand("set -- fedora; test -f $HOME/.ssh/$1", fakeexec.Exit(1)).
		OnCommand("sh 'scripts/setup-ssh.sh' fedora")
	outcome := runScript(t, fake, model.ScriptStep{File: s("scripts/setup-ssh.sh"), Check: s("test -f $HOME/.ssh/$1")}, false, "fedora")
	if outcome.AlreadyDone || !slices.Contains(fake.Executed(), "sh 'scripts/setup-ssh.sh' fedora") {
		t.Errorf("%+v %v", outcome, fake.Executed())
	}
}

func TestArgsCheckPassingSkipsRun(t *testing.T) {
	fake := fakeexec.New().OnCommand("set -- fedora; test -f $HOME/.ssh/$1")
	if !runScript(t, fake, model.ScriptStep{File: s("scripts/setup-ssh.sh"), Check: s("test -f $HOME/.ssh/$1")}, false, "fedora").AlreadyDone {
		t.Error("ran")
	}
}

func TestAScriptAndItsCheckRunInTheDeclaringDirectoryWithTheLoadoutEnv(t *testing.T) {
	fake := fakeexec.New().OnCommand("sh 'plugins.sh' check", fakeexec.Exit(1)).OnCommand("sh 'plugins.sh'")
	system := coremodel.SystemInfo{Machine: "m1", Os: coremodel.MacOS, Arch: "arm64"}
	frame := exec.FrameOf("/repo", system, s("configs"), "", nil)
	step := model.ScriptStep{File: s("plugins.sh"), Check: s("file:plugins.sh check"), Origin: "configs/tmux"}

	outcome := must[ScriptOutcome](t)(NewScriptRunner(fake, frame).Run(step, false, ""))
	if outcome.AlreadyDone {
		t.Error("didn't run")
	}
	received := fake.Received()
	eq(t, 2, len(received))
	for _, command := range received {
		eq(t, "/repo/configs/tmux", command.Cwd)
		eq(t, map[string]string{
			"LOADOUT_REPO":         "/repo",
			"LOADOUT_MACHINE":      "m1",
			"LOADOUT_OS":           "macos",
			"LOADOUT_CONFIGS":      "/repo/configs",
			"LOADOUT_FRAGMENT_DIR": "/repo/configs/tmux",
		}, command.Env)
	}
}

func TestInAChildAParentsScriptRunsInTheParentWithTheParentsRepoAndAChildsInTheChild(t *testing.T) {
	fake := fakeexec.New().OnCommand("sh 'helper.sh'").OnCommand("sh 'mine.sh'")
	system := coremodel.SystemInfo{Machine: "work", Os: coremodel.MacOS, Arch: "arm64"}
	frame := exec.FrameOf("/child", system, s("configs"), "/parent", s("dots"))

	must[ScriptOutcome](t)(NewScriptRunner(fake, frame).Run(model.ScriptStep{File: s("helper.sh"), Origin: "parent:maintenance/lib"}, false, ""))
	must[ScriptOutcome](t)(NewScriptRunner(fake, frame).Run(model.ScriptStep{File: s("mine.sh"), Origin: "scripts"}, false, ""))
	received := fake.Received()
	parents, childs := received[0], received[1]
	eq(t, "/parent/maintenance/lib", parents.Cwd)
	eq(t, map[string]string{
		"LOADOUT_REPO":         "/parent",
		"LOADOUT_PARENT":       "/parent",
		"LOADOUT_MACHINE":      "work",
		"LOADOUT_OS":           "macos",
		"LOADOUT_CONFIGS":      "/parent/dots",
		"LOADOUT_FRAGMENT_DIR": "/parent/maintenance/lib",
	}, parents.Env)
	eq(t, "/child/scripts", childs.Cwd)
	eq(t, "/child", childs.Env["LOADOUT_REPO"])
	eq(t, "/parent", childs.Env["LOADOUT_PARENT"])
	eq(t, "/child/configs", childs.Env["LOADOUT_CONFIGS"])
}

func TestARootDeclaredScriptRunsInTheRepoRoot(t *testing.T) {
	fake := fakeexec.New().OnCommand("true")
	runScript(t, fake, model.ScriptStep{Run: s("true")}, false, "")
	eq(t, "/repo", fake.Received()[0].Cwd)
}

func TestRecordsFailure(t *testing.T) {
	fake := fakeexec.New().OnCommand("false", fakeexec.Exit(1))
	outcome := runScript(t, fake, model.ScriptStep{Run: s("false")}, false, "")
	if outcome.State.Status != coremodel.Failed || *outcome.State.ExitCode != 1 || outcome.State.LastRun == nil {
		t.Errorf("%+v", outcome)
	}
}

func TestATwoModeChecksArgumentsAreForwarded(t *testing.T) {
	// A managing script's check is `file:x.sh check "$@"`: the machine's
	// arguments, set as positional params, reach the check mode.
	fake := fakeexec.New().OnCommand(`set -- id_ed25519; sh 'x.sh' check "$@"`)
	if !runScript(t, fake, model.ScriptStep{File: s("x.sh"), Check: s(`file:x.sh check "$@"`)}, false, "id_ed25519").AlreadyDone {
		t.Error("ran")
	}
}

func TestAVariantRunsItsOwnFileAndCheck(t *testing.T) {
	fake := fakeexec.New().OnCommand("sh 'arch.sh' check", fakeexec.Exit(1)).OnCommand("sh 'arch.sh'")
	step := model.ScriptStep{
		Description: "keyboard",
		Sudo:        true,
		Variants: model.MapOf(
			model.E("arch", model.ScriptStep{File: s("arch.sh"), Check: s("file:arch.sh check")}),
			model.E("fedora", model.ScriptStep{File: s("fedora.sh"), Check: s("file:fedora.sh check")}),
		),
	}.Variant("arch")
	if runScript(t, fake, step, false, "").AlreadyDone {
		t.Error("didn't run")
	}
	eq(t, []string{"sh 'arch.sh' check", "sh 'arch.sh'"}, fake.Executed())
	eq(t, true, step.Sudo)
}
