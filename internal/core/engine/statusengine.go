package engine

import (
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/platform"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/version"
)

// ToolDown is a tool the checks go through that couldn't answer this time.
type ToolDown struct {
	Tool string
	// Programs is the programs whose checks it left unanswered.
	Programs []string
	// OnPath: `command -v` finds it: it's there but its checks fail anyway.
	OnPath bool
}

// Message is one line for a person: the fact, and what it cost.
func (t ToolDown) Message() string {
	fact := t.Tool + " is not on PATH"
	if t.OnPath {
		fact = t.Tool + " is on PATH but its checks fail"
	}
	return fact + " — " + strconv.Itoa(len(t.Programs)) + " program(s) not checked"
}

// StatusEngine builds this machine's MachineState by observing it: every
// program's version check runs, every applicable script's `check` command
// runs, and chezmoi reports the config units (ConfigEngine). All checks are
// read-only, so they run concurrently (bounded), scripts and configs
// overlapping with programs — one slow check no longer serializes `status`.
type StatusEngine struct {
	checker *VersionChecker
	runner  exec.ProcessRunner
	frame   exec.CommandFrame
	// configs observes config units; nil when the repo has no `layout configs`.
	configs *ConfigEngine

	lastConfigsDown  *string
	lastScriptDetail map[string]string
	lastToolsDown    []ToolDown
}

// NewStatusEngine is an observer; configs is nil without `layout configs`.
func NewStatusEngine(checker *VersionChecker, runner exec.ProcessRunner, frame exec.CommandFrame, configs *ConfigEngine) *StatusEngine {
	return &StatusEngine{checker: checker, runner: runner, frame: frame, configs: configs}
}

// LastConfigsDown is why configs went unchecked during the last Refresh (chezmoi's answer), or nil.
func (s *StatusEngine) LastConfigsDown() *string { return s.lastConfigsDown }

// LastScriptDetail is what each failing script check printed during the
// last Refresh — the "missing: ..." detail managing scripts' checks emit.
// Same surfacing pattern as StateStore.LastWarnings: read it right after the call.
func (s *StatusEngine) LastScriptDetail() map[string]string { return s.lastScriptDetail }

// LastToolsDown is the tools whose checks could not run during the last
// Refresh, each with the programs left unchecked and whether the tool is on
// PATH at all (asked once per tool with `command -v`). "brew is not on PATH
// — 21 programs not checked" is one line to a person; the per-row reasons
// only say which rows.
func (s *StatusEngine) LastToolsDown() []ToolDown { return s.lastToolsDown }

type scriptObservation struct {
	name   string
	state  coremodel.ScriptState
	detail *string
	err    error
}

// Part is one subject of a Refresh, observed: programs (with the tools their
// checks couldn't reach), scripts (with their checks' detail) or configs
// (with chezmoi's reason when it couldn't answer). Err says that part
// failed; the Refresh then fails with it.
type Part struct {
	Kind        PartKind
	Programs    model.Map[coremodel.ProgramState]
	ToolsDown   []ToolDown
	Scripts     model.Map[coremodel.ScriptState]
	Detail      map[string]string
	Configs     model.Map[coremodel.ConfigState]
	ConfigsDown *string
	Err         error
}

// PartKind names a Part's subject.
type PartKind int

const (
	PartPrograms PartKind = iota
	PartScripts
	PartConfigs
)

// Refresh observes the machine. scriptRuns are results of scripts the tool
// just executed; their lastRun/exitCode history is kept, but a script's
// `check` has the final word on its status:
//   - check exits 0 -> done (whether or not the tool ever ran it)
//   - check fails   -> pending (even right after a run — the check is the truth)
//   - no check      -> only actual run history can be recorded
//
// Only scripts this machine opted into (its `scripts` list) are observed.
func (s *StatusEngine) Refresh(
	manifest model.Manifest,
	system coremodel.SystemInfo,
	previous *coremodel.MachineState,
	scriptRuns model.Map[coremodel.ScriptState],
) (coremodel.MachineState, error) {
	return s.RefreshParts(manifest, system, previous, scriptRuns, nil)
}

