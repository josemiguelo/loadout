package tui

import (
	"fmt"
	"image/color"
	"strconv"
	"strings"

	"charm.land/bubbles/v2/key"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/diff"
	"github.com/josemiguelo/loadout/internal/tui/style"
	"github.com/josemiguelo/loadout/internal/version"
)

// The side-by-side layout needs this many columns (width only: a wide but
// short window keeps it); under it the screen is stacked, one page at a
// time (user decision).
const (
	wideMinWidth = 100
	sidebarWidth = 32
	// logoRows is the sidebar brand's height (style.SidebarLogo).
	logoRows = 1
	// sidebarGap is the gutter between the sidebar and the main pane.
	sidebarGap = 3
	// panelShare is the run panel's share of the main pane (percent), and
	// panelMin its fewest rows.
	panelShare = 45
	panelMin   = 10
)

// layout is where everything sits on a w × h screen. Rows are absolute;
// the main pane's columns start at mainX.
type layout struct {
	w, h int
	// wide is side by side; otherwise stacked: the breadcrumb and its rule
	// (rows 0, 1), then one page — home, the subject or the run — full width.
	wide         bool
	mainX, mainW int
	sideX        int
	// pageY is the first row under the stacked layout's header (0 when wide).
	pageY                  int
	titleY, filterY, headY int
	listY, listH           int
	// panelY is the run panel's title row; panelH counts it (0: no panel).
	panelY, panelH int
	statusY        int
}

// termSize is the run panel's emulator size.
func (l layout) termSize() (int, int) { return max(l.mainW, 10), max(l.panelH-1, 3) }

func (m *HomeModel) layout(panel bool) layout {
	return layoutOf(m.width, m.height, panel, m.state.Maximized)
}

func layoutOf(w, h int, panel, maximized bool) layout {
	w, h = max(w, 40), max(h, 12)
	l := layout{w: w, h: h, wide: w >= wideMinWidth, mainX: 1, statusY: h - 1}
	if l.wide {
		// The sidebar is on the left, the main pane right of it.
		l.sideX = 1
		l.mainX = 1 + sidebarWidth + sidebarGap
		l.mainW = w - 2 - sidebarWidth - sidebarGap
		l.titleY, l.filterY, l.headY, l.listY = 0, 2, 3, 4
	} else {
		l.mainW = w - 2
		l.pageY = 2
		l.titleY, l.filterY, l.headY, l.listY = 2, 3, 4, 5
	}
	l.listH = l.statusY - l.listY
	switch {
	case panel && !l.wide:
		// The run page: the panel fills it; the list keeps its own page.
		l.panelY, l.panelH = l.titleY, l.statusY-l.titleY
	case panel:
		if maximized {
			l.panelY, l.panelH, l.listH = l.titleY, l.statusY-l.titleY, 0
		} else {
			l.panelH = max((l.statusY-l.titleY)*panelShare/100, panelMin)
			l.panelH = max(min(l.panelH, l.statusY-l.listY-1-3), 4)
			l.panelY = l.statusY - l.panelH
			l.listH = max(l.panelY-1-l.listY, 0)
		}
	}
	return l
}

// screenLines is the whole frame: exactly height rows of width cells.
// frame is the busy clock's.
func (m *HomeModel) screenLines(frame int) []string {
	t := m.theme()
	l := m.layout(m.shown != nil)
	var out []string
	if l.wide {
		out = m.wideLines(t, l, frame)
	} else {
		out = m.stackedLines(t, l, frame)
	}
	// A notification floats at the bottom right, over the screen and above
	// the help line, which stays; a dialog sits over it.
	if card := m.toasts.Card(t, l.w-2); len(card) > 0 {
		out = style.Overlay(out, card, l.w-style.Width(card[0])-1, l.statusY-len(card))
	}
	if d := m.state.Dialog; d != nil {
		if lines := m.dialogLines(t, *d, l, frame); len(lines) > 0 {
			out = style.Center(out, lines, l.w, l.h)
		}
	}
	return out
}

// wideLines is the side-by-side frame: the sidebar, its rule, the main pane.
func (m *HomeModel) wideLines(t style.Theme, l layout, frame int) []string {
	main := m.mainLines(t, l, frame)
	side := m.sideWindow(m.sideLines(t, sidebarWidth, frame, true), l.statusY, true)
	blank := strings.Repeat(" ", l.w)
	// The areas are told apart by rules (user decision): a vertical one in
	// the gutter between the sidebar and the main pane, and, with the run
	// panel, a horizontal one above it that meets it in a ├.
	gutter := " " + style.Divider(t, "│") + " "
	rule := -1
	if m.shown != nil && !m.state.Maximized && l.panelH > 0 && l.panelY-1 > l.titleY {
		rule = l.panelY - 1
		main[rule] = style.Divider(t, strings.Repeat("─", l.mainW))
	}
	out := make([]string, l.h)
	for y := range l.h {
		switch {
		case y == l.statusY:
			out[y] = m.statusLine(t, l.w)
		default:
			g := gutter
			if y == rule {
				g = " " + style.Divider(t, "├─")
			}
			out[y] = " " + style.Fit(at(side, y), sidebarWidth) + "\x1b[m" + g + style.Fit(at(main, y), l.mainW) + "\x1b[m "
		}
		if out[y] == "" {
			out[y] = blank
		}
	}
	return out
}

// page is what the stacked layout shows: one page, the focused area's.
type page int

