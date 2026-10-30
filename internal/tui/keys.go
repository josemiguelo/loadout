package tui

import (
	"cmp"
	"fmt"
	"slices"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/tui/style"
)

// HomeKey is a key the screen answers to.
type HomeKey int

const (
	KeyUp HomeKey = iota
	KeyDown
	KeyPageUp
	KeyPageDown
	// KeyHalfUp and KeyHalfDown are ctrl+u / ctrl+d: half a page, as in vim and less.
	KeyHalfUp
	KeyHalfDown
	KeyPrevHeading
	KeyNextHeading
	KeyEnter
	// KeyOpen is l/→: unfold, or go into the main pane.
	KeyOpen
	// KeyClose is h/←: fold, or back to the sidebar.
	KeyClose
	KeyEsc
	KeySelect
	KeySelectAll
	KeySelectNone
	KeyOpenLink
	KeyRefresh
	KeySync
	KeyUpgrade
	KeyConverge
	KeyTheme
	KeyQuit
	KeyTab
	KeyShiftTab
	// Dialog buttons, gum's keys: y/n press one.
	KeyYes
	KeyNo
	KeyFilter
	KeyInspect
	KeyPalette
	KeyHelp
	// KeyLeave is ctrl+]: out of the terminal, back to the main pane.
	KeyLeave
	// KeyInterrupt is ctrl+c outside the terminal.
	KeyInterrupt
	// KeyZoom is z: the run panel takes the whole main pane, or not.
	KeyZoom
	// KeyTop and KeyBottom are home / end (and G): a finished run's output
	// from its start, or its end. KeyG is g: twice in a row (gg) is KeyTop,
	// as in vim and less.
	KeyTop
	KeyBottom
	KeyG
	KeyBackspace
	KeySubject1
	KeySubject2
	KeySubject3
	KeySubject4
	KeySubject5
)

// DialogKind is what a dialog is.
type DialogKind int

const (
	// DialogConfirm asks before a run: Run / Cancel.
	DialogConfirm DialogKind = iota
	// DialogList only lists (the "N more not in your loadout" packages, the
	// files a refusal names): Close.
	DialogList
	// DialogPalette is ctrl+p's command palette.
	DialogPalette
	// DialogHelp is ctrl+g's full help.
	DialogHelp
)

// Dialog is the overlay up: it owns the keyboard.
type Dialog struct {
	Kind DialogKind
	// Pane is a confirm's kind of command (it picks the title and intro).
	Pane app.PaneKind
	// Title is a list's or a machine-wide confirm's own title.
	Title string
	// Items is a confirm's rows, in run order: what acts and what that means.
	// Never the commands: the run panel shows them.
	Items []PaneItem
	// Lines and Summary are a list's lines and its note under them.
	Lines   []string
	Summary string
	// Scroll is the first body line shown.
	Scroll int
	// CancelFocused says a confirm's focused button is Cancel, not Run.
	CancelFocused bool
	// Row is a confirm's selected row (-1: none, enter presses the button).
	Row int
	// Closed is what a confirm runs on yes.
	Closed app.Closed
	// Query and Cursor are the palette's filter and selected entry.
	Query  string
	Cursor int
	// Parent is the dialog a list opened from comes back on close.
	Parent *Dialog
}

// asking says the dialog asks a question (Run/Cancel).
func (d Dialog) asking() bool { return d.Kind == DialogConfirm }

// paletteEntry is one command in the palette.
type paletteEntry struct {
	Title, Keys string
	Key         HomeKey
}

