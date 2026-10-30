package engine

import (
	"strings"
	"unicode"

	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/model"
)

// UpdateChecker runs installers' `outdated` commands: each prints the
// candidate version available from the remote source (nothing when up to
// date). Unlike a version check, the exit code is ignored — `dnf
// check-update` exits 100 exactly when updates exist — only the regex
// match matters.
type UpdateChecker struct {
	runner exec.ProcessRunner
	// frame is where manifest commands run and what they get (contract 5).
	frame exec.CommandFrame
}

// NewUpdateChecker is a checker running commands in frame.
func NewUpdateChecker(runner exec.ProcessRunner, frame exec.CommandFrame) *UpdateChecker {
	return &UpdateChecker{runner, frame}
}

// SourceRow is one row from a custom outdated source; Note is an optional
// annotation, Link a page about the change (a GitHub compare URL) when the
// source printed one in the tail.
type SourceRow struct {
	Name, Current, Candidate string
	Note                     string
	Link                     *string
}

// SourceResult is the outcome of running one custom source: parsed Rows on
// success, or an Error one-liner (exit code + last stderr line) when the
// command failed.
type SourceResult struct {
	Rows  []SourceRow
	Error *string
}

// Candidate is the version the remote offers, or nil for up to date / no answer.
func (u *UpdateChecker) Candidate(outdated model.VersionCheck) (*string, error) {
	if outdated.Regex == nil {
		return nil, nil
	}
	result, err := u.runner.Capture(u.frame.Command(model.ShellLine(outdated.Command, outdated.Path), outdated.Origin))
	if err != nil {
		return nil, err
	}
	return group1(*outdated.Regex, ifBlank(result.Stdout, result.Stderr)), nil
}

// Candidates checks all checks (program name -> outdated command) concurrently.
func (u *UpdateChecker) Candidates(checks model.Map[model.VersionCheck]) (model.Map[*string], error) {
	names := checks.Keys()
	out := make([]*string, len(names))
	errs := make([]error, len(names))
	forEach(len(names), parallelism, func(i int) { out[i], errs[i] = u.Candidate(checks.Value(names[i])) })
	return zip(names, out), firstError(errs)
}

// BatchCandidates runs one installer's batch oracle (`outdated-all`): every
// output line is `<pkg> <candidate text>` — the first whitespace-separated
// token is the package id, the rest is the text the per-program regex
// extracts the version from. Exit code ignored, like Candidate.
func (u *UpdateChecker) BatchCandidates(command, origin string, path []string) (model.Map[string], error) {
	result, err := u.runner.Capture(u.frame.Command(model.ShellLine(command, path), origin))
	if err != nil {
		return model.Map[string]{}, err
	}
	// stdout ONLY: an empty stdout is "nothing outdated", and a tool's
	// stderr is warnings — `brew outdated --cask` once turned a
	// deprecation notice into packages named "Warning:" and "Please".
	var out model.Map[string]
	for _, line := range lines(result.Stdout) {
		trimmed := strings.TrimSpace(line)
		split := strings.IndexFunc(trimmed, unicode.IsSpace)
		if split <= 0 {
			continue
		}
		out.Set(trimmed[:split], strings.TrimSpace(trimmed[split:]))
	}
	return out, nil
}

// BatchAll runs all batch oracles (installer name -> its oracle) concurrently.
func (u *UpdateChecker) BatchAll(oracles model.Map[model.BatchOracle]) (model.Map[model.Map[string]], error) {
	names := oracles.Keys()
	out := make([]model.Map[string], len(names))
	errs := make([]error, len(names))
	forEach(len(names), 0, func(i int) {
		o := oracles.Value(names[i])
		out[i], errs[i] = u.BatchCandidates(o.Command, o.Origin, o.Path)
	})
	return zip(names, out), firstError(errs)
}

// SourceRows runs one custom `outdated.<name>` source: each output line is
// `<item> <current> <candidate> [note...]` (whitespace-separated; the
// optional tail renders as a dim annotation, short lines are skipped).
//
// Unlike the installer oracles above (which ignore exit codes because `dnf
// check-update` exits 100 on updates), a custom source is a plain user
// script and MUST exit 0 when it ran fine — otherwise loadout can't tell a
// crashed source from one honestly reporting "nothing outdated", and a
// persistent failure would silently hide updates forever. So a non-zero
// exit is reported as SourceResult.Error (no rows trusted), which the CLI
// surfaces as a loud line instead of empty output.
func (u *UpdateChecker) SourceRows(command, origin string) (SourceResult, error) {
	result, err := u.runner.Capture(u.frame.Command(model.ExpandFilePrefix(command), origin))
	if err != nil {
		return SourceResult{}, err
	}
	if !result.Success() {
		message := "exited " + itoa(result.ExitCode)
		if detail := lastNonEmptyTrimmed(ifBlank(result.Stderr, result.Stdout)); detail != nil && *detail != "" {
			message += ": " + take(*detail, 200)
		}
		return SourceResult{Error: &message}, nil
	}
	var rows []SourceRow
	for _, line := range lines(ifBlank(result.Stdout, result.Stderr)) {
		tokens := strings.Fields(line)
		if len(tokens) < 3 {
			continue
		}
		// A URL in the tail is the row's LINK (the compare page for the two
		// shas, say), not part of the annotation.
		tail := tokens[3:]
		var link *string
		for _, t := range tail {
			if strings.HasPrefix(t, "https://") || strings.HasPrefix(t, "http://") {
				link = &t
				break
			}
		}
		var note []string
		for _, t := range tail {
			if link == nil || t != *link {
				note = append(note, t)
			}
		}
		rows = append(rows, SourceRow{tokens[0], tokens[1], tokens[2], strings.Join(note, " "), link})
	}
	return SourceResult{Rows: rows}, nil
}

// SourcesAll runs all custom sources (name -> source) concurrently.
func (u *UpdateChecker) SourcesAll(sources model.Map[model.OutdatedSource]) (model.Map[SourceResult], error) {
	names := sources.Keys()
	out := make([]SourceResult, len(names))
	errs := make([]error, len(names))
	forEach(len(names), 0, func(i int) {
		s := sources.Value(names[i])
		command := ""
		if s.Command != nil {
			command = *s.Command
		}
		out[i], errs[i] = u.SourceRows(command, s.Origin)
	})
	return zip(names, out), firstError(errs)
}

func zip[V any](names []string, values []V) model.Map[V] {
	var m model.Map[V]
	for i, n := range names {
		m.Set(n, values[i])
	}
	return m
}

// take is s's first n characters.
func take(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
