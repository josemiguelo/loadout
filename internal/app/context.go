// Package app is what the CLI and the home screen share (the app context,
// the outdated query, the command a home-screen run starts, explain, the self-version check):
// the services every command and the screen use, and the Screen interface
// the home screen implements. Neither side owns these twice, and neither
// imports the other.
package app

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/detect"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/loader"
	"github.com/josemiguelo/loadout/internal/core/platform"
	"github.com/josemiguelo/loadout/internal/core/state"
	"github.com/josemiguelo/loadout/internal/model"
)

// AppContext is the shared services and resolved global options, built once
// by the root command. Safe for concurrent use: the home screen refreshes
// the machine and asks the remotes at the same time.
type AppContext struct {
	// RepoRoot is the config repo, as given (`--repo`, $LOADOUT_REPO, ".").
	RepoRoot string
	// MachineOverride is `--machine` / $LOADOUT_MACHINE; "" = the hostname.
	MachineOverride string
	Verbose         bool
	Runner          exec.ProcessRunner
	Detection       *detect.Detection

	mu         sync.Mutex
	fromLayout *fromLayout
	// What the last RefreshAndWriteState left unanswered.
	lastConfigsDown  *string
	lastScriptDetail map[string]string
	lastToolsDown    []engine.ToolDown
}

// New is the context of the repo at repoRoot, running real processes.
func New(repoRoot, machineOverride string, verbose bool) *AppContext {
	runner := exec.NewShellRunner()
	return NewWith(repoRoot, machineOverride, verbose, runner, detect.New(runner, os.DirFS("/")))
}

// NewWith is New over the runner and detection given (tests).
func NewWith(repoRoot, machineOverride string, verbose bool, runner exec.ProcessRunner, detection *detect.Detection) *AppContext {
	return &AppContext{
		RepoRoot:        repoRoot,
		MachineOverride: machineOverride,
		Verbose:         verbose,
		Runner:          runner,
		Detection:       detection,
		fromLayout:      &fromLayout{},
	}
}

// lazy is a value computed once, with the error computing it gave.
type lazy[T any] struct {
	once  sync.Once
	value T
	err   error
}

func (l *lazy[T]) get(compute func() (T, error)) (T, error) {
	l.once.Do(func() { l.value, l.err = compute() })
	return l.value, l.err
}

// fromLayout is what the lock's layout decides (folders, the parent,
// chezmoi's sources), read once. ReloadLayout reads it again: a pull or a
// compile can move them (a repo that renames its configs folder), and
// everything after must use the new names.
type fromLayout struct {
	layout      lazy[model.RepoLayout]
	stateStore  lazy[*state.StateStore]
	parentRoot  lazy[string]
	parentStore lazy[*state.StateStore]
	configs     lazy[*engine.ConfigEngine]
}

func (a *AppContext) current() *fromLayout {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.fromLayout
}

// ReloadLayout forgets the layout read so far; the next use reads the lock
// again (sync, after its pulls and compile).
func (a *AppContext) ReloadLayout() {
	a.mu.Lock()
	a.fromLayout = &fromLayout{}
	a.mu.Unlock()
}

// Home is $HOME, "" when unset: where a parent at `~/…` lives.
func Home() string {
	home, _ := platform.EnvVar("HOME")
	return home
}

// Layout is the lock's layout, read without the checks a full load makes.
func (a *AppContext) Layout() (model.RepoLayout, error) {
	return a.current().layout.get(func() (model.RepoLayout, error) { return loader.ReadLayout(a.RepoRoot) })
}

// StateStore is this repo's state directory.
func (a *AppContext) StateStore() (*state.StateStore, error) {
	return a.current().stateStore.get(func() (*state.StateStore, error) {
		layout, err := a.Layout()
		if err != nil {
			return nil, err
		}
		return state.NewStateStore(a.RepoRoot, layout.State, false), nil
	})
}