// paletteEntries is the palette's commands for s, in order.
func paletteEntries(s HomeState) []paletteEntry {
	entries := []paletteEntry{
		{"Re-check this machine", "r", KeyRefresh},
		{"Sync", "S", KeySync},
		{"Upgrade loadout", "U", KeyUpgrade},
		{"Set up this machine", "C", KeyConverge},
		{"Toggle theme", "t", KeyTheme},
	}
	for i, section := range s.Sections {
		if i < 5 {
			entries = append(entries, paletteEntry{"Go to " + section.Subject, fmt.Sprint(i + 1), KeySubject1 + HomeKey(i)})
		}
	}
	return append(entries,
		paletteEntry{"Inspect the selected row", "i", KeyInspect},
		paletteEntry{"Filter the list", "/", KeyFilter},
		paletteEntry{"Help", "ctrl+g", KeyHelp},
		paletteEntry{"Quit", "q", KeyQuit},
	)
}

// paletteShown is the palette's entries its query keeps, with the matches.
func paletteShown(s HomeState, query string) ([]paletteEntry, [][]int) {
	var shown []paletteEntry
	var matches [][]int
	for _, e := range paletteEntries(s) {
		if at, ok := fuzzy(query, e.Title); ok {
			shown = append(shown, e)
			matches = append(matches, at)
		}
	}
	return shown, matches
}

// ---------------------------------------------------------------- toasts

// say is a toast: what a key did, or why it did nothing.
func (m *HomeModel) say(kind style.ToastKind, message string) {
	m.cmds = append(m.cmds, m.toasts.Show(kind, message))
}

func (m *HomeModel) hey(message string)  { m.say(style.ToastHey, message) }
func (m *HomeModel) okay(message string) { m.say(style.ToastOK, message) }
func (m *HomeModel) warn(message string) { m.say(style.ToastWarning, message) }
func (m *HomeModel) fail(message string) { m.say(style.ToastError, message) }

// message is the toast showing ("" for none).
func (m *HomeModel) message() string {
	if !m.toasts.Active() {
		return ""
	}
	_, text := m.toasts.Message()
	return text
}

// ---------------------------------------------------------------- reducers

// handleKey is the reducer for one key (keys the terminal took never get here).
func (m *HomeModel) handleKey(k HomeKey) {
	// gg is two keys: any other key in between disarms the first g.
	if k != KeyG {
		m.gArmed = false
	}
	s := &m.state
	if s.Dialog != nil {
		m.dialogKey(k)
		return
	}
	if s.Filtering {
		m.filterKey(k)
		return
	}
	// Keys that mean the same in every area.
	switch k {
	case KeyPalette:
		s.Dialog = &Dialog{Kind: DialogPalette}
		return
	case KeyHelp:
		s.Dialog = &Dialog{Kind: DialogHelp}
		return
	case KeyTheme:
		m.toggleTheme()
		return
	case KeyQuit:
		if m.active != nil || m.waiting != nil {
			m.warn("a command is running — ctrl+c stops it, or wait")
		} else {
			s.Exit = true
		}
		return
	// Ctrl-C by reflex must not kill the screen: q quits. With a command
	// running, it stops the command, as in its terminal.
	case KeyInterrupt:
		if m.active != nil {
			m.interrupt()
		} else {
			m.hey("q quits")
		}
		return
	case KeySync:
		m.askMachine(app.ActionSync)
		return
	case KeyUpgrade:
		m.askMachine(app.ActionUpgrade)
		return
	case KeyConverge:
		m.askMachine(app.ActionSetup)
		return
	case KeyRefresh:
		if m.active != nil || m.waiting != nil {
			m.hey("checks wait for the command to finish")
		} else {
			m.refresh(true)
		}
		return
	// Stacked, one page shows: there is no other area to tab to.
	case KeyTab, KeyShiftTab:
		if !m.stacked() {
			m.cycleFocus(k == KeyTab)
		}
		return
	case KeyLeave:
		if s.Focus == FocusTerminal {
			s.Focus = FocusMain
			m.blurTerm()
		}
		return
	// Stacked, the run page is already the whole screen.
	case KeyZoom:
		if m.shown != nil && !m.stacked() {
			s.Maximized = !s.Maximized
			m.resizeTerms()
		}
		return
	}
	if k >= KeySubject1 && k <= KeySubject5 {
		if i := int(k - KeySubject1); i < len(s.Sections) {
			m.goSubject(i)
			// Stacked, the subject's page shows, from any page.
			if m.stacked() {
				m.focus(FocusMain)
			}
		}
		return
	}
	switch s.Focus {
	case FocusSidebar:
		m.sidebarKey(k)
	case FocusMain:
		m.mainKey(k)
	case FocusTerminal:
		m.terminalKey(k)
	}
}

