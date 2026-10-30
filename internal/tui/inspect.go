package tui

import (
	"errors"
	"strconv"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/diff"
)

// Inspector is the main pane's detail view of one program, script or
// config: what `explain` says about it, this machine's last observation and
// every machine's from the fleet.
type Inspector struct {
	Name string
	// Items is explain's answer for Name (a program or script, and a config
	// of the same name); Err is why there is none.
	Items []app.Explained
	Err   string
	// Machine is this machine's last verdict, as label/value rows.
	Machine []app.ExplainRow
	// Fleet is every machine's verdict from the state files.
	Fleet []app.ExplainRow
	// Scroll is the first line shown.
	Scroll int
}

// inspect opens the inspector on the row under the main pane's cursor.
func (m *HomeModel) inspect() {
	name := m.inspectable()
	if name == "" {
		m.hey("i inspects a program, a script or a config")
		return
	}
	in := &Inspector{Name: name}
	if m.explain == nil {
		in.Err = "nothing to explain without a repo"
	} else {
		explained, err := m.explain([]string{name})
		var unknown *app.NoSuchItemError
		switch {
		case errors.As(err, &unknown):
			in.Err = unknown.Message
		case err != nil:
			in.Err = firstLine(err.Error())
		}
		for _, named := range explained {
			in.Items = append(in.Items, named.Items...)
		}
	}
	in.Machine = m.machineRows(name)
	in.Fleet = fleetRows(m.state.Fleet, name)
	m.state.Inspect = in
	m.state.Filtering = false
}

// inspectable is the name of the program, script or config under the main
// pane's cursor ("" when it is none: a tool, a source's item).
func (m *HomeModel) inspectable() string {
	s := m.state
	items := listOf(s, s.subject())
	at := snap(items, s.Cursors[s.subject()])
	if at < 0 {
		return ""
	}
	row := items[at].Index
	switch s.subject() {
	case SubjectPrograms:
		return s.Programs[row].Name
	case SubjectScripts:
		return s.Scripts[row].Name
	case SubjectConfigs:
		return s.Configs[row].Name
	case SubjectFleet:
		return driftedRows(s)[row].Name()
	case SubjectRemote:
		if answered, ok := s.Remote.(*Answered); ok {
			if l := remoteLines(answered, s.Collapsed)[row]; l.Kind == RemoteProgram {
				return l.Row.Name
			}
		}
	}
	return ""
}

// machineRows is this machine's last verdict on name, from the rows on screen.
func (m *HomeModel) machineRows(name string) []app.ExplainRow {
	var rows []app.ExplainRow
	s := m.state
	for _, p := range s.Programs {
		if p.Name == name {
			status := string(p.Status)
			if status == "" {
				status = "not observed yet"
			}
			if p.Version != "" {
				status += " " + p.Version
			}
			rows = append(rows, app.ExplainRow{Label: "program", Value: status})
			if p.Status == coremodel.Missing {
				rows = append(rows, app.ExplainRow{Label: "installs via", Value: p.InstallKey})
			}
		}
	}
	for _, r := range s.Scripts {
		if r.Name == name {
			status := string(r.Status)
			if status == "" {
				status = "not observed yet"
			}
			rows = append(rows, app.ExplainRow{Label: "script", Value: status})
			if r.Command != "" {
				rows = append(rows, app.ExplainRow{Label: "runs", Value: r.Command})
			}
		}
	}
	for _, c := range s.Configs {
		if c.Name == name {
			status := string(c.Status)
			if status == "" {
				status = "not observed yet"
			}
			rows = append(rows, app.ExplainRow{Label: "config", Value: status})
			for i, f := range c.Files {
				label := ""
				if i == 0 {
					label = "would change"
				}
				rows = append(rows, app.ExplainRow{Label: label, Value: f})
			}
		}
	}
	if answered, ok := s.Remote.(*Answered); ok {
		for _, u := range answered.Updates {
			if u.Name == name && !answered.isSource(u.Source) {
				rows = append(rows, app.ExplainRow{Label: "update", Value: u.Current + " → " + u.Candidate})
			}
		}
	}
	return rows
}

// fleetRows is every machine's verdict on name, from the fleet comparison.
func fleetRows(fleet *diff.DiffReport, name string) []app.ExplainRow {
	if fleet == nil {
		return nil
	}
	var rows []app.ExplainRow
	for _, row := range fleet.Rows {
		if row.Program != name {
			continue
		}
		for _, machine := range fleet.Machines {
			cell := "not installed there"
			if state, ok := row.PerMachine.Get(machine); ok {
				switch state.Kind {
				case diff.Installed:
					cell = "installed"
					if state.Version != nil {
						cell = *state.Version
					}
				case diff.Missing:
					cell = "missing"
				default:
					cell = "unknown"
				}
			}
			rows = append(rows, app.ExplainRow{Label: machine, Value: cell})
		}
		switch {
		case row.Incomplete():
			rows = append(rows, app.ExplainRow{Label: "verdict", Value: "missing somewhere"})
		case row.Drift():
			rows = append(rows, app.ExplainRow{Label: "verdict", Value: "versions differ"})
		default:
			rows = append(rows, app.ExplainRow{Label: "verdict", Value: "in sync"})
		}
	}
	for _, row := range fleet.Configs {
		if row.Unit != name {
			continue
		}
		for _, machine := range fleet.Machines {
			cell := "-"
			if state, ok := row.PerMachine.Get(machine); ok {
				switch state.Kind {
				case diff.ConfigApplied:
					cell = "applied"
				case diff.ConfigDrifted:
					cell = "drifted (" + strconv.Itoa(state.Files) + ")"
				default:
					cell = "not checked"
				}
			}
			rows = append(rows, app.ExplainRow{Label: machine + " (config)", Value: cell})
		}
	}
	return rows
}