// ParentRoot is a child repo's parent checkout (contract 18), or "".
func (a *AppContext) ParentRoot() (string, error) {
	return a.current().parentRoot.get(func() (string, error) {
		layout, err := a.Layout()
		if err != nil {
			return "", err
		}
		return loader.ParentRoot(a.RepoRoot, layout, Home())
	})
}

// parentStateStore is a child repo's parent's state, read for the fleet view
// only; nil for any other repo.
func (a *AppContext) parentStateStore() (*state.StateStore, error) {
	return a.current().parentStore.get(func() (*state.StateStore, error) {
		layout, err := a.Layout()
		if err != nil || layout.Parent == nil {
			return nil, err
		}
		root, err := a.ParentRoot()
		if err != nil || root == "" {
			return nil, err
		}
		return state.NewStateStore(root, layout.Parent.State, true), nil
	})
}

// FleetStates is every machine's state the fleet view shows: this repo's,
// and for a child its parent's machines too (a name in both is this repo's).
func (a *AppContext) FleetStates() (model.Map[coremodel.MachineState], error) {
	parent, err := a.parentStateStore()
	if err != nil {
		return model.Map[coremodel.MachineState]{}, err
	}
	store, err := a.StateStore()
	if err != nil {
		return model.Map[coremodel.MachineState]{}, err
	}
	var states model.Map[coremodel.MachineState]
	if parent != nil {
		states = parent.ReadAll()
	}
	return states.Plus(store.ReadAll()), nil
}

// FleetWarnings is the warnings from the last FleetStates (or StateStore) read.
func (a *AppContext) FleetWarnings() []string {
	var warnings []string
	if parent, _ := a.parentStateStore(); parent != nil {
		warnings = append(warnings, parent.LastWarnings()...)
	}
	if store, err := a.StateStore(); err == nil {
		warnings = append(warnings, store.LastWarnings()...)
	}
	return warnings
}

// LoadManifest is the repo's manifest as this machine sees it (its script
// variants picked): the lock, checked (contract 10).
func (a *AppContext) LoadManifest() (model.Manifest, error) {
	manifest, err := loader.LoadRepo(a.RepoRoot, Home())
	if err != nil {
		return model.Manifest{}, err
	}
	return manifest.ForMachine(a.DetectSystem().Machine), nil
}

// DetectSystem is the machine loadout runs as.
func (a *AppContext) DetectSystem() coremodel.SystemInfo {
	return a.Detection.DetectSystem(a.MachineOverride)
}

// BinaryAvailable says whether binary is on this machine's PATH (a probe).
func (a *AppContext) BinaryAvailable(binary string) bool {
	ok, _ := a.Detection.IsBinaryAvailable(binary)
	return ok
}

// CanonicalRoot is the repo root, absolute, symlinks resolved.
func (a *AppContext) CanonicalRoot() (string, error) {
	root, err := filepath.Abs(a.RepoRoot)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(root)
}

// Frame is how manifest commands run on system: in the declaring file's
// directory (a parent's in the parent), with the LOADOUT_* variables (contract 5).
func (a *AppContext) Frame(system coremodel.SystemInfo) (exec.CommandFrame, error) {
	root, err := a.CanonicalRoot()
	if err != nil {
		return exec.CommandFrame{}, err
	}
	layout, err := a.Layout()
	if err != nil {
		return exec.CommandFrame{}, err
	}
	parentRoot, err := a.ParentRoot()
	if err != nil {
		return exec.CommandFrame{}, err
	}
	var parentConfigs *string
	if layout.Parent != nil {
		parentConfigs = layout.Parent.Configs
	}
	return exec.FrameOf(root, system, layout.Configs, parentRoot, parentConfigs), nil
}