const (
	// pageHome is the sidebar's content, full width.
	pageHome page = iota
	// pageSubject is the main pane: the subject's list, or the inspector.
	pageSubject
	// pageRun is the run panel, the whole page.
	pageRun
)

// page is the focused area's page.
func (m *HomeModel) page() page {
	switch {
	case m.state.Focus == FocusSidebar:
		return pageHome
	case m.state.Focus == FocusTerminal && m.shown != nil:
		return pageRun
	}
	return pageSubject
}

// stacked says the screen shows one page at a time (narrower than wideMinWidth).
func (m *HomeModel) stacked() bool { return !m.layout(false).wide }

// stackedLines is the stacked frame: the breadcrumb, a rule under it, then
// the focused area's page, full width.
func (m *HomeModel) stackedLines(t style.Theme, l layout, frame int) []string {
	var body []string
	switch m.page() {
	case pageHome:
		body = make([]string, l.pageY, l.statusY)
		body = append(body, m.sideWindow(m.sideLines(t, l.mainW, frame, false), l.statusY-l.pageY, false)...)
	case pageRun:
		body = make([]string, l.statusY)
		m.panelLines(t, l, frame, body)
	default:
		body = m.mainLines(t, l, frame)
	}
	out := make([]string, l.h)
	for y := range l.h {
		switch y {
		case l.statusY:
			out[y] = m.statusLine(t, l.w)
		case 0:
			out[y] = " " + style.Fit(m.breadcrumb(t, l.mainW), l.mainW) + "\x1b[m "
		case 1:
			out[y] = " " + style.Divider(t, strings.Repeat("─", l.mainW)) + " "
		default:
			out[y] = " " + style.Fit(at(body, y), l.mainW) + "\x1b[m "
		}
	}
	return out
}

// breadcrumb is the stacked layout's header: where you are, the verdict
// counts, and a run going on behind the page shown.
func (m *HomeModel) breadcrumb(t style.Theme, width int) string {
	s := m.state
	var crumbs []string
	subject := ""
	if section, ok := s.section(); ok {
		subject = section.Subject
	}
	switch m.page() {
	case pageHome:
		crumbs = []string{s.Machine}
	case pageRun:
		// Where it came from: the Runs list on the home page, or a subject.
		if s.RunFromSidebar {
			crumbs = []string{s.Machine, "run"}
		} else {
			crumbs = []string{subject, "run"}
		}
	default:
		crumbs = []string{subject}
		if s.Inspect != nil {
			crumbs = append(crumbs, "inspect", s.Inspect.Name)
		}
	}
	var right []string
	if m.active != nil && m.page() != pageRun {
		right = append(right, style.Fg(t.Busy, style.GlyphRunning+" "+m.active.Label))
	}
	settled, open := m.verdictCounts()
	right = append(right, style.Fg(t.Success, fmt.Sprintf("%s%d", style.GlyphCheck, settled))+" "+style.Fg(t.Warning, fmt.Sprintf("%s%d", style.GlyphDot, open)))
	return style.Breadcrumb(t, crumbs, right, width)
}

// verdictCounts is how many subjects are settled and how many have work.
func (m *HomeModel) verdictCounts() (settled, open int) {
	for _, section := range m.state.Sections {
		switch {
		case section.Neutral:
		case section.Severity == Settled:
			settled++
		default:
			open++
		}
	}
	return settled, open
}

// sideWindow is the sidebar's lines from the first one height rows can
// show with the selected entry in view (a short window, or many runs).
func (m *HomeModel) sideWindow(lines []string, height int, logo bool) []string {
	return lines[m.sideOffset(len(lines), height, logo):]
}

// sideOffset is the sidebar's first line shown in height rows.
func (m *HomeModel) sideOffset(total, height int, logo bool) int {
	s := m.state
	selected := sideHead(logo) + s.Subject
	if s.SideRun >= 0 {
		selected = sideHead(logo) + len(s.Sections) + 3 + s.SideRun
	}
	return min(max(selected-height+1, 0), max(total-height, 0))
}

// sideHead is how many lines come before the sidebar's first subject:
// (brand, blank,) machine, system, blank, section header, blank.
func sideHead(logo bool) int {
	if logo {
		return logoRows + 1 + 5
	}
	return 5
}

func at(lines []string, y int) string {
	if y >= 0 && y < len(lines) {
		return lines[y]
	}
	return ""
}

// ---------------------------------------------------------------- main pane

var subjectTitles = map[string]string{
	SubjectPrograms: "Programs", SubjectScripts: "Scripts", SubjectConfigs: "Configs",
	SubjectRemote: "Remote", SubjectFleet: "Fleet",
}

