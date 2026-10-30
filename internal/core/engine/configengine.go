package engine

import (
	"errors"
	"slices"
	"strings"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/model"
)

// ConfigUnit is one config unit and the targets chezmoi manages in it, relative to the destination.
type ConfigUnit struct {
	Name    string
	Targets []string
}

// ConfigEntry is one line of `chezmoi status`, Target relative to the
// destination. Drifted: `apply` would change it (the second column).
// Edited: it changed since chezmoi last wrote it (the first column).
type ConfigEntry struct {
	Target  string
	Edited  bool
	Drifted bool
}

// ConfigSource is one chezmoi source directory; Label is what a refusal
// calls its repo ("this repo", "parent dotfiles").
type ConfigSource struct {
	Dir   string
	Label string
}

// ConfigEngine is the repo's dotfiles as loadout sees them, through
// chezmoi, with `layout configs` as its source directory. A unit is a
// top-level config: `.config/<name>` is `<name>`, anything else its first
// path segment (`.zshenv`, `.local`). Units come from chezmoi's own list,
// so `.chezmoiignore` decides what exists; nothing is opted in. Only the
// command ApplyCommand builds changes anything.
//
// A child repo (contract 18) has two sources, its parent's and its own, in
// that order: a unit may span both, and a target both manage is refused
// (one file, one repo). chezmoi runs with env (`LOADOUT_REPO`,
// `LOADOUT_MACHINE`), so templates see the machine loadout runs as.
type ConfigEngine struct {
	runner     exec.ProcessRunner
	sources    []ConfigSource
	env        map[string]string
	lastReason *string
}

// NewConfigEngine is chezmoi over sources (a source without a Label is "this repo"), run with env.
func NewConfigEngine(runner exec.ProcessRunner, sources []ConfigSource, env map[string]string) *ConfigEngine {
	sources = slices.Clone(sources)
	for i := range sources {
		if sources[i].Label == "" {
			sources[i].Label = "this repo"
		}
	}
	return &ConfigEngine{runner: runner, sources: sources, env: env}
}

// NewSingleConfigEngine is chezmoi over one source directory, this repo's.
func NewSingleConfigEngine(runner exec.ProcessRunner, sourceDir string) *ConfigEngine {
	return NewConfigEngine(runner, []ConfigSource{{Dir: sourceDir}}, nil)
}

// LastReason is why chezmoi couldn't answer during the last Observe, or nil.
func (c *ConfigEngine) LastReason() *string { return c.lastReason }

func chezmoi(source ConfigSource) string {
	return "chezmoi --source " + shellQuote(source.Dir) + " --no-pager"
}

type managedBy struct {
	source  ConfigSource
	targets []string
}

// managed is each source's managed targets, in source order.
func (c *ConfigEngine) managed() ([]managedBy, error) {
	var out []managedBy
	for _, source := range c.sources {
		text, err := c.ask(source, "managed --include files,symlinks")
		if err != nil {
			return nil, err
		}
		var targets []string
		for _, line := range lines(text) {
			if !isBlank(line) {
				targets = append(targets, line)
			}
		}
		out = append(out, managedBy{source, targets})
	}
	return out, nil
}

// overlaps is the targets more than one source manages, with the sources' labels.
func overlaps(managed []managedBy) model.Map[[]string] {
	var labels model.Map[[]string]
	for _, m := range managed {
		for _, t := range m.targets {
			labels.Set(t, append(labels.Value(t), m.source.Label))
		}
	}
	var out model.Map[[]string]
	for t, l := range labels.All() {
		if len(l) > 1 {
			out.Set(t, l)
		}
	}
	return out
}

// Units is the units chezmoi manages, sorted by name; a unit spanning sources is one unit.
func (c *ConfigEngine) Units() ([]ConfigUnit, error) {
	managed, err := c.managed()
	if err != nil {
		return nil, err
	}
	var targets []string
	for _, m := range managed {
		targets = append(targets, m.targets...)
	}
	var byUnit model.Map[[]string]
	for _, t := range model.Distinct(targets) {
		byUnit.Set(UnitOf(t), append(byUnit.Value(UnitOf(t)), t))
	}
	var units []ConfigUnit
	for name, ts := range byUnit.Sorted().All() {
		units = append(units, ConfigUnit{name, slices.Sorted(slices.Values(ts))})
	}
	return units, nil
}

// Entries is every target `chezmoi status` reports, over every source.
func (c *ConfigEngine) Entries() ([]ConfigEntry, error) {
	var entries []ConfigEntry
	for _, source := range c.sources {
		text, err := c.ask(source, "status --include files,symlinks")
		if err != nil {
			return nil, err
		}
		for _, line := range lines(text) {
			if len(line) > 3 {
				entries = append(entries, ConfigEntry{line[3:], line[0] != ' ', line[1] != ' '})
			}
		}
	}
	return entries, nil
}

// Edited is the targets apply would change that also changed since chezmoi
// last wrote them: `apply` asks before overwriting those, so they need a
// decision. Limited to targets when not nil.
func (c *ConfigEngine) Edited(targets []string) ([]string, error) {
	entries, err := c.Entries()
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if e.Edited && e.Drifted && (targets == nil || slices.Contains(targets, e.Target)) {
			out = append(out, e.Target)
		}
	}
	slices.Sort(out)
	return out, nil
}