// RefreshParts is Refresh, also handing each subject to onPart the moment
// its own checks finish (programs, scripts and configs run side by side),
// so a screen can settle each one on its own. onPart is called from the
// checks' goroutines, once per subject this machine has; nil = Refresh.
// The returned state is still the whole observation, made when all are in.
func (s *StatusEngine) RefreshParts(
	manifest model.Manifest,
	system coremodel.SystemInfo,
	previous *coremodel.MachineState,
	scriptRuns model.Map[coremodel.ScriptState],
	onPart func(Part),
) (coremodel.MachineState, error) {
	emit := func(p Part) {
		if onPart != nil {
			onPart(p)
		}
	}
	// Membership: only programs this machine maps are part of its loadout,
	// each checked with the version check its mapped key resolves to.
	config, _ := manifest.Machines.Get(system.Machine)
	mapped := config.PM
	var observedChecks model.Map[*model.VersionCheck]
	for _, name := range manifest.Programs.Keys() {
		if key, ok := mapped.Get(name); ok {
			observedChecks.Set(name, manifest.CheckFor(name, &key))
		}
	}

	var wg sync.WaitGroup
	var programs model.Map[coremodel.ProgramState]
	var programsErr error
	var toolsDown []ToolDown
	wg.Go(func() {
		programs, programsErr = s.checker.CheckAll(observedChecks)
		if programsErr == nil {
			toolsDown, programsErr = s.toolsDown(manifest, observedChecks, programs)
		}
		emit(Part{Kind: PartPrograms, Programs: programs, ToolsDown: toolsDown, Err: programsErr})
	})
	var configStates model.Map[coremodel.ConfigState]
	var configsErr error
	if s.configs != nil {
		var last model.Map[coremodel.ConfigState]
		if previous != nil {
			last = previous.Configs
		}
		wg.Go(func() {
			configStates, configsErr = s.configs.Observe(last)
			emit(Part{Kind: PartConfigs, Configs: configStates, ConfigsDown: s.configs.LastReason(), Err: configsErr})
		})
	}

	var observed []*scriptObservation
	var scriptsWG sync.WaitGroup
	permits := make(chan struct{}, parallelism)
	for name, args := range config.ScriptArgs().All() {
		step, ok := manifest.Scripts.Get(name)
		if !ok {
			continue
		}
		history, ran := scriptRuns.Get(name)
		if !ran && previous != nil {
			history, ran = previous.Scripts.Get(name)
		}
		o := &scriptObservation{name: name}
		switch {
		case step.Check != nil:
			check := WithArgs(*step.Check, args)
			observed = append(observed, o)
			scriptsWG.Go(func() {
				permits <- struct{}{}
				defer func() { <-permits }()
				result, err := s.runner.Capture(s.frame.Command(check, step.Origin))
				if err != nil {
					o.err = err
					return
				}
				o.state = coremodel.ScriptState{Status: coremodel.Pending}
				if result.Success() {
					o.state.Status = coremodel.Done
				}
				if ran {
					o.state.LastRun, o.state.ExitCode = history.LastRun, history.ExitCode
				}
				if !result.Success() {
					var kept []string
					for _, l := range lines(result.Stdout + result.Stderr) {
						if !isBlank(l) {
							kept = append(kept, l)
						}
					}
					if detail := strings.Join(kept, "\n"); !isBlank(detail) {
						o.detail = &detail
					}
				}
			})
		case ran:
			o.state = history
			observed = append(observed, o)
		}
	}
	// Scripts are one part: they land together, when the last check is in.
	detail := map[string]string{}
	var scripts model.Map[coremodel.ScriptState]
	var scriptsErr error
	wg.Go(func() {
		scriptsWG.Wait()
		for _, o := range observed {
			if o.err != nil {
				scriptsErr = o.err
				break
			}
			scripts.Set(o.name, o.state)
			if o.detail != nil {
				detail[o.name] = *o.detail
			}
		}
		emit(Part{Kind: PartScripts, Scripts: scripts, Detail: detail, Err: scriptsErr})
	})
	wg.Wait()
	for _, err := range []error{programsErr, configsErr, scriptsErr} {
		if err != nil {
			return coremodel.MachineState{}, err
		}
	}
	s.lastScriptDetail = detail
	s.lastToolsDown = toolsDown

	s.lastConfigsDown = nil
	if s.configs != nil {
		s.lastConfigsDown = s.configs.LastReason()
	}
	return coremodel.MachineState{
		SchemaVersion: coremodel.SchemaVersion,
		Machine:       system.Machine,
		Os:            string(system.Os),
		Distro:        system.Distro,
		Arch:          system.Arch,
		ToolVersion:   version.Version,
		UpdatedAt:     platform.NowIso(),
		Programs:      programs,
		Scripts:       scripts,
		Configs:       configStates,
	}, nil
}

// toolsDown groups the checks that couldn't run by the tool they asked
// through, then asks about each tool ONCE: absent, or present but failing
// (a wrapper that exits 126, say).
func (s *StatusEngine) toolsDown(
	manifest model.Manifest,
	observedChecks model.Map[*model.VersionCheck],
	programs model.Map[coremodel.ProgramState],
) ([]ToolDown, error) {
	var byTool model.Map[[]string]
	for name, state := range programs.All() {
		if state.Status != coremodel.Unknown || state.Reason == nil {
			continue
		}
		if check := observedChecks.Value(name); check != nil && check.Probe != nil && *check.Probe != "" {
			byTool.Set(*check.Probe, append(byTool.Value(*check.Probe), name))
		}
	}
	var down []ToolDown
	for tool, names := range byTool.All() {
		found, err := s.runner.Capture(exec.Line(model.ShellLine("command -v "+tool, manifest.ToolPaths[tool]), ""))
		if err != nil {
			return nil, err
		}
		down = append(down, ToolDown{tool, slices.Sorted(slices.Values(names)), found.Success()})
	}
	slices.SortFunc(down, func(a, b ToolDown) int { return strings.Compare(a.Tool, b.Tool) })
	return down, nil
}