// mainLines is the main pane, rows 0 to the status bar, each mainW wide.
func (m *HomeModel) mainLines(t style.Theme, l layout, frame int) []string {
	s := m.state
	lines := make([]string, l.statusY)
	section, ok := s.section()
	if !ok {
		return lines
	}
	if l.wide && s.Maximized && m.shown != nil {
		m.panelLines(t, l, frame, lines)
		return lines
	}
	title, info := subjectTitles[section.Subject], section.Summary
	switch {
	case s.Inspect != nil:
		title, info = "Inspect", s.Inspect.Name
	case section.Busy:
		info = style.BusyLabel(t, frame, "checking…")
	}
	switch s.Focus {
	case FocusMain:
		lines[l.titleY] = style.TitleRowFocused(t, title, info, l.mainW)
	default:
		lines[l.titleY] = style.TitleRowMuted(t, title, info, l.mainW)
	}
	if s.Inspect != nil {
		body := m.inspectorLines(t, *s.Inspect, l.mainW)
		height := l.listY + l.listH - l.filterY
		scroll := min(s.Inspect.Scroll, max(len(body)-height, 0))
		for i := range height {
			lines[l.filterY+i] = at(body, scroll+i)
		}
	} else {
		lines[l.filterY] = m.filterLine(t, section.Subject, l.mainW)
		if section.Subject == SubjectFleet {
			lines[l.headY] = m.fleetHeader(t, l.mainW-1)
		}
		m.listLines(t, l, section, frame, lines)
	}
	// Stacked, the run panel has its own page.
	if l.wide && m.shown != nil {
		m.panelLines(t, l, frame, lines)
	}
	return lines
}

// filterLine is the filter input: `> query` while typing, a hint otherwise.
func (m *HomeModel) filterLine(t style.Theme, subject string, width int) string {
	query := m.state.Filters[subject]
	prompt := style.Fg(t.Primary, "> ")
	switch {
	case m.state.Filtering:
		return prompt + style.Fg(t.FgBase, query) + style.Fg(t.Primary, "▏")
	case query != "":
		return prompt + style.Fg(t.FgSubtle, query) + style.Fg(t.FgMostSubtle, "  esc clears")
	}
	return style.Fg(t.FgMostSubtle, "> filter")
}

// listLines draws the subject's list (and its scrollbar) into lines.
func (m *HomeModel) listLines(t style.Theme, l layout, section HomeSection, frame int, lines []string) {
	s := m.state
	if l.listH <= 0 {
		return
	}
	items := listOf(s, section.Subject)
	if len(items) == 0 {
		lines[l.listY] = " " + m.emptyLine(t, section, frame)
		return
	}
	cursor := snap(items, s.Cursors[section.Subject])
	offset := min(max(s.Offsets[section.Subject], 0), max(len(items)-l.listH, 0))
	if cursor >= 0 {
		offset = min(offset, cursor)
		offset = max(offset, cursor-l.listH+1)
	}
	bar := style.Scrollbar(t, l.listH, len(items), l.listH, offset)
	width := l.mainW - 1
	ctx := m.rowContext(width)
	for i := range l.listH {
		row := ""
		if n := offset + i; n < len(items) {
			focus := style.Unselected
			if n == cursor {
				focus = style.SelectedBlurred
				if s.Focus == FocusMain {
					focus = style.SelectedFocused
				}
			}
			row = m.itemRow(t, section.Subject, items[n], focus, width, ctx)
		}
		lines[l.listY+i] = style.Fit(row, width) + at(bar, i)
	}
}

// emptyLine is what an empty list says.
func (m *HomeModel) emptyLine(t style.Theme, section HomeSection, frame int) string {
	s := m.state
	switch {
	case section.Busy:
		return style.BusyLabel(t, frame, "checking…")
	case section.Subject == SubjectRemote:
		switch r := s.Remote.(type) {
		case Unavailable:
			return style.Fg(t.Error, "unavailable — "+r.Reason) + style.Fg(t.FgMostSubtle, " · r asks again")
		case nil:
			return style.Fg(t.FgMostSubtle, "not asked yet — r asks")
		}
	case s.Filters[section.Subject] != "":
		return style.Fg(t.FgMostSubtle, "nothing matches — esc clears the filter")
	}
	return style.None(t)
}

// rowContext is what every row of a list lines up on, measured once a
// frame from ALL its rows, not just the visible ones.
type rowContext struct {
	name, current, candidate int
	fleetName, fleetColumn   int
}

func (m *HomeModel) rowContext(width int) rowContext {
	s := m.state
	var c rowContext
	longest := func(names []string, fallback, limit int) int {
		n := fallback
		for _, name := range names {
			n = max(n, runes(name))
		}
		return min(n, limit)
	}
	switch s.subject() {
	case SubjectPrograms:
		c.name = longest(mapNames(s.Programs, func(p ProgramRow) string { return p.Name }), 8, 28) + 2
	case SubjectScripts:
		c.name = longest(mapNames(s.Scripts, func(r ScriptRow) string { return r.Name }), 8, 28) + 2
	case SubjectConfigs:
		c.name = longest(mapNames(s.Configs, func(r ConfigItem) string { return r.Name }), 8, 28) + 2
	case SubjectRemote:
		if answered, ok := s.Remote.(*Answered); ok {
			// Versions get the room the terminal has: long java/sha strings
			// fit on a wide one and are clipped (head first) on a narrow one.
			versionCap := 14
			if width >= 100 {
				versionCap = 24
			}
			c.name = longest(mapNames(answered.Updates, func(r app.UpdateRow) string { return r.Name }), 8, 26) + 2
			c.current = longest(mapNames(answered.Updates, func(r app.UpdateRow) string { return r.Current }), 1, versionCap) + 1
			c.candidate = longest(mapNames(answered.Updates, func(r app.UpdateRow) string { return r.Candidate }), 1, versionCap) + 1
		}
	case SubjectFleet:
		c.fleetName = longest(mapNames(driftedRows(s), FleetLine.Name), 8, 26) + 2
		c.fleetColumn = 8
		if s.Fleet != nil && len(s.Fleet.Machines) > 0 {
			machines := s.Fleet.Machines
			c.fleetColumn = max(min((width-4-c.fleetName)/len(machines), longest(machines, 6, 40)+2), 8)
		}
	}
	return c
}

