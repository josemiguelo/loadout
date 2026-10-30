package cli

import (
	"errors"
	"strconv"
	"strings"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/git"
	"github.com/josemiguelo/loadout/internal/core/loader"
	"github.com/josemiguelo/loadout/internal/core/platform"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/version"
	"github.com/spf13/cobra"
)

const (
	// syncUpgraded is set on the sync an upgrade starts.
	syncUpgraded = "LOADOUT_SYNC_UPGRADED"
	// syncRecompiled is set on the sync an upgrade starts when the sync
	// before it compiled the lock.
	syncRecompiled = "LOADOUT_SYNC_RECOMPILED"
)

// SyncException is a sync that couldn't carry on after the pulled repo
// needed a newer loadout.
type SyncException struct{ Message string }

func (e *SyncException) Error() string { return e.Message }

// Refusal marks it a refusal.
func (*SyncException) Refusal() {}

func newSyncCmd() *cobra.Command {
	var noPush bool
	var message string
	cmd := subcommand("sync", commandHelp(
		"Pull the config repo, apply its configs, refresh this machine's state, commit only its state file, push. "+
			"When the pulled repo needs a newer loadout, upgrade loadout first and carry on with it. "+
			"A child repo pulls its parent first (never commits or pushes it), and recompiles itself when the "+
			"parent's manifests changed, committing the lock with the state.",
		"--no-push       commit locally, don't push",
		"-m, --message   override the commit message",
	), nil, func(cmd *cobra.Command, args []string) error {
		var msg *string
		if cmd.Flags().Changed("message") {
			msg = &message
		}
		return runSync(appCtx, noPush, msg)
	})
	boolFlag(cmd, cmd.Flags(), &noPush, "no-push", "", "Commit locally but don't push")
	stringFlag(cmd, cmd.Flags(), &message, "message", "m", "", "Commit message")
	return cmd
}

func isToolTooOld(err error) (*model.ToolTooOldException, bool) {
	var e *model.ToolTooOldException
	return e, errors.As(err, &e)
}

func runSync(a *app.AppContext, noPush bool, message *string) error {
	repo := git.New(a.Runner, a.RepoRoot)
	isRepo, err := repo.IsRepo()
	if err != nil {
		return err
	}
	if !isRepo {
		return &git.GitException{Message: a.RepoRoot + " is not a git repository (run `loadout init` or `git init` first)"}
	}

	// A child repo (contract 18): the parent is pulled, nothing more. A lock
	// this loadout can't read yet waits for the upgrade below, whose sync
	// pulls it.
	parentRoot, err := a.ParentRoot()
	if _, tooOld := isToolTooOld(err); tooOld {
		parentRoot, err = "", nil
	}
	if err != nil {
		return err
	}
	if parentRoot != "" {
		parent := git.New(a.Runner, parentRoot)
		if isParentRepo, _ := parent.IsRepo(); isParentRepo {
			if upstream, _ := parent.HasUpstream(); upstream {
				if err := spin("pulling parent "+parentName(a)+"…", parent.PullRebase); err != nil {
					return err
				}
			}
		}
	}

	hasUpstream, err := repo.HasUpstream()
	if err != nil {
		return err
	}
	if hasUpstream {
		if err := spin("pulling latest changes…", repo.PullRebase); err != nil {
			return err
		}
	} else {
		echo(Style.Dim("No upstream configured; skipping pull."))
	}

	// A parent whose manifests moved needs the child compiled against them;
	// a compile that fails stops here with what it said. It reads the lock,
	// so a repo that now needs a newer loadout says so here first.
	compiledNow, err := loader.ParentChanged(a.RepoRoot, app.Home())
	if refusal, tooOld := isToolTooOld(err); tooOld {
		return upgradeAndSyncAgain(a, refusal, false, noPush, message)
	}
	if err != nil {
		return err
	}
	if compiledNow {
		echo(" " + Style.Warn("↻") + "  parent " + parentName(a) + " changed: compiling")
		if err := compileRepo(a); err != nil {
			return err
		}
	}
	// A sync an upgrade started finds the lock already compiled by the sync
	// before it, and still commits it.
	_, recompiledBefore := platform.EnvVar(syncRecompiled)
	recompiled := compiledNow || recompiledBefore

	// Load after pulling so we see the latest manifest, and read the layout
	// again: the pull or the compile can rename its folders.
	a.ReloadLayout()
	manifest, err := a.LoadManifest()
	if refusal, tooOld := isToolTooOld(err); tooOld {
		return upgradeAndSyncAgain(a, refusal, recompiled, noPush, message)
	}
	if err != nil {
		return err
	}
	system := a.DetectSystem()
	// Configs land before the refresh, so the state committed is what this
	// machine has after the pull. A file edited here stops the sync before
	// anything is written: only the user knows which version wins.
	configs, err := a.Configs()
	if err != nil {
		return err
	}
	if configs != nil {
		if err := refuseEdited(configs, nil); err != nil {
			return err
		}
		apply, err := configs.ApplyCommand(nil, false)
		if err != nil {
			return err
		}
		result, err := spinning("applying configs…", func() (exec.ExecResult, error) { return a.Runner.Capture(apply) })
		if err != nil {
			return err
		}
		if !result.Success() {
			why := " (exit " + strconv.Itoa(result.ExitCode) + ")"
			for _, line := range append(strings.Split(result.Stderr, "\n"), strings.Split(result.Stdout, "\n")...) {
				if strings.TrimSpace(line) != "" {
					why = ": " + strings.TrimSpace(line)
					break
				}
			}
			return &engine.ConfigException{Message: "chezmoi apply failed" + why}
		}
		echo(" " + Style.Ok("✔") + "  configs applied")
	}
	observed, err := spinning(Style.Dim("refreshing state for ")+Style.Machine(system.Machine), func() (coremodel.MachineState, error) {
		return a.RefreshAndWriteState(manifest, system, model.Map[coremodel.ScriptState]{})
	})
	if err != nil {
		return err
	}
	if left := leftToDo(observed); left != "" {
		echo(" " + Style.Warn("⚠") + "  " + Style.Warn(left) + Style.Dim("  (run: loadout)"))
	}

	layout, err := a.Layout()
	if err != nil {
		return err
	}
	statePath := layout.State + "/" + system.Machine + ".json"
	// A recompile's lock (and the templates' data beside the configs) goes
	// with the state.
	var paths []string
	defaultMessage := system.Machine + ": update state"
	if recompiled {
		paths = append(paths, model.LockFileName)
		if configs := manifest.Layout.Configs; configs != nil {
			paths = append(paths, model.ChezmoiDataFiles(manifest, *configs).Keys()...)
		}
		defaultMessage = system.Machine + ": compile against parent " + parentName(a) + ", update state"
	}
	paths = append(paths, statePath)
	commitMessage := defaultMessage
	if message != nil {
		commitMessage = *message
	}
	committed, err := repo.AddCommit(paths, commitMessage)
	if err != nil {
		return err
	}
	if !committed {
		echo(" " + Style.Ok("✔") + "  state unchanged; nothing to commit")
		return nil
	}
	echo(" " + Style.Ok("✔") + "  committed " + strings.Join(paths, ", "))

	switch {
	case noPush:
		echo(Style.Dim("Skipping push (--no-push)."))
	case !hasUpstream:
		echo("No upstream configured; not pushing. Add a remote and run `git push -u`.")
	default:
		if err := spin("pushing…", repo.Push); err != nil {
			return err
		}
		echo(" " + Style.Ok("✔") + "  pushed")
	}
	return nil
}