// handleText is typed text while an input has the keyboard (the filter,
// the palette's query).
func (m *HomeModel) handleText(text string) {
	s := &m.state
	switch {
	case s.Dialog != nil && s.Dialog.Kind == DialogPalette:
		d := *s.Dialog
		d.Query += text
		d.Cursor = 0
		s.Dialog = &d
	case s.Filtering:
		subject := s.subject()
		s.Filters = withValue(s.Filters, subject, s.Filters[subject]+text)
		s.Cursors = withValue(s.Cursors, subject, 0)
		s.Offsets = withValue(s.Offsets, subject, 0)
	}
}

// typing says typed text goes to an input rather than to keys.
func (m *HomeModel) typing() bool {
	s := m.state
	return (s.Dialog != nil && s.Dialog.Kind == DialogPalette) || (s.Dialog == nil && s.Filtering)
}

func (m *HomeModel) toggleTheme() {
	m.state.Dark = !m.state.Dark
	t := m.theme()
	for _, r := range m.runs {
		if r.term != nil && !r.closed {
			r.term.SetColors(t.FgBase, t.BgBase)
		}
	}
}

// goSubject shows subject i in the main pane.
func (m *HomeModel) goSubject(i int) {
	s := &m.state
	if i != s.Subject {
		s.Inspect = nil
	}
	s.Subject = i
	s.SideRun = -1
}

// cycleFocus moves the focus to the next area (sidebar, main, terminal
// while the run panel shows), or the previous one.
func (m *HomeModel) cycleFocus(forward bool) {
	areas := []FocusArea{FocusSidebar, FocusMain}
	if m.shown != nil {
		areas = append(areas, FocusTerminal)
	}
	i := slices.Index(areas, m.state.Focus)
	if forward {
		i = (i + 1) % len(areas)
	} else {
		i = (i - 1 + len(areas)) % len(areas)
	}
	m.focus(areas[i])
}

func (m *HomeModel) focus(area FocusArea) {
	m.state.Focus = area
	if area == FocusTerminal && m.shown != nil && m.shown.term != nil {
		m.shown.term.Focus()
	} else {
		m.blurTerm()
	}
}

func (m *HomeModel) blurTerm() {
	if m.shown != nil && m.shown.term != nil {
		m.shown.term.Blur()
	}
}

// askMachine asks before a machine-wide verb: sync, upgrading loadout, set-up.
func (m *HomeModel) askMachine(action app.HomeAction) {
	if m.active != nil || m.waiting != nil {
		m.hey("a command is running — wait for it or ctrl+c it")
		return
	}
	d := &Dialog{Kind: DialogConfirm, Row: -1, Closed: app.Closed{Action: action}}
	switch action {
	case app.ActionSync:
		d.Title = "Sync"
		d.Items = []PaneItem{
			{Name: "pull", Text: "the config repo's latest (and its parent's)"},
			{Name: "apply", Text: "configs that changed"},
			{Name: "check", Text: "this machine's programs, scripts and configs"},
			{Name: "push", Text: "this machine's state, committed"},
		}
		if !m.withConfigs() {
			d.Items = slices.Delete(d.Items, 1, 2)
		}
	case app.ActionUpgrade:
		d.Title = "Upgrade loadout"
		d.Items = []PaneItem{{Name: "self-upgrade", Text: "installs the latest release; the screen ends afterwards"}}
	case app.ActionSetup:
		d.Title = "Set up"
		d.Items = []PaneItem{{Name: "setup-new-machine", Text: "installs what's missing and runs the setup scripts; it shows its plan and asks first"}}
	}
	m.state.Dialog = d
}

