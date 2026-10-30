package tui

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"golang.org/x/term"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/core/platform"
	"github.com/josemiguelo/loadout/internal/theme"
	"github.com/josemiguelo/loadout/internal/tui/style"
	vterm "github.com/josemiguelo/loadout/internal/tui/term"
)

func init() { app.NewScreen = newScreen }

// screenDumpEnv names a file the screen writes its current frame to, as
// plain text, after every render: the integration tests' window on the
// screen (Bubble Tea's renderer writes only changed cells, so the raw
// output can't be grepped). Undocumented for users.
const screenDumpEnv = "LOADOUT_SCREEN_DUMP"

// screen is the home screen: one Bubble Tea program for the whole session.
type screen struct{ model *HomeModel }

func newScreen(a *app.AppContext) (app.Screen, error) {
	// The background query runs before the screen owns the terminal.
	m := newHomeModel(a, theme.TerminalIsDark())
	if err := m.load(); err != nil {
		return nil, err
	}
	m.refresh(true)
	return &screen{model: m}, nil
}

// Run runs the program on the alternate screen until the model exits.
// Keys come from the terminal even when stdin is a pipe.
func (s *screen) Run() (app.Ended, error) {
	m := s.model
	in := os.Stdin
	if !term.IsTerminal(int(in.Fd())) {
		tty, err := os.Open("/dev/tty")
		if err != nil {
			return app.Ended{}, errors.New("Unable to run in non-interactive mode.")
		}
		defer tty.Close()
		in = tty
	}
	p := &program{m: m, busy: style.NewBusy()}
	p.dump, _ = platform.EnvVar(screenDumpEnv)
	prog := tea.NewProgram(p, tea.WithInput(in), tea.WithOutput(os.Stdout))
	m.jobs.setNotify(func() { prog.Send(jobsMsg{}) })
	_, err := prog.Run()
	m.jobs.setNotify(nil)
	m.closeRuns()
	if err != nil && !errors.Is(err, tea.ErrInterrupted) {
		return app.Ended{}, err
	}
	if m.ended != nil {
		return *m.ended, nil
	}
	return app.Ended{}, nil
}

// program is the Bubble Tea model over HomeModel: keys, mouse, the jobs'
// answers, the terminal's output and the clocks arrive as messages; every
// state write happens here, on Update's goroutine.
type program struct {
	m    *HomeModel
	busy *style.Busy
	// dump and dumped are the screen-dump file and its last contents.
	dump, dumped string
}

// jobsMsg says a background job finished: its answer is in the queue.
type jobsMsg struct{}

func (p *program) Init() tea.Cmd {
	return tea.Batch(func() tea.Msg { return jobsMsg{} }, p.busy.Sync(p.m.anyBusy()))
}

func (p *program) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	m := p.m
	var cmds []tea.Cmd
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.resize(msg.Width, msg.Height)
	case tea.KeyPressMsg:
		m.key(msg)
	case tea.PasteMsg:
		switch {
		case m.terminalTakesKeys():
			m.terminalMsg(m.shown.term.ID(), msg)
		case m.typing():
			m.handleText(msg.Content)
		}
	case tea.MouseClickMsg:
		m.click(msg.Mouse())
	case tea.MouseWheelMsg:
		m.wheel(msg.Mouse())
	case jobsMsg:
		for _, answer := range m.jobs.take() {
			m.apply(answer)
		}
		m.afterJobs()
	case vterm.OutputMsg:
		m.terminalMsg(msg.ID, msg)
	case vterm.BellMsg:
		m.terminalMsg(msg.ID, msg)
	case vterm.ExitMsg:
		m.runExited(msg)
	case style.ToastExpiredMsg:
		m.toasts.Update(msg)
	default:
		if cmd, ok := p.busy.Update(msg); ok {
			cmds = append(cmds, cmd)
		}
	}
	cmds = append(cmds, m.takeCmds()...)
	// EVERY clock stops on exit: one still re-arming would outlive the screen.
	if m.state.Exit {
		p.busy.Sync(false)
		return p, tea.Quit
	}
	cmds = append(cmds, p.busy.Sync(m.anyBusy()))
	return p, tea.Batch(cmds...)
}