// parentName is the parent's name, as Kotlin printed a missing one ("null").
func parentName(a *app.AppContext) string {
	if layout, err := a.Layout(); err == nil && layout.Parent != nil {
		return layout.Parent.Name
	}
	return "null"
}

// upgradeAndSyncAgain: the pulled repo needs a newer loadout, so install the
// latest release, then run this same sync with it. The second run pulls
// again (nothing new) and carries on; syncUpgraded keeps it from upgrading a
// second time when the binary it runs is still too old (one self-upgrade
// didn't replace). recompiled: this sync compiled the lock, so the one it
// starts commits it.
func upgradeAndSyncAgain(a *app.AppContext, refusal *model.ToolTooOldException, recompiled, noPush bool, message *string) error {
	if _, again := platform.EnvVar(syncUpgraded); again {
		self := platform.SelfExecutable()
		if self == "" {
			self = "this binary"
		}
		return &SyncException{"loadout was upgraded, but " + self + " is still " + version.Version +
			"; this config repo requires loadout >= " + refusal.Required}
	}
	latest := app.LatestRelease(a.Runner, false)
	if latest != "" && !version.AtLeast(latest, refusal.Required) {
		return &SyncException{"this config repo requires loadout >= " + refusal.Required + ", but the latest release is " + latest}
	}
	// Read before the install replaces the file: Linux then names it "(deleted)".
	self := platform.SelfExecutable()
	if self == "" {
		return &SyncException{"can't find loadout's own binary to run the sync again"}
	}
	echo(" " + Style.Warn("↑") + "  this config repo now needs loadout >= " + refusal.Required + " (you have " + version.Version + "): upgrading")
	installed, err := a.Runner.Inherit(exec.Line(version.InstallCommand, ""))
	if err != nil {
		return err
	}
	if installed != 0 {
		return exitWith(installed)
	}
	echo(" " + Style.Ok("✔") + "  loadout upgraded; syncing with it")
	args := []string{"sync"}
	if noPush {
		args = append(args, "--no-push")
	}
	if message != nil {
		args = append(args, "--message", *message)
	}
	argv := a.SelfArgv(self, args...)
	quoted := make([]string, len(argv))
	for i, arg := range argv {
		quoted[i] = app.ShQuote(arg)
	}
	env := syncUpgraded + "=1 "
	if recompiled {
		env += syncRecompiled + "=1 "
	}
	code, err := a.Runner.Inherit(exec.Line(env+strings.Join(quoted, " "), ""))
	if err != nil {
		return err
	}
	if code != 0 {
		return exitWith(code)
	}
	return nil
}

// leftToDo is what this machine still lacks after the sync, or "" when nothing.
func leftToDo(s coremodel.MachineState) string {
	missing, scripts := 0, 0
	for p := range s.Programs.Values() {
		if p.Status == coremodel.Missing {
			missing++
		}
	}
	for sc := range s.Scripts.Values() {
		if sc.Status != coremodel.Done {
			scripts++
		}
	}
	var parts []string
	if missing > 0 {
		word := "programs"
		if missing == 1 {
			word = "program"
		}
		parts = append(parts, strconv.Itoa(missing)+" "+word+" missing")
	}
	if scripts > 0 {
		word := "scripts"
		if scripts == 1 {
			word = "script"
		}
		parts = append(parts, strconv.Itoa(scripts)+" "+word+" not done")
	}
	return strings.Join(parts, " · ")
}