// ask asks before touching anything: these commands change the machine,
// and sweeps change more than the picked rows.
func (m *HomeModel) ask(handoff app.Handoff, items []PaneItem) {
	m.state.Dialog = &Dialog{Kind: DialogConfirm, Pane: handoff.Kind, Items: items, Row: -1,
		Closed: app.Closed{Action: app.ActionHandOff, Handoff: &handoff}}
}

// dialogKey is a key while a dialog is up.
func (m *HomeModel) dialogKey(k HomeKey) {
	s := &m.state
	d := *s.Dialog
	closeIt := func() { s.Dialog = d.Parent }
	page := max(m.height/2, 3)
	scroll := func(delta int) {
		d.Scroll = max(d.Scroll+delta, 0)
		s.Dialog = &d
	}
	switch d.Kind {
	case DialogConfirm:
		switch k {
		case KeyEsc, KeyQuit, KeyNo:
			s.Dialog = nil
		case KeyYes:
			m.confirm(d.Closed)
		case KeyEnter:
			switch {
			case d.Row >= 0 && d.Row < len(d.Items) && len(d.Items[d.Row].List) > 0:
				item := d.Items[d.Row]
				parent := d
				s.Dialog = &Dialog{Kind: DialogList, Title: "Not in your loadout", Lines: item.List,
					Summary: "These upgrade too.", Parent: &parent}
			case d.CancelFocused:
				s.Dialog = nil
			default:
				m.confirm(d.Closed)
			}
		case KeyOpen, KeyClose, KeyTab, KeyShiftTab:
			d.CancelFocused = !d.CancelFocused
			s.Dialog = &d
		case KeyUp, KeyDown:
			// Only list rows are stops: the others have nothing to open.
			var stops []int
			for i, item := range d.Items {
				if len(item.List) > 0 {
					stops = append(stops, i)
				}
			}
			if len(stops) == 0 {
				scroll(map[bool]int{true: -1, false: 1}[k == KeyUp])
				return
			}
			at := slices.Index(stops, d.Row)
			switch {
			case k == KeyDown && at < len(stops)-1:
				d.Row = stops[at+1]
			case k == KeyUp && at > 0:
				d.Row = stops[at-1]
			case k == KeyUp:
				d.Row = -1
			}
			s.Dialog = &d
		case KeyPageUp:
			scroll(-page)
		case KeyPageDown:
			scroll(page)
		case KeyTheme:
			m.toggleTheme()
		}
	case DialogList, DialogHelp:
		switch k {
		case KeyEsc, KeyQuit, KeyEnter, KeyNo, KeyYes:
			closeIt()
		case KeyHelp:
			if d.Kind == DialogHelp {
				closeIt()
			}
		case KeyUp:
			scroll(-1)
		case KeyDown:
			scroll(1)
		case KeyPageUp:
			scroll(-page)
		case KeyPageDown:
			scroll(page)
		case KeyTheme:
			m.toggleTheme()
		}
	case DialogPalette:
		shown, _ := paletteShown(*s, d.Query)
		switch k {
		case KeyEsc, KeyPalette:
			s.Dialog = nil
		case KeyUp:
			d.Cursor = max(d.Cursor-1, 0)
			s.Dialog = &d
		case KeyDown:
			d.Cursor = min(d.Cursor+1, max(len(shown)-1, 0))
			s.Dialog = &d
		case KeyBackspace:
			if r := []rune(d.Query); len(r) > 0 {
				d.Query = string(r[:len(r)-1])
				d.Cursor = 0
			}
			s.Dialog = &d
		case KeyEnter:
			s.Dialog = nil
			if d.Cursor < len(shown) {
				key := shown[d.Cursor].Key
				if key == KeyInspect || key == KeyFilter {
					m.focus(FocusMain)
				}
				m.handleKey(key)
			}
		}
	}
}

