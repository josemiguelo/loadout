package app

import (
	"math"
	"regexp"
	"slices"
	"sort"
	"sync"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/version"
)

// UpdateRow is one "something newer exists" row, shared by `outdated` and
// the home screen.
type UpdateRow struct {
	Name, Current, Candidate, Source string
	Note                             string
	// Link is a page about the change: the source printed a URL in its note tail.
	Link *string
}

// ToolUpdates is what one TOOL (dnf, brew, flatpak — grouped by probe, so
// brew formulae and casks are one line) has to offer, declared or not. The
// doctor's view: an upgrade is the whole tool, so this is what ticking it
// means.
type ToolUpdates struct {
	Tool string
	// Installers is the mechanisms behind it that this machine maps (dnf, dnf-repo, dnf-copr).
	Installers []string
	// Total is every outdated package the tool reported.
	Total int
	// Declared is, of those, the ones in this machine's loadout (program names).
	Declared []string
	// Others is, of those, the ones loadout doesn't declare (package ids, as the tool named them).
	Others []string
	// Command is the sweep that upgrades all of it, when the mechanism declares one.
	Command *string
}

// SourceError is a custom source that exited non-zero, and why.
type SourceError struct{ Label, Reason string }

// OutdatedReport is everything one round of asking the remotes produced.
type OutdatedReport struct {
	Updates []UpdateRow
	// Tools is per tool, in installer declaration order — every tool that was
	// asked, clean ones included.
	Tools []ToolUpdates
	// Errors is the custom sources that exited non-zero, in declaration order.
	Errors []SourceError
	// Unchecked is the installed programs no oracle can answer for, in mapping order.
	Unchecked []string
}

