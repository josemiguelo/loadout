package tui

import (
	"fmt"
	"image/color"
	osexec "os/exec"
	"slices"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/core/loader"
	"github.com/josemiguelo/loadout/internal/tui/term"
)

// maxRuns is how many of this session's runs the Runs list keeps. Only the
// newest finished one keeps its emulator (4 MiB); the others keep their
// text.
const maxRuns = 10

// interruptedCode is the exit of a command stopped by Ctrl-C (128 + SIGINT):
// the child loadout traps it and exits with it (LOADOUT_HANDOFF).
const interruptedCode = 130

// terminal is what the screen needs of the run panel's emulator
// (term.Model); tests drive a fake.
type terminal interface {
	ID() int64
	Start(cmd *osexec.Cmd) tea.Cmd
	Update(msg tea.Msg) tea.Cmd
	View() string
	Cursor() *tea.Cursor
	Size() (w, h int)
	Resize(w, h int)
	Focus()
	Blur()
	Running() bool
	Interrupt()
	Close() error
	ScrollUp(n int)
	ScrollDown(n int)
	PageUp()
	PageDown()
	Top()
	Bottom()
	Scrolled() int
	SetColors(fg, bg color.Color)
	Plain() string
}

// realTerm is term.Model behind the terminal interface.
type realTerm struct{ *term.Model }

func (r realTerm) Update(msg tea.Msg) tea.Cmd {
	_, cmd := r.Model.Update(msg)
	return cmd
}

// Run is one command this session ran in the run panel.
type Run struct {
	Closed app.Closed
	// Command is the whole command line ("loadout upgrade brew --yes"),
	// Label the short name the Runs list shows ("upgrade brew").
	Command, Label string
	Started, Ended time.Time
	Done           bool
	Code           int
	Interrupted    bool
	Err            error
	term           terminal
	// closed says the emulator was closed: its text stays, unstyled.
	closed bool
}

// Status is the run's glyph status.
func (r *Run) status() string {
	switch {
	case !r.Done:
		return "running"
	case r.Interrupted:
		return "interrupted"
	case r.Code == 0 && r.Err == nil:
		return "done"
	}
	return "failed"
}