func (p *program) View() tea.View {
	m := p.m
	lines := m.screenLines(p.busy.Frame())
	content := strings.Join(lines, "\n")
	p.writeDump(lines)
	v := tea.NewView(content)
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	v.WindowTitle = "loadout"
	// No BackgroundColor: the terminal's own (a transparent one included) shows.
	v.Cursor = m.terminalCursor()
	return v
}

// writeDump writes the frame as plain text to the dump file, when there is
// one: atomically (a reader never sees half a frame) and only when changed.
func (p *program) writeDump(lines []string) {
	if p.dump == "" {
		return
	}
	plain := make([]string, len(lines))
	for i, line := range lines {
		plain[i] = strings.TrimRight(ansi.Strip(line), " ")
	}
	text := strings.Join(plain, "\n") + "\n"
	if text == p.dumped {
		return
	}
	p.dumped = text
	tmp := filepath.Join(filepath.Dir(p.dump), "."+filepath.Base(p.dump)+".tmp")
	if err := os.WriteFile(tmp, []byte(text), 0o644); err == nil {
		_ = os.Rename(tmp, p.dump)
	}
}

// takeCmds is what the reducers asked to run since the last update.
func (m *HomeModel) takeCmds() []tea.Cmd {
	cmds := m.cmds
	m.cmds = nil
	return cmds
}

// anyBusy says something on screen animates: a check, the remotes, a run.
func (m *HomeModel) anyBusy() bool {
	if m.state.Exit {
		return false
	}
	_, asking := m.state.Remote.(Asking)
	return len(m.state.Checking) > 0 || asking || m.active != nil
}

// resize takes the terminal's new size; the run panel's emulators follow.
func (m *HomeModel) resize(w, h int) {
	m.width, m.height = w, h
	m.resizeTerms()
}

func (m *HomeModel) resizeTerms() {
	w, h := m.layout(true).termSize()
	// A closed run (its emulator released, its text kept) resizes too: a
	// run reopened from Runs and zoomed must fill the zoomed panel.
	for _, r := range []*Run{m.active, m.shown} {
		if r != nil && r.term != nil {
			if cw, ch := r.term.Size(); cw != w || ch != h {
				r.term.Resize(w, h)
			}
		}
	}
}

// terminalTakesKeys says keys go to the running command: its terminal is
// focused (ctrl+] is kept back, see key).
func (m *HomeModel) terminalTakesKeys() bool {
	return m.state.Focus == FocusTerminal && m.state.Dialog == nil && m.shown != nil &&
		m.shown == m.active && m.shown.term != nil
}

// terminalCursor is the command's cursor on the screen, while it has the keys.
func (m *HomeModel) terminalCursor() *tea.Cursor {
	if !m.terminalTakesKeys() {
		return nil
	}
	c := m.shown.term.Cursor()
	if c == nil {
		return nil
	}
	l := m.layout(true)
	c.X += l.mainX
	c.Y += l.panelY + 1
	return c
}

// key is one key press: to the running command, to an input, or to the
// screen's reducers.
func (m *HomeModel) key(msg tea.KeyPressMsg) {
	if m.terminalTakesKeys() {
		if key.Matches(msg, leaveKey) {
			m.handleKey(KeyLeave)
			return
		}
		m.terminalMsg(m.shown.term.ID(), msg)
		return
	}
	if m.typing() && msg.Text != "" && msg.Mod&(tea.ModCtrl|tea.ModAlt) == 0 {
		m.handleText(msg.Text)
		return
	}
	if k, ok := homeKeyOf(msg); ok {
		m.handleKey(k)
	}
}