// itemRow is one list row of subject.
func (m *HomeModel) itemRow(t style.Theme, subject string, item Item, focus style.Focus, width int, c rowContext) string {
	s := m.state
	name := func(fg color.Color) style.Span {
		return style.Span{Text: column(item.Name, c.name), Fg: fg, Matches: item.Matches}
	}
	sp := style.S
	switch subject {
	case SubjectPrograms:
		p := s.Programs[item.Index]
		tick := sp(" ", nil)
		glyph, right := style.StatusGlyph(t, style.StatusIdle), "not observed"
		switch p.Status {
		case coremodel.Missing:
			tick = style.Tick(t, s.Chosen[p.Name])
			glyph, right = style.StatusGlyph(t, style.StatusFailed), "missing · via "+p.InstallKey
		case coremodel.Installed:
			glyph, right = style.StatusGlyph(t, style.StatusOK), cutVersion(p.Version, 24)
			if p.Version == "" {
				right = "installed"
			}
		case coremodel.Unknown:
			glyph, right = style.StatusGlyph(t, style.StatusAttention), "not checked"
		}
		return style.ListRow(t, []style.Span{tick, sp(" ", nil), glyph, sp(" ", nil), name(nil)}, []style.Span{sp(right, nil)}, focus, width)
	case SubjectScripts:
		r := s.Scripts[item.Index]
		glyph, verdict := scriptGlyph(t, r.Status)
		return style.ListRow(t, []style.Span{style.Tick(t, s.Picked[r.Name]), sp(" ", nil), glyph, sp(" ", nil), name(nil),
			sp(r.Description, t.FgMostSubtle)}, []style.Span{sp(verdict, nil)}, focus, width)
	case SubjectConfigs:
		r := s.Configs[item.Index]
		glyph, verdict := configGlyph(t, r.Status)
		return style.ListRow(t, []style.Span{style.Tick(t, s.Applying[r.Name]), sp(" ", nil), glyph, sp(" ", nil), name(nil),
			sp(strings.Join(r.Files, ", "), t.FgMostSubtle)}, []style.Span{sp(verdict, nil)}, focus, width)
	case SubjectFleet:
		return m.fleetRow(t, driftedRows(s)[item.Index], item, focus, width, c)
	case SubjectRemote:
		answered, _ := s.Remote.(*Answered)
		if answered == nil {
			return ""
		}
		return m.remoteRow(t, remoteLines(answered, s.Collapsed)[item.Index], item, focus, width, c)
	}
	return ""
}

func scriptGlyph(t style.Theme, status coremodel.ScriptStatus) (style.Span, string) {
	switch status {
	case coremodel.Done:
		return style.StatusGlyph(t, style.StatusOK), "done"
	case coremodel.Pending:
		return style.StatusGlyph(t, style.StatusPending), "pending"
	case coremodel.Failed:
		return style.StatusGlyph(t, style.StatusFailed), "failed"
	}
	return style.StatusGlyph(t, style.StatusIdle), "not observed"
}

func configGlyph(t style.Theme, status coremodel.ConfigStatus) (style.Span, string) {
	switch status {
	case coremodel.ConfigApplied:
		return style.StatusGlyph(t, style.StatusOK), "applied"
	case coremodel.ConfigDrifted:
		return style.StatusGlyph(t, style.StatusPending), "drifted"
	case coremodel.ConfigUnknown:
		return style.StatusGlyph(t, style.StatusAttention), "not checked"
	}
	return style.StatusGlyph(t, style.StatusIdle), "not observed"
}

// cutVersion keeps a version's tail: versions differ at the END
// ("adoptopenjdk-21.0.6+7" vs "…21.0.8+9"), so one that can't fit loses its
// head.
func cutVersion(text string, width int) string {
	r := []rune(text)
	if len(r) <= width || width < 2 {
		return text
	}
	return "…" + string(r[len(r)-(width-1):])
}