// filterKey is a key while the filter input has the keyboard: typing goes
// to handleText; the arrows still move the list.
func (m *HomeModel) filterKey(k HomeKey) {
	s := &m.state
	subject := s.subject()
	switch k {
	case KeyEsc:
		s.Filtering = false
		s.Filters = withValue(s.Filters, subject, "")
	case KeyEnter, KeyTab:
		s.Filtering = false
	case KeyBackspace:
		if r := []rune(s.Filters[subject]); len(r) > 0 {
			s.Filters = withValue(s.Filters, subject, string(r[:len(r)-1]))
			s.Cursors = withValue(s.Cursors, subject, 0)
		} else {
			s.Filtering = false
		}
	case KeyUp, KeyDown, KeyPageUp, KeyPageDown:
		m.mainKey(k)
	}
}

// sidebarKey is a key while the sidebar has the focus: the subjects, then
// this session's runs.
func (m *HomeModel) sidebarKey(k HomeKey) {
	s := &m.state
	runs := m.runsNewestFirst()
	switch k {
	case KeyUp:
		switch {
		case s.SideRun > 0:
			s.SideRun--
		case s.SideRun == 0:
			s.SideRun = -1
		case s.Subject > 0:
			m.goSubject(s.Subject - 1)
		}
	case KeyDown:
		switch {
		case s.SideRun >= 0:
			s.SideRun = min(s.SideRun+1, len(runs)-1)
		case s.Subject < len(s.Sections)-1:
			m.goSubject(s.Subject + 1)
		case len(runs) > 0:
			s.SideRun = 0
		}
	case KeyOpen:
		if s.SideRun >= 0 && s.SideRun < len(runs) {
			m.showRun(runs[s.SideRun])
			s.RunFromSidebar = true
			m.focus(FocusTerminal)
		} else {
			m.focus(FocusMain)
		}
	case KeyEnter:
		if s.SideRun >= 0 && s.SideRun < len(runs) {
			m.showRun(runs[s.SideRun])
			s.RunFromSidebar = true
			m.focus(FocusTerminal)
			return
		}
		// Enter on a subject goes INTO its list, like l: acting is the
		// list's enter, on what is ticked there (user decision) — never a
		// command started from a row whose ticks aren't in view.
		m.focus(FocusMain)
	case KeyEsc, KeyClose:
		if k == KeyEsc {
			// Stacked, the run panel isn't on the home page: nothing to close.
			if m.finishedPanel() && !m.stacked() {
				m.dismissRun()
			} else {
				m.hey("nothing to close — q quits")
			}
		}
	case KeySelect, KeySelectAll, KeySelectNone, KeyFilter, KeyInspect, KeyOpenLink:
		// They act on the main pane's list: go there and do it.
		if s.SideRun < 0 {
			m.focus(FocusMain)
			m.mainKey(k)
		}
	}
}

// terminalKey is a key on the run panel while its command isn't running
// (a running one takes every key but ctrl+]): scroll its output, or close it.
func (m *HomeModel) terminalKey(k HomeKey) {
	r := m.shown
	if r == nil || r.term == nil {
		m.focus(FocusMain)
		return
	}
	switch k {
	case KeyUp:
		r.term.ScrollUp(1)
	case KeyDown:
		r.term.ScrollDown(1)
	case KeyPageUp:
		r.term.PageUp()
	case KeyPageDown:
		r.term.PageDown()
	case KeyTop:
		r.term.Top()
	case KeyBottom:
		r.term.Bottom()
	case KeyG:
		if m.gArmed {
			r.term.Top()
		}
		m.gArmed = !m.gArmed
	case KeyHalfUp:
		_, h := r.term.Size()
		r.term.ScrollUp(max(h/2, 1))
	case KeyHalfDown:
		_, h := r.term.Size()
		r.term.ScrollDown(max(h/2, 1))
	case KeyEsc:
		m.dismissRun()
	case KeyClose:
		m.focus(m.backFromRun())
	}
}