// click is a mouse click: a subject, a run, a list row or the run panel —
// stacked, on the page shown only.
func (m *HomeModel) click(mouse tea.Mouse) {
	if mouse.Button != tea.MouseLeft || m.state.Dialog != nil {
		return
	}
	l := m.layout(m.shown != nil)
	x, y := mouse.X, mouse.Y
	if !l.wide {
		switch m.page() {
		case pageHome:
			// A subject or a run opens its page.
			m.sideClick(y-l.pageY+m.sideOffset(m.sideLen(false), l.statusY-l.pageY, false), false)
		case pageSubject:
			m.listClick(l, y)
		}
		return
	}
	switch {
	case x < l.sideX+sidebarWidth:
		m.sideClick(y+m.sideOffset(m.sideLen(true), l.statusY, true), true)
	case m.shown != nil && y >= l.panelY && y < l.panelY+l.panelH:
		m.focus(FocusTerminal)
	default:
		m.listClick(l, y)
	}
}

// sideLen is how many lines the sidebar has (sideLines' count).
func (m *HomeModel) sideLen(logo bool) int {
	return sideHead(logo) + len(m.state.Sections) + 3 + max(len(m.runs), 1)
}

// sideClick is a click on the sidebar's line n: a subject (wide: shown
// beside it; stacked: its page opens) or a run (its panel opens).
func (m *HomeModel) sideClick(n int, wide bool) {
	s := &m.state
	if i := n - sideHead(wide); i >= 0 && i < len(s.Sections) {
		m.goSubject(i)
		if wide {
			m.focus(FocusSidebar)
		} else {
			m.focus(FocusMain)
		}
		return
	}
	runs := m.runsNewestFirst()
	if i := n - sideHead(wide) - len(s.Sections) - 3; i >= 0 && i < len(runs) {
		s.SideRun = i
		m.showRun(runs[i])
		s.RunFromSidebar = true
		m.focus(FocusTerminal)
	}
}

// listClick is a click on row y of the main pane: a list row is selected.
func (m *HomeModel) listClick(l layout, y int) {
	s := &m.state
	if y < l.listY || y >= l.listY+l.listH || s.Inspect != nil {
		return
	}
	items := listOf(*s, s.subject())
	n := y - l.listY + min(max(s.Offsets[s.subject()], 0), max(len(items)-l.listH, 0))
	if n < len(items) && items[n].Focusable {
		m.focus(FocusMain)
		m.setCursor(s.subject(), n)
	}
}

// wheel scrolls the pane under the mouse (stacked: the page shown).
func (m *HomeModel) wheel(mouse tea.Mouse) {
	if m.state.Dialog != nil {
		return
	}
	up := mouse.Button == tea.MouseWheelUp
	if mouse.Button != tea.MouseWheelUp && mouse.Button != tea.MouseWheelDown {
		return
	}
	l := m.layout(m.shown != nil)
	panel := m.shown != nil && m.shown.term != nil && mouse.Y >= l.panelY && mouse.Y < l.panelY+l.panelH
	main := mouse.X >= l.mainX
	if !l.wide {
		page := m.page()
		if page == pageHome {
			// The home page moves its selection, as ↑↓ do.
			m.sidebarKey(map[bool]HomeKey{true: KeyUp, false: KeyDown}[up])
			return
		}
		panel, main = page == pageRun && m.shown.term != nil, page == pageSubject
	}
	switch {
	case panel:
		if up {
			m.shown.term.ScrollUp(3)
		} else {
			m.shown.term.ScrollDown(3)
		}
	case main:
		if in := m.state.Inspect; in != nil {
			next := *in
			if up {
				next.Scroll = max(next.Scroll-3, 0)
			} else {
				next.Scroll += 3
			}
			m.state.Inspect = &next
			return
		}
		if up {
			m.moveCursor(-3)
		} else {
			m.moveCursor(3)
		}
	}
}

var leaveKey = key.NewBinding(key.WithKeys("ctrl+]"))