// remoteRow is one line of the remote tree, grouped by what will ACT: a
// tool with everything it reported (ticking it means all of them), its
// declared programs under it, a note for what else it would move; then
// each custom source with its items, which tick alone.
func (m *HomeModel) remoteRow(t style.Theme, line RemoteLine, item Item, focus style.Focus, width int, c rowContext) string {
	s := m.state
	sp := style.S
	tick := func(key string) style.Span {
		if key == "" {
			return sp("–", t.FgMostSubtle)
		}
		return style.Tick(t, s.Selection[key])
	}
	fold := func() style.Span {
		// Only a group that hides something when folded shows a fold mark.
		if !line.Foldable {
			return sp(" ", nil)
		}
		return style.Fold(t, !s.Collapsed[line.Group])
	}
	name := style.Span{Text: item.Name, Matches: item.Matches, Bold: line.Heading()}
	switch line.Kind {
	case RemoteTool:
		tool := line.Info
		updates := "? updates"
		if tool.Total != nil {
			updates = fmt.Sprintf("%d update%s", *tool.Total, plural(*tool.Total))
		}
		what, fg := "", t.Warning
		switch {
		case tool.Total == nil:
			what = fmt.Sprintf("%d in your loadout · others unknown", len(tool.Declared))
		case *tool.Total == 0:
			what, fg = "up to date", t.SuccessSubtle
		case len(tool.Declared) == 0:
			what = updates + " · none in your loadout"
		default:
			what = fmt.Sprintf("%s · %d in your loadout", updates, len(tool.Declared))
		}
		command := ""
		if tool.Command != nil {
			command = *tool.Command
		}
		return style.ListRow(t, []style.Span{fold(), sp(" ", nil), tick(line.Key), sp(" ", nil), name, sp("  ", nil), sp(what, fg)},
			[]style.Span{sp(command, nil)}, focus, width)
	case RemoteProgram, RemoteItem:
		row := line.Row
		lead := []style.Span{sp("    ", nil)}
		if line.Kind == RemoteItem {
			lead = []style.Span{sp("  ", nil), tick(line.Key), sp(" ", nil)}
		}
		name.Text = column(item.Name, c.name)
		note := row.Note
		if row.Link != nil {
			note = strings.TrimSpace(note + " ↗")
		}
		return style.ListRow(t, append(lead, sp(style.GlyphUp+" ", t.Warning), name,
			sp(style.Fit(cutVersion(row.Current, c.current-1), c.current), t.FgMoreSubtle),
			sp(style.GlyphArrow+" ", t.FgMostSubtle), sp(cutVersion(row.Candidate, c.candidate-1), t.Warning)),
			[]style.Span{sp(note, nil)}, focus, width)
	case RemoteOthers:
		return style.ListRow(t, []style.Span{sp("    ", nil),
			sp(fmt.Sprintf("%s %d more not in your loadout · enter lists them", style.GlyphMore, len(line.Names)), t.Warning)}, nil, focus, width)
	case RemoteSource:
		box := sp("–", t.FgMostSubtle)
		if len(line.ItemKeys) > 0 {
			box = style.Tick(t, containsAll(s.Selection, line.ItemKeys))
		}
		return style.ListRow(t, []style.Span{fold(), sp(" ", nil), box, sp(" ", nil), name}, nil, focus, width)
	}
	return ""
}

// fleetHeader is the fleet table's heading: which machine each column is.
func (m *HomeModel) fleetHeader(t style.Theme, width int) string {
	s := m.state
	if s.Fleet == nil || len(driftedRows(s)) == 0 {
		return ""
	}
	c := m.rowContext(width)
	line := strings.Repeat(" ", 1+2+c.fleetName)
	for _, machine := range s.Fleet.Machines {
		fg := t.FgMoreSubtle
		if machine == s.Machine {
			fg = t.Secondary
		}
		line += style.Fg(fg, style.Fit(style.Truncate(machine, c.fleetColumn-1), c.fleetColumn))
	}
	return line
}

// fleetRow is one drifting program or config, machines as columns.
func (m *HomeModel) fleetRow(t style.Theme, line FleetLine, item Item, focus style.Focus, width int, c rowContext) string {
	s := m.state
	spans := []style.Span{}
	// A missing install is severe; version drift and a drifted config are not.
	if line.Program != nil && line.Program.Incomplete() {
		spans = append(spans, style.StatusGlyph(t, style.StatusFailed))
	} else {
		spans = append(spans, style.StatusGlyph(t, style.StatusPending))
	}
	spans = append(spans, style.S(" ", nil), style.Span{Text: column(item.Name, c.fleetName), Matches: item.Matches})
	for _, machine := range s.Fleet.Machines {
		cell, fg := "-", t.FgMostSubtle
		if line.Program != nil {
			state := line.Program.PerMachine.Value(machine)
			switch state.Kind {
			case diff.Installed:
				cell, fg = "ok", t.FgBase
				if state.Version != nil {
					cell = *state.Version
				}
			case diff.Missing:
				cell, fg = "missing", t.Error
			}
		} else {
			state := line.Config.PerMachine.Value(machine)
			switch state.Kind {
			case diff.ConfigApplied:
				cell, fg = "applied", t.FgBase
			case diff.ConfigDrifted:
				cell, fg = "drifted ("+strconv.Itoa(state.Files)+")", t.Warning
			}
		}
		spans = append(spans, style.S(style.Fit(cutVersion(cell, c.fleetColumn-1), c.fleetColumn), fg))
	}
	return style.ListRow(t, spans, nil, focus, width)
}

// inspectorLines is the inspector's body: explain's sections, then this
// machine's verdict and the fleet's.
func (m *HomeModel) inspectorLines(t style.Theme, in Inspector, width int) []string {
	var out []string
	rows := func(rows []ExplainRowView) {
		labelW := 0
		for _, r := range rows {
			labelW = max(labelW, runes(r.Label))
		}
		labelW = min(labelW, 24)
		valueW := max(width-labelW-4, 10)
		for _, r := range rows {
			wrapped := wrapWords(r.Value, valueW)
			if len(wrapped) == 0 {
				wrapped = []string{""}
			}
			for i, v := range wrapped {
				label := ""
				if i == 0 {
					label = r.Label
				}
				line := "  " + style.Fg(t.FgMoreSubtle, style.Fit(label, labelW)) + "  " + style.Fg(t.FgBase, v)
				if i == len(wrapped)-1 && r.Mine != "" {
					line += style.Fg(t.Secondary, "  ← "+r.Mine)
				}
				out = append(out, line)
			}
		}
	}
	if in.Err != "" {
		out = append(out, " "+style.Fg(t.Error, in.Err), "")
	}
	for _, item := range in.Items {
		head := " " + style.Fg(t.Primary, item.Kind) + " " + style.Span{Text: item.Name, Fg: t.FgBase, Bold: true}.Render(t)
		if item.Description != "" && item.Kind != "config" {
			head += style.Fg(t.FgMostSubtle, "  — "+item.Description)
		}
		out = append(out, head, "")
		folder := item.Folder
		if folder == "" {
			folder = "the repo's root"
		}
		view := []ExplainRowView{{Label: "declared in", Value: folder}}
		for _, r := range item.Rows {
			view = append(view, ExplainRowView{Label: r.Label, Value: r.Value, Mine: r.Machine})
		}
		rows(view)
		for _, note := range item.Notes {
			out = append(out, "  "+style.Fg(t.Warning, note))
		}
		out = append(out, "")
	}
	section := func(title string, r []ExplainRowView) {
		out = append(out, style.Section(t, title, "", width), "")
		if len(r) == 0 {
			out = append(out, "  "+style.None(t))
		}
		rows(r)
		out = append(out, "")
	}
	section("This machine", viewRows(in.Machine))
	section("Fleet", viewRows(in.Fleet))
	return out
}