// mainKey is a key while the main pane has the focus.
func (m *HomeModel) mainKey(k HomeKey) {
	s := &m.state
	if s.Inspect != nil {
		in := *s.Inspect
		switch k {
		case KeyEsc, KeyClose, KeyInspect:
			s.Inspect = nil
		case KeyUp:
			in.Scroll = max(in.Scroll-1, 0)
		case KeyDown:
			in.Scroll++
		case KeyPageUp:
			in.Scroll = max(in.Scroll-m.listHeight(), 0)
		case KeyPageDown:
			in.Scroll += m.listHeight()
		case KeyHalfUp:
			in.Scroll = max(in.Scroll-m.halfPage(), 0)
		case KeyHalfDown:
			in.Scroll += m.halfPage()
		}
		if s.Inspect != nil {
			s.Inspect = &in
		}
		return
	}
	section, ok := s.section()
	if !ok {
		return
	}
	subject := section.Subject
	items := listOf(*s, subject)
	at := snap(items, s.Cursors[subject])
	var item *Item
	if at >= 0 {
		item = &items[at]
	}
	answered, _ := s.Remote.(*Answered)
	remoteLine := func() *RemoteLine {
		if answered == nil || item == nil || subject != SubjectRemote {
			return nil
		}
		rl := remoteLines(answered, s.Collapsed)
		if item.Index >= len(rl) {
			return nil
		}
		return &rl[item.Index]
	}
	switch k {
	case KeyUp:
		m.moveCursor(-1)
	case KeyDown:
		m.moveCursor(1)
	case KeyPageUp:
		m.moveCursor(-m.listHeight())
	case KeyPageDown:
		m.moveCursor(m.listHeight())
	case KeyHalfUp:
		m.moveCursor(-m.halfPage())
	case KeyHalfDown:
		m.moveCursor(m.halfPage())
	// Over the rows to the next thing that heads a run of them: a group of
	// the remote tree. A page is a distance; this is a structure.
	case KeyPrevHeading, KeyNextHeading:
		step := 1
		if k == KeyPrevHeading {
			step = -1
		}
		for i := at + step; at >= 0 && i >= 0 && i < len(items); i += step {
			if items[i].Heading && items[i].Focusable {
				m.setCursor(subject, i)
				break
			}
		}
	case KeyFilter:
		s.Filtering = true
	case KeyInspect:
		m.inspect()
	// l only ever opens — it never dispatches, so the vim keys can't start
	// an install by accident. In the remote tree it unfolds a folded group.
	case KeyOpen:
		if line := remoteLine(); line != nil && line.Group != "" && s.Collapsed[line.Group] {
			s.Collapsed = without(s.Collapsed, line.Group)
			m.cursorOnHeading(line.Group)
		}
	// h in the remote tree folds the group under the cursor, landing on its
	// heading; anywhere else (or on a group with nothing to fold, like a
	// clean tool) it goes back to the sidebar. esc never folds.
	case KeyClose:
		if line := remoteLine(); line != nil && line.Group != "" && !s.Collapsed[line.Group] && s.Filters[subject] == "" {
			for _, l := range remoteLines(answered, s.Collapsed) {
				if l.Group == line.Group && !l.Heading() {
					s.Collapsed = with(s.Collapsed, line.Group)
					m.cursorOnHeading(line.Group)
					return
				}
			}
		}
		m.focus(FocusSidebar)
	// esc backs out one level, and never leaves the screen: the key you
	// press to back out of a list must not also end the session. q is the
	// only way out.
	case KeyEsc:
		switch {
		case s.Filters[subject] != "":
			s.Filters = withValue(s.Filters, subject, "")
		case m.finishedPanel() && !m.stacked():
			// A finished run's panel is what's left open below the list
			// (stacked, it has its own page: esc there closes it).
			m.dismissRun()
		default:
			m.focus(FocusSidebar)
		}
	// space ticks the row under the cursor — one unit at a time.
	case KeySelect:
		if item == nil {
			m.hey("nothing to tick there")
			return
		}
		row := item.Index
		switch subject {
		case SubjectPrograms:
			p := s.Programs[row]
			if !slices.ContainsFunc(s.Missing, func(r ProgramRow) bool { return r.Name == p.Name }) {
				m.hey(p.Name + " isn't missing — nothing to install")
				return
			}
			s.Chosen = toggled(s.Chosen, p.Name)
		// Each script is its own unit, and ticking a done one is how you force it.
		case SubjectScripts:
			s.Picked = toggled(s.Picked, s.Scripts[row].Name)
		// Ticking an applied config writes it again: harmless, and how you
		// put back a file you deleted.
		case SubjectConfigs:
			s.Applying = toggled(s.Applying, s.Configs[row].Name)
		case SubjectRemote:
			// A tool line, or a program under it, ticks the TOOL: loadout only
			// does whole upgrades. A source row ticks itself; its heading every
			// item under it, or clears them all when they already are.
			line := remoteLine()
			switch {
			case line == nil:
			case line.Kind == RemoteSource && len(line.ItemKeys) > 0:
				if containsAll(s.Selection, line.ItemKeys) {
					s.Selection = without(s.Selection, line.ItemKeys...)
				} else {
					s.Selection = with(s.Selection, line.ItemKeys...)
				}
			case line.Key == "":
				m.hey(cmp.Or(line.Refusal(), "nothing to tick there"))
			default:
				s.Selection = toggled(s.Selection, line.Key)
			}
		default:
			m.hey("nothing to tick there")
		}
	// K opens the page the row's source pointed at (the GitHub compare of the
	// two shas, like Lazy's K) in the browser.
	case KeyOpenLink:
		link := ""
		if line := remoteLine(); line != nil {
			link = line.Link()
		}
		if link == "" {
			m.hey("no page to open for this row")
		} else {
			m.openInBrowser(link)
		}
	// a ticks everything, u unticks everything — two keys, so neither has to
	// guess what you meant from what's ticked.
	case KeySelectAll, KeySelectNone:
		all := k == KeySelectAll
		pick := func(names map[string]bool) map[string]bool {
			if all {
				return names
			}
			return nil
		}
		switch subject {
		case SubjectPrograms:
			s.Chosen = pick(namesOf(s.Missing, func(p ProgramRow) string { return p.Name }))
		case SubjectScripts:
			s.Picked = pick(namesOf(s.Scripts, func(r ScriptRow) string { return r.Name }))
		case SubjectConfigs:
			s.Applying = pick(namesOf(s.Configs, func(c ConfigItem) string { return c.Name }))
		case SubjectRemote:
			if answered == nil {
				return
			}
			every := map[string]bool{}
			for _, l := range remoteLines(answered, s.Collapsed) {
				if l.Key != "" {
					every[l.Key] = true
				}
			}
			s.Selection = pick(every)
		default:
			m.hey("nothing to tick there")
		}
	case KeyEnter:
		m.act()
	}
}