// keys maps the terminal's keys onto the screen's.
var keys = []struct {
	binding key.Binding
	key     HomeKey
}{
	{key.NewBinding(key.WithKeys("up", "k")), KeyUp},
	{key.NewBinding(key.WithKeys("down", "j")), KeyDown},
	{key.NewBinding(key.WithKeys("right", "l")), KeyOpen},
	{key.NewBinding(key.WithKeys("left", "h")), KeyClose},
	{key.NewBinding(key.WithKeys("pgup")), KeyPageUp},
	{key.NewBinding(key.WithKeys("pgdown")), KeyPageDown},
	// vim's and less's half pages (user decision).
	{key.NewBinding(key.WithKeys("ctrl+u")), KeyHalfUp},
	{key.NewBinding(key.WithKeys("ctrl+d")), KeyHalfDown},
	// vim's section jump: over the rows to the next group.
	{key.NewBinding(key.WithKeys("[")), KeyPrevHeading},
	{key.NewBinding(key.WithKeys("]")), KeyNextHeading},
	{key.NewBinding(key.WithKeys("enter")), KeyEnter},
	{key.NewBinding(key.WithKeys("esc")), KeyEsc},
	{key.NewBinding(key.WithKeys("space")), KeySelect},
	{key.NewBinding(key.WithKeys("a")), KeySelectAll},
	{key.NewBinding(key.WithKeys("u")), KeySelectNone},
	// Lazy's key for "show me the diff": the row's compare page, in the browser.
	{key.NewBinding(key.WithKeys("K", "shift+k")), KeyOpenLink},
	{key.NewBinding(key.WithKeys("r")), KeyRefresh},
	// Capitals for the consequential ones: S pushes, U replaces the binary,
	// C converges the machine.
	{key.NewBinding(key.WithKeys("S", "shift+s")), KeySync},
	{key.NewBinding(key.WithKeys("U", "shift+u")), KeyUpgrade},
	{key.NewBinding(key.WithKeys("C", "shift+c")), KeyConverge},
	{key.NewBinding(key.WithKeys("t")), KeyTheme},
	{key.NewBinding(key.WithKeys("q")), KeyQuit},
	{key.NewBinding(key.WithKeys("tab")), KeyTab},
	{key.NewBinding(key.WithKeys("shift+tab")), KeyShiftTab},
	{key.NewBinding(key.WithKeys("y")), KeyYes},
	{key.NewBinding(key.WithKeys("n")), KeyNo},
	{key.NewBinding(key.WithKeys("/")), KeyFilter},
	{key.NewBinding(key.WithKeys("i")), KeyInspect},
	{key.NewBinding(key.WithKeys("ctrl+p")), KeyPalette},
	{key.NewBinding(key.WithKeys("ctrl+g")), KeyHelp},
	{leaveKey, KeyLeave},
	{key.NewBinding(key.WithKeys("ctrl+c")), KeyInterrupt},
	{key.NewBinding(key.WithKeys("z")), KeyZoom},
	// vim's and less's ends of a text (user decision): the run's output.
	{key.NewBinding(key.WithKeys("home")), KeyTop},
	{key.NewBinding(key.WithKeys("end", "G", "shift+g")), KeyBottom},
	{key.NewBinding(key.WithKeys("g")), KeyG},
	{key.NewBinding(key.WithKeys("backspace")), KeyBackspace},
	{key.NewBinding(key.WithKeys("1")), KeySubject1},
	{key.NewBinding(key.WithKeys("2")), KeySubject2},
	{key.NewBinding(key.WithKeys("3")), KeySubject3},
	{key.NewBinding(key.WithKeys("4")), KeySubject4},
	{key.NewBinding(key.WithKeys("5")), KeySubject5},
}

func homeKeyOf(msg tea.KeyPressMsg) (HomeKey, bool) {
	for _, k := range keys {
		if key.Matches(msg, k.binding) {
			return k.key, true
		}
	}
	return 0, false
}