// ExplainRowView is a label/value row as the inspector draws it.
type ExplainRowView struct{ Label, Value, Mine string }

func viewRows(rows []app.ExplainRow) []ExplainRowView {
	out := make([]ExplainRowView, len(rows))
	for i, r := range rows {
		out[i] = ExplainRowView{Label: r.Label, Value: r.Value}
	}
	return out
}

// panelLines draws the run panel into lines: its title row (the command,
// and how it's going) and the emulator.
func (m *HomeModel) panelLines(t style.Theme, l layout, frame int, lines []string) {
	r := m.shown
	if r == nil || l.panelH <= 0 {
		return
	}
	var info string
	switch r.status() {
	case "running":
		info = r.Command + " " + style.Fg(t.Busy, style.GlyphRunning+" "+r.duration(m.now()))
	case "done":
		info = r.Command + " " + style.Fg(t.SuccessSubtle, style.GlyphCheck+" done "+r.duration(m.now()))
	case "interrupted":
		info = r.Command + " " + style.Fg(t.Attention, "interrupted")
	default:
		info = r.Command + " " + style.Fg(t.Error, fmt.Sprintf("%s exit %d", style.GlyphCross, r.Code))
	}
	if r.term != nil && r.term.Scrolled() > 0 {
		info = style.Fg(t.FgMostSubtle, fmt.Sprintf("↑%d ", r.term.Scrolled())) + info
	}
	if m.state.Focus == FocusTerminal {
		lines[l.panelY] = style.TitleRowFocused(t, "Run", info, l.mainW)
	} else {
		lines[l.panelY] = style.TitleRowMuted(t, "Run", info, l.mainW)
	}
	if r.term == nil {
		return
	}
	for i, row := range strings.Split(r.term.View(), "\n") {
		if y := l.panelY + 1 + i; y < l.statusY && i < l.panelH-1 {
			lines[y] = row + "\x1b[m"
		}
	}
}

// ---------------------------------------------------------------- sidebar

// sideLines is the sidebar (without logo: the stacked home page), each
// width wide.
func (m *HomeModel) sideLines(t style.Theme, width, frame int, logo bool) []string {
	s := m.state
	var out []string
	if logo {
		out = append(out, style.SidebarLogo(t, version.Version, width)...)
		out = append(out, "")
	}
	out = append(out, style.Fg(t.FgMoreSubtle, style.Truncate(s.Machine, width)),
		style.Fg(t.FgMostSubtle, style.Truncate(s.System, width)), "")
	out = append(out, style.Section(t, "Machine", "", width), "")
	for i, section := range s.Sections {
		focus := style.Unselected
		if i == s.Subject && s.SideRun < 0 {
			focus = style.SelectedBlurred
			if s.Focus == FocusSidebar {
				focus = style.SelectedFocused
			}
		}
		out = append(out, style.SubjectRow(t, m.sectionGlyph(t, section, frame), section.Subject, section.Short, focus, width))
	}
	out = append(out, "", style.Section(t, "Runs", "", width), "")
	runs := m.runsNewestFirst()
	if len(runs) == 0 {
		out = append(out, "  "+style.None(t))
	}
	for i, r := range runs {
		focus := style.Unselected
		if i == s.SideRun {
			focus = style.SelectedBlurred
			if s.Focus == FocusSidebar {
				focus = style.SelectedFocused
			}
		}
		var glyph string
		summary := r.duration(m.now())
		switch r.status() {
		case "running":
			glyph = style.StatusGlyph(t, style.StatusRunning).Render(t)
		case "done":
			glyph = style.StatusGlyph(t, style.StatusDone).Render(t)
		case "interrupted":
			glyph = style.StatusGlyph(t, style.StatusInterrupted).Render(t)
			summary = "interrupted"
		default:
			glyph = style.StatusGlyph(t, style.StatusFailed).Render(t)
			summary = fmt.Sprintf("exit %d", r.Code)
		}
		out = append(out, style.SubjectRow(t, glyph, r.Label, summary, focus, width))
	}
	return out
}