// OutdatedReport asks every remote this machine's loadout resolves to.
// Shared by the `outdated` command and the home screen, so neither owns
// this logic twice — the home screen in particular must stay a dispatcher.
//
// freshSelfCheck asks GitHub for loadout's own release instead of the 6h
// cache: true for the explicit command, false for the screen that opens on
// every invocation.
func (a *AppContext) OutdatedReport(
	manifest model.Manifest,
	system coremodel.SystemInfo,
	observed coremodel.MachineState,
	freshSelfCheck bool,
) (OutdatedReport, error) {
	mapped := manifest.Machines.Value(system.Machine).PM

	// Only installed programs can be outdated; only variants whose installer
	// declares an oracle can be asked. An installer's batch oracle
	// (`outdated-all`) covers its programs with ONE command; per-program
	// oracles remain for explicit variant overrides.
	var oracles model.Map[model.VersionCheck]
	var batched model.Map[model.BatchOracle]
	var installed []string
	for name, key := range mapped.All() {
		if observed.Programs.Value(name).Status != coremodel.Installed {
			continue
		}
		installed = append(installed, name)
		resolved := manifest.ResolveInstall(name, key)
		if resolved.Outdated != nil {
			oracles.Set(name, *resolved.Outdated)
		}
		if resolved.OutdatedAll != nil {
			batched.Set(name, *resolved.OutdatedAll)
		}
	}
	var batchOracles model.Map[model.BatchOracle]
	for _, oracle := range batched.All() {
		batchOracles.Set(oracle.Installer, oracle)
	}
	var unchecked []string
	for _, name := range installed {
		if !oracles.Has(name) && !batched.Has(name) {
			unchecked = append(unchecked, name)
		}
	}

	frame, err := a.Frame(system)
	if err != nil {
		return OutdatedReport{}, err
	}
	checker := engine.NewUpdateChecker(a.Runner, frame)
	var (
		wg                          sync.WaitGroup
		perProgram                  model.Map[*string]
		batchResults                model.Map[model.Map[string]]
		sourceResults               model.Map[engine.SourceResult]
		perErr, batchErr, sourceErr error
	)
	wg.Add(3)
	go func() { defer wg.Done(); batchResults, batchErr = checker.BatchAll(batchOracles) }()
	go func() { defer wg.Done(); perProgram, perErr = checker.Candidates(oracles) }()
	go func() { defer wg.Done(); sourceResults, sourceErr = checker.SourcesAll(manifest.Outdated) }()
	wg.Wait()
	for _, err := range []error{perErr, batchErr, sourceErr} {
		if err != nil {
			return OutdatedReport{}, err
		}
	}
	candidates := perProgram.Clone()
	for name, oracle := range batched.All() {
		var candidate *string
		if raw, ok := batchResults.Value(oracle.Installer).Get(oracle.Pkg); ok {
			if re, err := regexp.Compile(oracle.Regex); err == nil {
				if m := re.FindStringSubmatch(raw); len(m) > 1 {
					candidate = &m[1]
				}
			}
		}
		candidates.Set(name, candidate)
	}
	currentOf := func(name string) *string { return observed.Programs.Value(name).Version }
	newer := func(candidate, current *string) bool {
		return candidate != nil && (current == nil || *candidate != *current)
	}

	var rows []UpdateRow
	// The tool itself is a program too.
	if latest := BehindRelease(a.Runner, !freshSelfCheck); latest != "" {
		rows = append(rows, UpdateRow{Name: "loadout", Current: version.Version, Candidate: latest, Source: "release"})
	}
	for label, res := range sourceResults.All() {
		for _, r := range res.Rows {
			rows = append(rows, UpdateRow{r.Name, r.Current, r.Candidate, label, r.Note, r.Link})
		}
	}
	// Custom sources that failed (non-zero exit): surfaced loud so a broken
	// oracle can never masquerade as "nothing outdated". Declaration order.
	var errors []SourceError
	for _, label := range manifest.Outdated.Keys() {
		if res, ok := sourceResults.Get(label); ok && res.Error != nil {
			errors = append(errors, SourceError{label, *res.Error})
		}
	}
	for name, candidate := range candidates.All() {
		current := currentOf(name)
		if newer(candidate, current) {
			shown := "?"
			if current != nil {
				shown = *current
			}
			rows = append(rows, UpdateRow{Name: name, Current: shown, Candidate: *candidate, Source: mapped.Value(name)})
		}
	}

	// The whole picture per tool: the batch oracle already listed every
	// outdated package; keep the count and the undeclared names instead of
	// throwing them away. Mechanisms sharing a probe are one tool.
	installerOrder := map[string]int{}
	for i, k := range manifest.Installers.Keys() {
		installerOrder[k] = i
	}
	orderOf := func(installer string) int {
		if i, ok := installerOrder[installer]; ok {
			return i
		}
		return math.MaxInt
	}
	var byTool model.Map[[]string]
	for _, installer := range batchOracles.Keys() {
		tool := installer
		if probe := manifest.Installers.Value(installer).Probe; probe != nil {
			tool = *probe
		}
		byTool.Set(tool, append(byTool.Value(tool), installer))
	}
	var tools []ToolUpdates
	for tool, installers := range byTool.All() {
		reported := map[string]bool{}
		for _, installer := range installers {
			for _, pkg := range batchResults.Value(installer).Keys() {
				reported[pkg] = true
			}
		}
		declaredPkgs := map[string]bool{}
		var declared []string
		for name, oracle := range batched.All() {
			if !slices.Contains(installers, oracle.Installer) {
				continue
			}
			declaredPkgs[oracle.Pkg] = true
			if newer(candidates.Value(name), currentOf(name)) {
				declared = append(declared, name)
			}
		}
		sort.Strings(declared)
		// "Not in your loadout" means not declared at all — a declared
		// package the tool listed but that isn't newer stays out of it.
		var others []string
		for pkg := range reported {
			if !declaredPkgs[pkg] {
				others = append(others, pkg)
			}
		}
		sort.Strings(others)
		var command *string
		for _, installer := range installers {
			if upgrade := manifest.Installers.Value(installer).Upgrade; upgrade != nil {
				// What runs, not the manifest's file: shorthand.
				expanded := model.ExpandFilePrefix(*upgrade)
				command = &expanded
				break
			}
		}
		sorted := slices.Clone(installers)
		sort.SliceStable(sorted, func(i, j int) bool { return orderOf(sorted[i]) < orderOf(sorted[j]) })
		tools = append(tools, ToolUpdates{tool, sorted, len(reported), declared, others, command})
	}
	minOrder := func(t ToolUpdates) int {
		least := math.MaxInt
		for _, installer := range t.Installers {
			least = min(least, orderOf(installer))
		}
		return least
	}
	sort.SliceStable(tools, func(i, j int) bool { return minOrder(tools[i]) < minOrder(tools[j]) })

	// Order: program rows grouped by installer DECLARATION order (list native
	// pms first in your installers fragment), then the self row, then custom
	// oracles in their declaration order. No pm knowledge here — the repo's
	// own ordering is the ordering.
	oracleOrder := map[string]int{}
	for i, k := range manifest.Outdated.Keys() {
		oracleOrder[k] = i
	}
	installerOf := func(program string) (string, bool) {
		key := mapped.Value(program)
		variant, ok := manifest.Programs.Value(program).Install.Get(key)
		if ok && variant.Installer != nil {
			return *variant.Installer, true
		}
		return key, manifest.Installers.Has(key)
	}
	rank := func(row UpdateRow) (int, int) {
		if row.Source == "release" {
			return 1, 0
		}
		if i, ok := oracleOrder[row.Source]; ok {
			return 2, i
		}
		if installer, ok := installerOf(row.Name); ok {
			return 0, orderOf(installer)
		}
		return 0, math.MaxInt
	}
	sort.SliceStable(rows, func(i, j int) bool {
		a1, a2 := rank(rows[i])
		b1, b2 := rank(rows[j])
		if a1 != b1 {
			return a1 < b1
		}
		if a2 != b2 {
			return a2 < b2
		}
		return rows[i].Name < rows[j].Name
	})
	return OutdatedReport{Updates: rows, Tools: tools, Errors: errors, Unchecked: unchecked}, nil
}
