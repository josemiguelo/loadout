package engine

import (
	"slices"
	"strings"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/model"
)

// PlanItem is one program of an install plan: an InstallItem or an InstalledItem.
type PlanItem interface {
	// ProgramName is the program the item is about.
	ProgramName() string
	planItem()
}

// InstallItem will run Command (the InstallKey entry of the program's install table).
type InstallItem struct {
	Program    string
	InstallKey string
	Command    string
	// Origin is where Command runs: its declaring file's repo-relative directory.
	Origin string
	// Sudo says Command needs sudo's password: it runs sudo, or its variant or installer says so.
	Sudo bool
}

// InstalledItem is a program already installed at Version; nothing to do.
type InstalledItem struct {
	Program string
	Version *string
}

func (i InstallItem) ProgramName() string   { return i.Program }
func (i InstalledItem) ProgramName() string { return i.Program }
func (InstallItem) planItem()               {}
func (InstalledItem) planItem()             {}

// InstallOutcome is one install's exit code and the program's state after it.
type InstallOutcome struct {
	Program    string
	ExitCode   int
	StateAfter coremodel.ProgramState
	// SkippedFor is the dependency that failed (or was itself skipped), when
	// this install never ran because of it; "" when it ran.
	SkippedFor string
}

// Success is exit 0 AND a re-check that no longer says missing (contract 7);
// a skipped install never succeeds.
func (o InstallOutcome) Success() bool {
	return o.SkippedFor == "" && o.ExitCode == 0 && o.StateAfter.Status != coremodel.Missing
}

// Installs is plan's InstallItems, in order.
func Installs(plan []PlanItem) []InstallItem {
	var out []InstallItem
	for _, item := range plan {
		if install, ok := item.(InstallItem); ok {
			out = append(out, install)
		}
	}
	return out
}

// InstallEngine plans and runs installs.
type InstallEngine struct {
	runner  exec.ProcessRunner
	checker *VersionChecker
	frame   exec.CommandFrame
}

// NewInstallEngine is an engine running installs in frame and re-checking with checker.
func NewInstallEngine(runner exec.ProcessRunner, checker *VersionChecker, frame exec.CommandFrame) *InstallEngine {
	return &InstallEngine{runner, checker, frame}
}