// sectionGlyph is a subject's status glyph, or its busy frame.
func (m *HomeModel) sectionGlyph(t style.Theme, section HomeSection, frame int) string {
	switch {
	case section.Busy:
		return style.BusyGlyph(t, frame)
	case section.Neutral:
		return style.StatusGlyph(t, style.StatusIdle).Render(t)
	case section.Severity == Settled:
		return style.StatusGlyph(t, style.StatusOK).Render(t)
	case section.Severity == Attention:
		return style.StatusGlyph(t, style.StatusPending).Render(t)
	}
	return style.StatusGlyph(t, style.StatusFailed).Render(t)
}

// ---------------------------------------------------------------- status bar

func hb(keys, desc string) key.Binding {
	return key.NewBinding(key.WithKeys(keys), key.WithHelp(keys, desc))
}

// statusLine is the last row: a toast, or the focused area's keys.
func (m *HomeModel) statusLine(t style.Theme, width int) string {
	return style.Fit(style.HelpLine(t, m.shortHelp(), width), width)
}

// shortHelp is the keys the focused area answers to.
func (m *HomeModel) shortHelp() []key.Binding {
	s := m.state
	if d := s.Dialog; d != nil {
		switch d.Kind {
		case DialogConfirm:
			return []key.Binding{hb("←→", "choose"), hb("enter", "press"), hb("y", "run"), hb("esc", "cancel")}
		case DialogPalette:
			return []key.Binding{hb("↑↓", "choose"), hb("enter", "run"), hb("esc", "close")}
		}
		return []key.Binding{hb("↑↓", "scroll"), hb("esc", "close")}
	}
	if s.Filtering {
		return []key.Binding{hb("type", "filter"), hb("↑↓", "move"), hb("enter", "keep"), hb("esc", "clear")}
	}
	stacked := m.stacked()
	switch s.Focus {
	case FocusTerminal:
		running := m.shown != nil && m.shown == m.active
		switch {
		case running && stacked:
			return []key.Binding{hb("ctrl+]", "back"), hb("ctrl+c", "interrupt"), hb("keys", "go to the command")}
		case running:
			return []key.Binding{hb("ctrl+]", "dashboard"), hb("ctrl+c", "interrupt"), hb("keys", "go to the command")}
		case stacked:
			return []key.Binding{hb("↑↓", "scroll"), hb("pgup/pgdn", "page"), hb("gg/G", "start/end"), hb("esc", "back"), hb("q", "quit")}
		}
		return []key.Binding{hb("↑↓", "scroll"), hb("pgup/pgdn", "page"), hb("gg/G", "start/end"), hb("z", "zoom"), hb("esc", "close"), hb("tab", "focus"), hb("q", "quit")}
	case FocusSidebar:
		if stacked {
			return []key.Binding{hb("↑↓", "subject"), hb("enter/l", "open"), hb("ctrl+p", "commands"), hb("ctrl+g", "help"), hb("q", "quit")}
		}
		if m.finishedPanel() {
			return []key.Binding{hb("↑↓", "subject"), hb("enter", "open the list"), hb("esc", "close run"), hb("tab", "focus"), hb("ctrl+p", "commands"), hb("ctrl+g", "help"), hb("q", "quit")}
		}
		return []key.Binding{hb("↑↓", "subject"), hb("enter/l", "open the list"), hb("tab", "focus"), hb("ctrl+p", "commands"), hb("ctrl+g", "help"), hb("q", "quit")}
	}
	if s.Inspect != nil {
		return []key.Binding{hb("↑↓", "scroll"), hb("esc", "back"), hb("ctrl+g", "help"), hb("q", "quit")}
	}
	verb := map[string]string{SubjectPrograms: "install", SubjectScripts: "run", SubjectConfigs: "apply", SubjectRemote: "upgrade"}[s.subject()]
	b := []key.Binding{hb("↑↓", "move")}
	switch {
	case stacked && s.Filters[s.subject()] == "":
		b = append(b, hb("esc", "back"))
	case !stacked && m.finishedPanel() && s.Filters[s.subject()] == "":
		b = append(b, hb("esc", "close run"))
	}
	if verb != "" {
		b = append(b, hb("space", "tick"), hb("a/u", "all/none"), hb("enter", verb))
	}
	if s.subject() == SubjectRemote {
		b = append(b, hb("h/l", "fold"), hb("K", "page"))
	}
	b = append(b, hb("/", "filter"), hb("i", "inspect"), hb("ctrl+p", "commands"), hb("ctrl+g", "help"), hb("q", "quit"))
	return b
}

// fullHelp is ctrl+g's groups. Stacked, one page shows: no areas to tab
// through, no run panel to zoom; esc and h go back a page.
func fullHelp(stacked bool) [][]key.Binding {
	move := hb("tab", "next area")
	run := hb("z", "zoom the run")
	if stacked {
		move = hb("esc h", "back a page")
		run = hb("enter l", "open a page")
	}
	return [][]key.Binding{
		{hb("↑↓ jk", "move"), hb("ctrl+d/u", "half page"), move, hb("1-5", "subject"), hb("/", "filter"), hb("i", "inspect"), hb("h/l", "fold, unfold"), hb("[ ]", "groups")},
		{hb("space", "tick"), hb("a / u", "all / none"), hb("enter", "act on the ticked rows"), hb("K", "open the row's page"), hb("r", "re-check"), hb("S", "sync"), hb("U", "upgrade loadout"), hb("C", "set up this machine")},
		{hb("ctrl+p", "commands"), hb("ctrl+]", "leave the terminal"), hb("ctrl+c", "interrupt the command"), run, hb("gg home / G end", "the run's start / end"), hb("t", "theme"), hb("q", "quit")},
	}
}