// act is enter: the subject's verb on its ticks, through a confirm dialog.
// Never on an answer still coming.
func (m *HomeModel) act() {
	s := m.state
	section, ok := s.section()
	if !ok {
		return
	}
	if m.active != nil || m.waiting != nil {
		m.hey("a command is running — wait for it or ctrl+c it")
		return
	}
	switch {
	case section.Busy:
		m.hey("still asking — the rows fill in as answers land")
	case section.Subject == SubjectPrograms:
		m.startInstalls(s.Chosen)
	case section.Subject == SubjectScripts:
		m.startScripts(s.Picked)
	case section.Subject == SubjectConfigs:
		m.startConfigs(s.Applying)
	case section.Subject == SubjectRemote:
		answered, ok := s.Remote.(*Answered)
		if !ok {
			if _, unavailable := s.Remote.(Unavailable); unavailable {
				m.hey("the remotes couldn't be asked — r tries again")
			} else {
				m.hey("the remotes haven't been asked — r asks them")
			}
			return
		}
		var line *RemoteLine
		if s.Focus == FocusMain {
			items := listOf(s, SubjectRemote)
			if at := snap(items, s.Cursors[SubjectRemote]); at >= 0 {
				l := remoteLines(answered, s.Collapsed)[items[at].Index]
				line = &l
			}
		}
		switch {
		// The sweep's cost, in full: every package the tool would move that
		// loadout doesn't declare, one per line.
		case line != nil && line.Kind == RemoteOthers:
			m.state.Dialog = &Dialog{
				Kind:    DialogList,
				Title:   fmt.Sprintf("%s: %d not in your loadout", line.Tool, len(line.Names)),
				Lines:   line.Names,
				Summary: "These upgrade too when you upgrade " + line.Tool + ".",
			}
		case len(s.Selection) > 0:
			m.startUpgrade(answered, s.Selection)
		case len(answered.Updates) == 0 && !slices.ContainsFunc(answered.Tools, func(t ToolUpdates) bool { return t.Total == nil || *t.Total > 0 }):
			m.hey("everything up to date")
		default:
			m.hey("nothing selected — space selects one, a selects all")
		}
	case section.Subject == SubjectFleet:
		m.hey("this table is the comparison — there is nothing to run")
	}
}