// Configs is chezmoi over the `layout configs` directory, and for a child
// repo its parent's too (the parent's first); nil when neither has one.
// chezmoi sees the repo and machine loadout runs as, so the templates'
// partial agrees with `--repo` and `--machine`.
func (a *AppContext) Configs() (*engine.ConfigEngine, error) {
	return a.current().configs.get(func() (*engine.ConfigEngine, error) {
		layout, err := a.Layout()
		if err != nil {
			return nil, err
		}
		root, err := a.CanonicalRoot()
		if err != nil {
			return nil, err
		}
		var sources []engine.ConfigSource
		if parent := layout.Parent; parent != nil && parent.Configs != nil {
			parentRoot, err := a.ParentRoot()
			if err != nil {
				return nil, err
			}
			if parentRoot != "" {
				sources = append(sources, engine.ConfigSource{Dir: parentRoot + "/" + *parent.Configs, Label: "parent " + parent.Name})
			}
		}
		if layout.Configs != nil {
			sources = append(sources, engine.ConfigSource{Dir: root + "/" + *layout.Configs})
		}
		if len(sources) == 0 {
			return nil, nil
		}
		env := map[string]string{"LOADOUT_REPO": root, "LOADOUT_MACHINE": a.DetectSystem().Machine}
		return engine.NewConfigEngine(a.Runner, sources, env), nil
	})
}

// HasConfigs says whether the repo has configs; false when the lock can't say.
func (a *AppContext) HasConfigs() bool {
	configs, err := a.Configs()
	return err == nil && configs != nil
}

// StatusEngine is the observer every refresh uses: programs, scripts and configs.
func (a *AppContext) StatusEngine(system coremodel.SystemInfo) (*engine.StatusEngine, error) {
	frame, err := a.Frame(system)
	if err != nil {
		return nil, err
	}
	configs, err := a.Configs()
	if err != nil {
		return nil, err
	}
	return engine.NewStatusEngine(engine.NewVersionChecker(a.Runner, frame), a.Runner, frame, configs), nil
}

// LastConfigsDown is why configs went unchecked during the last refresh, or nil.
func (a *AppContext) LastConfigsDown() *string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lastConfigsDown
}

// LastScriptDetail is what each failing script check printed during the last refresh.
func (a *AppContext) LastScriptDetail() map[string]string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lastScriptDetail
}

// LastToolsDown is the tools whose checks couldn't run during the last
// refresh (see engine.StatusEngine.LastToolsDown).
func (a *AppContext) LastToolsDown() []engine.ToolDown {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lastToolsDown
}

// RefreshAndWriteState re-runs all version checks, merges in any script
// results from this run (scriptResults, empty for none), writes the state
// file, and returns the new state. updatedAt (and git history) stays put
// when nothing real changed.
func (a *AppContext) RefreshAndWriteState(
	manifest model.Manifest,
	system coremodel.SystemInfo,
	scriptResults model.Map[coremodel.ScriptState],
) (coremodel.MachineState, error) {
	return a.RefreshAndWriteStateParts(manifest, system, scriptResults, nil)
}

// RefreshAndWriteStateParts is RefreshAndWriteState, handing each subject
// (programs, scripts, configs) to onPart as soon as its own checks finish
// (engine.StatusEngine.RefreshParts). The state file is still written once,
// with the whole observation: never half of one.
func (a *AppContext) RefreshAndWriteStateParts(
	manifest model.Manifest,
	system coremodel.SystemInfo,
	scriptResults model.Map[coremodel.ScriptState],
	onPart func(engine.Part),
) (coremodel.MachineState, error) {
	store, err := a.StateStore()
	if err != nil {
		return coremodel.MachineState{}, err
	}
	previous := store.Read(system.Machine)
	observer, err := a.StatusEngine(system)
	if err != nil {
		return coremodel.MachineState{}, err
	}
	observed, err := observer.RefreshParts(manifest, system, previous, scriptResults, onPart)
	if err != nil {
		return coremodel.MachineState{}, err
	}
	a.mu.Lock()
	a.lastScriptDetail = observer.LastScriptDetail()
	a.lastToolsDown = observer.LastToolsDown()
	a.lastConfigsDown = observer.LastConfigsDown()
	a.mu.Unlock()
	return store.WriteChanged(previous, observed)
}