// ---------------------------------------------------------------- dialogs

var confirmTitles = map[int]string{0: "Upgrade", 1: "Run scripts", 2: "Install", 3: "Apply"}

// confirmIntro is a confirm dialog's first line.
func confirmIntro(d Dialog) string {
	if d.Title != "" {
		return "This runs:"
	}
	switch d.Pane {
	case 1:
		return "These scripts will run, in order:"
	case 2:
		return "These programs will install, in order:"
	case 3:
		return "These configs will be written from the repo:"
	}
	return "These will upgrade, in order:"
}

// dialogLines is the dialog d, framed, for the screen in l.
func (m *HomeModel) dialogLines(t style.Theme, d Dialog, l layout, frame int) []string {
	maxH := min(style.DialogMaxHeight, l.h-2)
	var dl style.Dialog
	switch d.Kind {
	case DialogConfirm:
		title := d.Title
		if title == "" {
			title = confirmTitles[int(d.Pane)]
		}
		limit := min(style.DialogWideMaxWidth, l.w-4) - 4
		longest := 0
		for _, item := range d.Items {
			longest = max(longest, runes(item.Name))
		}
		column := min(longest, 24) + 2
		// As wide as the longest row wants, between a readable minimum and the cap.
		width := runes(confirmIntro(d))
		for _, item := range d.Items {
			width = max(width, column+runes(item.Text)+len("  · enter lists them")+2)
		}
		width = min(max(width, 44), limit)
		var body []string
		for i, item := range d.Items {
			text := item.Text
			fg := t.FgMoreSubtle
			if len(item.List) > 0 {
				fg = t.Warning
				text += "  · enter lists them"
			}
			focus := style.Unselected
			if i == d.Row {
				focus = style.SelectedFocused
			}
			parts := wrapWords(text, max(width-column-2, 10))
			if len(parts) == 0 {
				parts = []string{""}
			}
			for j, part := range parts {
				label := ""
				if j == 0 {
					label = item.Name
				}
				body = append(body, style.ListRow(t, []style.Span{style.S(style.Fit(style.Truncate(label, column-1), column), t.FgBase), style.S(part, fg)}, nil, focus, width))
			}
		}
		dl = style.Dialog{Title: title, Info: fmt.Sprintf("%d step%s", len(d.Items), plural(len(d.Items))),
			Body:    append([]string{style.Fg(t.FgSubtle, confirmIntro(d)), ""}, scrolled(body, d.Scroll, maxH-10)...),
			Buttons: []string{"Run", "Cancel"}, Focused: map[bool]int{true: 1, false: 0}[d.CancelFocused],
			Help:  "←→ choose · enter press · y run · esc cancel",
			Width: width, MaxWidth: style.DialogWideMaxWidth}
	case DialogList:
		body := make([]string, len(d.Lines))
		for i, line := range d.Lines {
			body[i] = style.Fg(t.FgBase, line)
		}
		body = scrolled(body, d.Scroll, maxH-10)
		if d.Summary != "" {
			body = append(body, "", style.Fg(t.FgMostSubtle, d.Summary))
		}
		dl = style.Dialog{Title: d.Title, Info: fmt.Sprint(len(d.Lines)), Body: body, Buttons: []string{"Close"}, Focused: 0,
			Help: "↑↓ scroll · esc close"}
	case DialogPalette:
		width := min(56, l.w-8)
		shown, matches := paletteShown(m.state, d.Query)
		body := []string{style.Fg(t.Primary, "> ") + style.Fg(t.FgBase, d.Query) + style.Fg(t.Primary, "▏"), ""}
		// The window follows the cursor.
		visible := max(maxH-8, 3)
		first := max(d.Cursor-visible+1, 0)
		for i, e := range shown {
			if i < first || i >= first+visible {
				continue
			}
			focus := style.Unselected
			if i == d.Cursor {
				focus = style.SelectedFocused
			}
			body = append(body, style.ListRow(t, []style.Span{{Text: e.Title, Matches: matches[i]}}, []style.Span{style.S(e.Keys, t.FgMoreSubtle)}, focus, width))
		}
		if len(shown) == 0 {
			body = append(body, " "+style.None(t))
		}
		dl = style.Dialog{Title: "Commands", Body: body, Help: "↑↓ choose · enter run · esc close", Width: width}
	case DialogHelp:
		width := min(l.w-8, 96)
		body := strings.Split(style.FullHelp(t, fullHelp(!l.wide), width), "\n")
		dl = style.Dialog{Title: "Help", Body: scrolled(body, d.Scroll, maxH-6), Help: "esc close", Width: width, MaxWidth: 100}
	}
	return dl.Render(t, l.w, l.h)
}

// scrolled is lines from scroll on, at most height of them (height ≤ 0: all).
func scrolled(lines []string, scroll, height int) []string {
	if height <= 0 || len(lines) <= height {
		return lines
	}
	scroll = min(max(scroll, 0), len(lines)-height)
	out := append([]string{}, lines[scroll:scroll+height]...)
	if below := len(lines) - scroll - height; below > 0 {
		out[len(out)-1] = fmt.Sprintf("  ↓ %d more", below)
	}
	return out
}

// column is text in a column of width cells: cut with "…" so at least one
// space separates it from the next column, padded otherwise.
func column(text string, width int) string {
	return style.Fit(style.Truncate(text, width-1), width)
}
