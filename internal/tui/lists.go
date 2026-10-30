package tui

import (
	"strings"
	"unicode"
)

// Subjects, as HomeSection.Subject names them: the keys of the per-subject
// cursors, offsets and filters.
const (
	SubjectPrograms = "programs"
	SubjectScripts  = "scripts"
	SubjectConfigs  = "configs"
	SubjectRemote   = "remote"
	SubjectFleet    = "fleet"
)

// Item is one row of the main pane's list, as both the cursor and the
// renderer see it: Index is the row in its subject's own list (Programs,
// Scripts, Configs, remoteLines, driftedRows).
type Item struct {
	Index int
	Name  string
	// Focusable says the row is a cursor stop (the remote tree's gaps are not).
	Focusable bool
	// Heading says the row heads a group (a remote tool or source): what
	// `[`/`]` jump between.
	Heading bool
	// Matches is the rune positions in Name the filter matched.
	Matches []int
}

// subject is the subject the main pane shows ("" when there is none yet).
func (s HomeState) subject() string {
	if s.Subject < 0 || s.Subject >= len(s.Sections) {
		return ""
	}
	return s.Sections[s.Subject].Subject
}

// section is the subject the main pane shows, as its section.
func (s HomeState) section() (HomeSection, bool) {
	if s.Subject < 0 || s.Subject >= len(s.Sections) {
		return HomeSection{}, false
	}
	return s.Sections[s.Subject], true
}

// listOf is subject's list as the main pane shows it, its filter applied.
func listOf(s HomeState, subject string) []Item {
	filter := s.Filters[subject]
	plain := func(names []string) []Item {
		var items []Item
		for i, name := range names {
			matches, ok := fuzzy(filter, name)
			if ok {
				items = append(items, Item{Index: i, Name: name, Focusable: true, Matches: matches})
			}
		}
		return items
	}
	switch subject {
	case SubjectPrograms:
		return plain(mapNames(s.Programs, func(p ProgramRow) string { return p.Name }))
	case SubjectScripts:
		return plain(mapNames(s.Scripts, func(r ScriptRow) string { return r.Name }))
	case SubjectConfigs:
		return plain(mapNames(s.Configs, func(c ConfigItem) string { return c.Name }))
	case SubjectFleet:
		return plain(mapNames(driftedRows(s), FleetLine.Name))
	case SubjectRemote:
		answered, ok := s.Remote.(*Answered)
		if !ok {
			return nil
		}
		lines := remoteLines(answered, s.Collapsed)
		if filter == "" {
			items := make([]Item, len(lines))
			for i, l := range lines {
				items[i] = Item{Index: i, Name: remoteName(l), Focusable: l.Focusable(), Heading: l.Heading()}
			}
			return items
		}
		// Filtered, the tree keeps a matching row's heading (so the row still
		// says what acts on it) and a matching heading's every row; gaps go.
		var items []Item
		headingMatched := false
		heading := -1
		headingShown := false
		for i, l := range lines {
			switch {
			case l.Kind == RemoteGap:
				continue
			case l.Heading():
				matches, ok := fuzzy(filter, remoteName(l))
				heading, headingMatched, headingShown = i, ok, ok
				if ok {
					items = append(items, Item{Index: i, Name: remoteName(l), Focusable: true, Heading: true, Matches: matches})
				}
			default:
				matches, ok := fuzzy(filter, remoteName(l))
				if !ok && !headingMatched {
					continue
				}
				if !headingShown && heading >= 0 {
					items = append(items, Item{Index: heading, Name: remoteName(lines[heading]), Focusable: true, Heading: true})
					headingShown = true
				}
				items = append(items, Item{Index: i, Name: remoteName(l), Focusable: true, Matches: matches})
			}
		}
		return items
	}
	return nil
}

// remoteName is what a remote line is called, for the filter.
func remoteName(l RemoteLine) string {
	switch l.Kind {
	case RemoteTool:
		return l.Info.Tool
	case RemoteProgram, RemoteItem:
		return l.Row.Name
	case RemoteSource:
		return l.Name
	}
	return ""
}

func mapNames[T any](rows []T, name func(T) string) []string {
	names := make([]string, len(rows))
	for i, r := range rows {
		names[i] = name(r)
	}
	return names
}

// fuzzy matches query against text as a case-insensitive subsequence,
// preferring the earliest match of each rune; it returns the matched rune
// positions. An empty query matches everything, with nothing underlined.
func fuzzy(query, text string) ([]int, bool) {
	if query == "" {
		return nil, true
	}
	q := []rune(strings.ToLower(query))
	var matches []int
	at := 0
	for i, r := range []rune(text) {
		if at < len(q) && unicode.ToLower(r) == q[at] {
			matches = append(matches, i)
			at++
		}
	}
	return matches, at == len(q)
}

// snap is the item the cursor really sits on: the nearest stop at or above
// cursor, else below (-1: nothing to stop on). Lists reshape under the
// cursor constantly — a refresh empties the missing programs, an upgrade
// clears a source — and a cursor left on nothing would highlight nothing.
func snap(items []Item, cursor int) int {
	if len(items) == 0 {
		return -1
	}
	at := min(max(cursor, 0), len(items)-1)
	for i := at; i >= 0; i-- {
		if items[i].Focusable {
			return i
		}
	}
	for i := at; i < len(items); i++ {
		if items[i].Focusable {
			return i
		}
	}
	return -1
}

// wrapWords is text broken at spaces into lines of at most width (a longer
// word gets a line of its own).
func wrapWords(text string, width int) []string {
	var lines []string
	line := ""
	for _, word := range strings.Split(text, " ") {
		switch {
		case line == "":
			line = word
		case runes(line)+1+runes(word) <= width:
			line += " " + word
		default:
			lines = append(lines, line)
			line = word
		}
	}
	if line != "" {
		lines = append(lines, line)
	}
	return lines
}