// duration is how long it ran (so far), as m:ss or Ns.
func (r *Run) duration(now time.Time) string {
	end := r.Ended
	if !r.Done {
		end = now
	}
	d := end.Sub(r.Started).Round(time.Second)
	if d < time.Minute && r.Done {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	return fmt.Sprintf("%d:%02d", int(d.Minutes()), int(d.Seconds())%60)
}

// release closes the run's emulator, keeping its text.
func (r *Run) release() {
	if r.term != nil && !r.closed {
		_ = r.term.Close()
		r.closed = true
	}
}

// commandLine is closed's command as the user would type it.
func commandLine(closed app.Closed) (line, label string) {
	name, args, _ := closed.Command()
	words := append([]string{name}, args...)
	var short []string
	for _, w := range words {
		if w != "--yes" && w != "--force" {
			short = append(short, w)
		}
	}
	return "loadout " + strings.Join(words, " "), strings.Join(short, " ")
}

// confirm runs closed: now, or once the background checks still running
// have finished (none may run beside the command, or write the state file
// after it). One run at a time.
func (m *HomeModel) confirm(closed app.Closed) {
	m.state.Dialog = nil
	if m.active != nil || m.waiting != nil {
		m.hey("a command is running — wait for it or ctrl+c it")
		return
	}
	m.jobs.hold()
	if m.jobs.busy() {
		m.waiting = &closed
		m.hey("finishing the checks still running…")
		return
	}
	m.startRun(closed)
}

// afterJobs starts the run that waited for the checks, once they're done.
func (m *HomeModel) afterJobs() {
	if m.waiting != nil && !m.jobs.busy() {
		closed := *m.waiting
		m.waiting = nil
		m.startRun(closed)
	}
}

// startRun starts closed's command in the run panel, focused.
func (m *HomeModel) startRun(closed app.Closed) {
	if m.runCommand == nil {
		m.jobs.release()
		return
	}
	cmd, err := m.runCommand(closed)
	if err != nil || cmd == nil {
		m.jobs.release()
		if err != nil {
			m.fail(firstLine(err.Error()))
		}
		return
	}
	line, label := commandLine(closed)
	m.state.Maximized = false
	w, h := m.layout(true).termSize()
	t := m.newTerm(w, h)
	th := m.theme()
	t.SetColors(th.FgBase, th.BgBase)
	run := &Run{Closed: closed, Command: line, Label: label, Started: m.now(), term: t}
	// Only the newest finished run keeps its emulator.
	for _, r := range m.runs {
		r.release()
	}
	m.runs = append(m.runs, run)
	if len(m.runs) > maxRuns {
		m.runs = slices.Delete(m.runs, 0, len(m.runs)-maxRuns)
	}
	m.active, m.shown = run, run
	m.state.SideRun = -1
	m.state.RunFromSidebar = false
	m.state.Focus = FocusTerminal
	t.Focus()
	m.cmds = append(m.cmds, t.Start(cmd))
}

// runOf is the run whose terminal has id.
func (m *HomeModel) runOf(id int64) *Run {
	for _, r := range m.runs {
		if r.term != nil && r.term.ID() == id {
			return r
		}
	}
	return nil
}

// terminalMsg routes a terminal's output and bell to it.
func (m *HomeModel) terminalMsg(id int64, msg tea.Msg) {
	if r := m.runOf(id); r != nil && !r.closed {
		if cmd := r.term.Update(msg); cmd != nil {
			m.cmds = append(m.cmds, cmd)
		}
	}
}

// runExited is a run's command ending: the toast, the checks back on, and
// the same follow-ups as the command's own re-check would need.
func (m *HomeModel) runExited(msg term.ExitMsg) {
	r := m.runOf(msg.ID)
	if r == nil || r.Done {
		return
	}
	r.term.Update(msg)
	r.term.Blur()
	r.Done, r.Code, r.Interrupted, r.Err, r.Ended = true, msg.Code, msg.Interrupted || msg.Code == interruptedCode, msg.Err, m.now()
	if m.active == r {
		m.active = nil
	}
	// Its output stays in view and keeps the focus (user decision): stacked
	// on the run page, side by side in the panel below the list, ready to
	// scroll, jump (gg/G), zoom or close (esc). The emulator is blurred, so
	// keys reach the screen's own bindings, not the ended command.
	ok := r.Code == 0 && r.Err == nil
	switch {
	case ok:
		m.okay(r.Label + " done")
	case r.Interrupted:
		m.warn(r.Label + " interrupted")
	case r.Err != nil:
		m.fail(r.Label + ": " + firstLine(r.Err.Error()))
	default:
		m.fail(fmt.Sprintf("%s: exit %d", r.Label, r.Code))
	}
	m.jobs.release()
	// The binary on disk is another version now: self-upgrade, or a sync
	// that pulled a repo this binary can't read (it upgraded loadout to
	// carry on). This one can't go on reading the repo.
	switch {
	case r.Closed.Action == app.ActionUpgrade:
		message := "loadout self-upgrade finished — run loadout again to use the new version"
		code := 0
		if !ok {
			message = fmt.Sprintf("loadout self-upgrade failed (exit %d)", r.Code)
			code = r.Code
		}
		m.end(r, message, code)
		return
	case r.Closed.Action == app.ActionSync && m.toolTooOld():
		m.end(r, "loadout upgraded itself to sync this repo — run loadout again to use the new version", 0)
		return
	}
	m.followUp(r.Closed, ok)
}

// end ends the screen after r, printing its output and message on the
// normal screen.
func (m *HomeModel) end(r *Run, message string, code int) {
	out := strings.TrimRight(r.term.Plain(), "\n")
	if out != "" {
		message = out + "\n\n" + message
	}
	m.ended = &app.Ended{Message: message, Code: code}
	m.state.Exit = true
}

// toolTooOld says the repo now refuses this binary (a sync upgraded loadout).
func (m *HomeModel) toolTooOld() bool {
	return m.app != nil && loader.ToolTooOld(m.app.RepoRoot)
}

// followUp is what a finished run changes on screen (ok: it exited 0).
// Rows re-read the state file the command wrote; the remotes are asked
// again after an upgrade, everything after sync or set-up (the repo may
// have changed), the machine after a failure (the file may be stale).
// Upgrade ticks clear on success only.
func (m *HomeModel) followUp(closed app.Closed, ok bool) {
	upgraded := closed.Handoff != nil && closed.Handoff.Kind == app.PaneUpgrade
	if upgraded && ok {
		m.state.Selection = nil
	}
	switch {
	case closed.Action == app.ActionSync || closed.Action == app.ActionSetup:
		if m.app != nil {
			m.app.ReloadLayout()
			if err := m.load(); err != nil {
				m.fail(firstLine(err.Error()))
			}
		}
		m.refresh(true)
	case !ok:
		m.reload()
		m.refresh(upgraded)
	default:
		m.reload()
		if upgraded {
			m.askRemotesAgain()
		}
	}
}

// showRun puts r in the run panel.
func (m *HomeModel) showRun(r *Run) {
	if m.shown != nil && m.shown != r && m.shown != m.active {
		m.shown.release()
	}
	m.shown = r
	if r.term != nil {
		w, h := m.layout(true).termSize()
		r.term.Resize(w, h)
	}
}

// finishedPanel says the run panel shows a command that has ended: esc
// closes it from any area (a running one only stops with ctrl+c).
func (m *HomeModel) finishedPanel() bool {
	return m.shown != nil && m.shown != m.active
}

// dismissRun hides the run panel; a finished run's emulator closes.
func (m *HomeModel) dismissRun() {
	if m.shown == nil || m.shown == m.active {
		return
	}
	m.shown.release()
	m.shown = nil
	m.state.Maximized = false
	if m.state.Focus == FocusTerminal {
		m.state.Focus = m.backFromRun()
	}
	m.state.RunFromSidebar = false
}

// backFromRun is where the focus goes when it leaves the run panel: the
// sidebar, on the same Runs entry, when the run was opened from there;
// otherwise the main pane.
func (m *HomeModel) backFromRun() FocusArea {
	runs := m.runsNewestFirst()
	if s := m.state; s.RunFromSidebar && s.SideRun >= 0 && s.SideRun < len(runs) {
		return FocusSidebar
	}
	return FocusMain
}

// interrupt sends Ctrl-C to the running command's terminal.
func (m *HomeModel) interrupt() {
	if m.active != nil && m.active.term != nil {
		m.active.term.Interrupt()
		m.hey("interrupting " + m.active.Label + "…")
	}
}

// closeRuns ends every emulator (the screen is leaving).
func (m *HomeModel) closeRuns() {
	for _, r := range m.runs {
		r.release()
	}
}

// runsNewestFirst is the Runs list's order.
func (m *HomeModel) runsNewestFirst() []*Run {
	out := slices.Clone(m.runs)
	slices.Reverse(out)
	return out
}