// Plan resolves what would happen for requested programs (empty = every
// program this machine's mapping opts into), expanded with their transitive
// dependencies, in dependency order. A program the machine doesn't map is
// simply not part of this machine's loadout — converge skips it.
//
// Strict resolution — a *ResolutionException (before anything runs) when:
//   - the manifest declares no such machine,
//   - an explicitly requested program has no mapping for this machine,
//   - a mapped program's dependency has no mapping for this machine,
//   - a program that needs installing resolves to a probe binary (the
//     variant's `probe`, or its installer's) that is not present on this
//     machine (binaryAvailable, on PATH or where the variant providing it
//     says it lands), unless a program installed before it in this plan
//     `provides` that binary.
func (e *InstallEngine) Plan(
	manifest model.Manifest,
	machine string,
	requested []string,
	currentStates model.Map[coremodel.ProgramState],
	binaryAvailable func(string) bool,
) ([]PlanItem, error) {
	config, ok := manifest.Machines.Get(machine)
	if !ok {
		return nil, &ResolutionException{"machine '" + machine + "' is not declared in the repo (add machine \"" + machine + "\" { … })"}
	}
	mapping := config.PM
	where := "install it in machine '" + machine + "' or a profile it extends"

	// Membership: converge covers only mapped programs.
	targets := requested
	if len(targets) == 0 {
		for _, name := range manifest.Programs.Keys() {
			if mapping.Has(name) {
				targets = append(targets, name)
			}
		}
	}
	ordered := assemble.InstallOrder(manifest, targets, mapping)

	var errors []string
	var items []PlanItem
	for _, name := range ordered {
		installKey, mapped := mapping.Get(name)
		if !mapped {
			if slices.Contains(requested, name) {
				errors = append(errors, "program '"+name+"' isn't installed on machine '"+machine+"' ("+where+")")
			} else {
				errors = append(errors, "program '"+name+"' is required as a dependency but isn't installed on "+
					"machine '"+machine+"' ("+where+")")
			}
			continue
		}
		if state, ok := currentStates.Get(name); ok && state.Status == coremodel.Installed {
			items = append(items, InstalledItem{name, state.Version})
			continue
		}
		// Key existence and command resolvability are validated at manifest
		// load, as is the existence of any file: script.
		resolved := manifest.ResolveInstall(name, installKey)
		command := model.ShellLine(deref(resolved.Command), resolved.Path)
		items = append(items, InstallItem{name, installKey, command, resolved.CommandOrigin, resolved.Sudo || CommandNeedsSudo(command)})
	}

	// Verify that every probe binary the plan actually needs exists here, or
	// is provided by a program the plan installs before it.
	installs := Installs(items)
	var binaries []string
	needing := map[string][]string{}
	for _, item := range installs {
		probe := manifest.ResolveInstall(item.Program, item.InstallKey).Probe
		if probe == nil {
			continue
		}
		if _, seen := needing[*probe]; !seen {
			binaries = append(binaries, *probe)
		}
		needing[*probe] = append(needing[*probe], item.Program)
	}
	for _, binary := range binaries {
		programs := needing[binary]
		landed := false
		for _, dir := range manifest.ToolPaths[binary] {
			if binaryAvailable(dir + "/" + binary) {
				landed = true
				break
			}
		}
		if landed || binaryAvailable(binary) {
			continue
		}
		first := slices.IndexFunc(installs, func(item InstallItem) bool {
			variant := manifest.Programs.Value(item.Program).Install.Value(item.InstallKey)
			return slices.ContainsFunc(variant.Provides, func(p model.Provides) bool { return p.Binary == binary })
		})
		// Only what installs after the first provider can count on it.
		early := programs
		if first >= 0 {
			early = nil
			for _, item := range installs[:first+1] {
				if slices.Contains(programs, item.Program) {
					early = append(early, item.Program)
				}
			}
		}
		if len(early) == 0 {
			continue
		}
		if first < 0 {
			errors = append(errors, "required binary '"+binary+"' (needed to install "+strings.Join(early, ", ")+") "+
				"is not installed on machine '"+machine+"'")
		} else {
			errors = append(errors, "required binary '"+binary+"' (needed to install "+strings.Join(early, ", ")+") comes from "+
				"'"+installs[first].Program+"', which would install after them "+
				"(make them depend on it, or have their installer require it)")
		}
	}

	if len(errors) > 0 {
		return nil, &ResolutionException{"cannot build install plan:\n" + bullets(errors)}
	}
	return items, nil
}

// Execute runs plan's InstallItems in order with inherited stdio,
// re-checking each program's version afterwards. A failure doesn't abort the
// run: independent installs go on. But an install whose dependency failed,
// or was itself skipped, never runs (it could only fail, or half-work, for a
// reason that isn't its own): its outcome names that dependency. Each outcome
// is reported so the caller decides what to surface. onStart (nil = nothing)
// hears of each install as it starts, onSkip (nil = nothing) of each skipped
// one with the dependency it lacks.
func (e *InstallEngine) Execute(manifest model.Manifest, plan []PlanItem, onStart func(InstallItem), onSkip func(InstallItem, string)) ([]InstallOutcome, error) {
	var outcomes []InstallOutcome
	failed := map[string]bool{}
	for _, item := range Installs(plan) {
		key := item.InstallKey
		missing := ""
		for _, dep := range manifest.DependenciesOf(item.Program, &key) {
			if failed[dep] {
				missing = dep
				break
			}
		}
		if missing != "" {
			if onSkip != nil {
				onSkip(item, missing)
			}
			failed[item.Program] = true
			outcomes = append(outcomes, InstallOutcome{Program: item.Program, ExitCode: -1, SkippedFor: missing})
			continue
		}
		if onStart != nil {
			onStart(item)
		}
		// The declaring file's directory as cwd, so file: scripts and
		// relative paths behave the same wherever the tool was invoked.
		exit, err := e.runner.Inherit(e.frame.Command(item.Command, item.Origin))
		if err != nil {
			return outcomes, err
		}
		after, err := e.checker.Check(manifest.CheckFor(item.Program, &key))
		if err != nil {
			return outcomes, err
		}
		outcome := InstallOutcome{Program: item.Program, ExitCode: exit, StateAfter: after}
		failed[item.Program] = !outcome.Success()
		outcomes = append(outcomes, outcome)
	}
	return outcomes, nil
}

// bullets is lines as "  - line", one per line.
func bullets(lines []string) string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = "  - " + l
	}
	return strings.Join(out, "\n")
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