// Observe observes every unit: Applied when nothing in it would change on
// apply, else Drifted with those files. When chezmoi can't answer, the
// units last seen in previous are Unknown with the reason (also LastReason).
func (c *ConfigEngine) Observe(previous model.Map[coremodel.ConfigState]) (model.Map[coremodel.ConfigState], error) {
	c.lastReason = nil
	managed, err := c.managed()
	var entries []ConfigEntry
	if err == nil {
		entries, err = c.Entries()
	}
	var refusal *ConfigException
	if errors.As(err, &refusal) {
		reason := refusal.Message
		c.lastReason = &reason
		var out model.Map[coremodel.ConfigState]
		for _, name := range slices.Sorted(slices.Values(previous.Keys())) {
			out.Set(name, coremodel.ConfigState{Status: coremodel.ConfigUnknown, Reason: &reason})
		}
		return out, nil
	}
	if err != nil {
		return model.Map[coremodel.ConfigState]{}, err
	}
	var names []string
	for _, m := range managed {
		for _, t := range m.targets {
			names = append(names, UnitOf(t))
		}
	}
	drifted := map[string][]string{}
	for _, e := range entries {
		if e.Drifted {
			unit := UnitOf(e.Target)
			if _, seen := drifted[unit]; !seen {
				names = append(names, unit)
			}
			drifted[unit] = append(drifted[unit], e.Target)
		}
	}
	// The first clash of each unit, by target.
	overlapping := overlaps(managed)
	clashes := map[string]string{}
	for _, target := range overlapping.Keys() {
		unit := UnitOf(target)
		if first, seen := clashes[unit]; !seen || target < first {
			clashes[unit] = target
		}
	}
	names = model.Distinct(names)
	slices.Sort(names)
	var out model.Map[coremodel.ConfigState]
	for _, name := range names {
		files := model.Distinct(drifted[name])
		slices.Sort(files)
		switch clash, ok := clashes[name]; {
		case ok:
			reason := clashMessage(clash, overlapping.Value(clash))
			out.Set(name, coremodel.ConfigState{Status: coremodel.ConfigUnknown, Reason: &reason})
		case len(files) == 0:
			out.Set(name, coremodel.ConfigState{Status: coremodel.ConfigApplied})
		default:
			out.Set(name, coremodel.ConfigState{Status: coremodel.ConfigDrifted, Files: files})
		}
	}
	return out, nil
}

// ApplyCommand is `chezmoi apply` for targets (nil = everything), without a
// terminal: it fails instead of asking. force overwrites files edited in place.
func (c *ConfigEngine) ApplyCommand(targets []string, force bool) (exec.ShellCommand, error) {
	flags := " apply --no-tty"
	if force {
		flags += " --force"
	}
	if len(c.sources) == 1 {
		paths := ""
		if targets != nil {
			var err error
			if paths, err = c.paths(c.sources[0], targets); err != nil {
				return exec.ShellCommand{}, err
			}
		}
		return exec.ShellCommand{Line: chezmoi(c.sources[0]) + flags + paths, Env: c.env}, nil
	}
	// Each source applies its own targets, the parent's first.
	managed, err := c.managed()
	if err != nil {
		return exec.ShellCommand{}, err
	}
	var first string
	var firstLabels []string
	for target, labels := range overlaps(managed).All() {
		if (targets == nil || slices.Contains(targets, target)) && (first == "" || target < first) {
			first, firstLabels = target, labels
		}
	}
	if first != "" {
		return exec.ShellCommand{}, &ConfigException{clashMessage(first, firstLabels)}
	}
	var lines []string
	for _, m := range managed {
		if targets == nil {
			lines = append(lines, chezmoi(m.source)+flags)
			continue
		}
		var mine []string
		for _, t := range targets {
			if slices.Contains(m.targets, t) {
				mine = append(mine, t)
			}
		}
		if len(mine) == 0 {
			continue
		}
		paths, err := c.paths(m.source, mine)
		if err != nil {
			return exec.ShellCommand{}, err
		}
		lines = append(lines, chezmoi(m.source)+flags+paths)
	}
	if len(lines) == 0 {
		lines = []string{"true"}
	}
	return exec.ShellCommand{Line: strings.Join(lines, " && "), Env: c.env}, nil
}

func (c *ConfigEngine) paths(source ConfigSource, targets []string) (string, error) {
	destination, err := c.ask(source, "target-path")
	if err != nil {
		return "", err
	}
	destination = strings.TrimSpace(destination)
	var b strings.Builder
	for _, t := range targets {
		b.WriteString(" " + shellQuote(destination+"/"+t))
	}
	return b.String(), nil
}

func clashMessage(target string, labels []string) string {
	return target + " is managed by " + strings.Join(labels, " and ") + " — a file belongs to one repo"
}

func (c *ConfigEngine) ask(source ConfigSource, args string) (string, error) {
	result, err := c.runner.Capture(exec.ShellCommand{Line: chezmoi(source) + " " + args, Env: c.env})
	if err != nil {
		return "", err
	}
	if result.Success() {
		return result.Stdout, nil
	}
	if result.ExitCode == 127 {
		return "", &ConfigException{"chezmoi is not on PATH"}
	}
	line := "exit " + itoa(result.ExitCode)
	for _, l := range append(lines(result.Stderr), lines(result.Stdout)...) {
		if !isBlank(l) {
			line = strings.TrimSpace(l)
			break
		}
	}
	if !strings.HasPrefix(line, "chezmoi") {
		line = "chezmoi: " + line
	}
	return "", &ConfigException{line}
}

// UnitOf is the unit a target belongs to: `.config/<name>/…` is `<name>`, else the first segment.
func UnitOf(target string) string {
	parts := strings.Split(target, "/")
	if parts[0] == ".config" && len(parts) >= 2 {
		return parts[1]
	}
	return parts[0]
}