// listHeight is how many rows the main list shows at once.
func (m *HomeModel) listHeight() int { return m.layout(m.shown != nil).listH }

// halfPage is ctrl+d / ctrl+u's distance: half the list's height, at least one.
func (m *HomeModel) halfPage() int { return max(m.listHeight()/2, 1) }

// moveCursor moves the main list's cursor by delta stops.
func (m *HomeModel) moveCursor(delta int) {
	s := m.state
	subject := s.subject()
	items := listOf(s, subject)
	from := snap(items, s.Cursors[subject])
	if from < 0 {
		return
	}
	step := 1
	if delta < 0 {
		step = -1
	}
	target, left := from, delta*step
	for i := from + step; i >= 0 && i < len(items) && left > 0; i += step {
		if items[i].Focusable {
			target = i
			left--
		}
	}
	m.setCursor(subject, target)
}

// setCursor puts subject's cursor on at, scrolling just enough to show it.
func (m *HomeModel) setCursor(subject string, at int) {
	s := &m.state
	view := max(m.listHeight(), 1)
	offset := s.Offsets[subject]
	offset = min(offset, at)
	offset = max(offset, at-view+1, 0)
	s.Cursors = withValue(s.Cursors, subject, at)
	s.Offsets = withValue(s.Offsets, subject, offset)
}

// cursorOnHeading puts the remote cursor on group's heading after a fold
// changed the tree under it.
func (m *HomeModel) cursorOnHeading(group string) {
	items := listOf(m.state, SubjectRemote)
	answered, _ := m.state.Remote.(*Answered)
	if answered == nil {
		return
	}
	lines := remoteLines(answered, m.state.Collapsed)
	for i, item := range items {
		if l := lines[item.Index]; l.Heading() && l.Group == group {
			m.setCursor(SubjectRemote, i)
			return
		}
	}
}

// withValue is s with key set to v, as a new map: a state's maps are never
// changed in place.
func withValue[K comparable, V any](s map[K]V, key K, v V) map[K]V {
	out := make(map[K]V, len(s)+1)
	for k, x := range s {
		out[k] = x
	}
	out[key] = v
	return out
}
