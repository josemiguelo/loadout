// Package term is a Bubble Tea v2 component that runs one command in a
// pseudo-terminal and renders it through charmbracelet/x/vt: the home
// screen's run panel.
//
// The child gets the PTY as its controlling terminal (Setsid + Setctty), so
// /dev/tty prompts (sudo, gum) use it and Ctrl-C, sent as a key, makes the
// line discipline signal the child's foreground process group, never this
// process. Every method runs on the Bubble Tea goroutine (Update's); the
// component's own goroutines touch only the emulator, under its lock.
//
// Messages carry the terminal's ID: a parent holding several terminals (a
// finished run kept for viewing beside a new one) routes each to its owner,
// and Update ignores the others'.
package term

import (
	"errors"
	"image/color"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	tea "charm.land/bubbletea/v2"
	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// ScrollbackLines bounds the scrollback the emulator keeps (and so Plain).
// vt drops the oldest line per push by shifting the slice, so a bigger
// bound costs CPU on floods as well as memory.
const ScrollbackLines = 2000

// exitGrace is how long ExitMsg waits for the PTY's last output once the
// child is reaped: a background grandchild may keep the tty open forever.
const exitGrace = 200 * time.Millisecond

// closeGrace is how long Close waits after SIGHUP, then after SIGKILL.
const closeGrace = time.Second

// OutputMsg says the terminal's screen changed: re-render.
type OutputMsg struct{ ID int64 }

// BellMsg says the child rang the bell.
type BellMsg struct{ ID int64 }

// ExitMsg says the child exited and its last output is on the screen.
// Code is the exit code, 128+n when killed by signal n, -1 when it never
// started (Err says why). Interrupted is exit 130 or death by SIGINT.
type ExitMsg struct {
	ID          int64
	Code        int
	Interrupted bool
	Err         error
}

var lastID atomic.Int64

// Model is one embedded terminal. Use it by pointer.
type Model struct {
	id   int64
	w, h int

	mu    sync.Mutex // guards emu's state and title
	emu   *vt.Emulator
	title string

	cmd     *exec.Cmd
	ptmx    *os.File
	started bool
	closed  bool

	dirty  chan struct{} // cap 1: coalesces output bursts into one redraw
	bell   chan struct{} // cap 1
	done   chan ExitMsg  // cap 1: the waiter's one result
	quit   chan struct{} // closed by Close: ends a pending wait
	reaped chan struct{} // closed once the child is reaped
	read   chan struct{} // closed once the PTY reader ends
	wg     sync.WaitGroup

	focused bool
	exited  bool
	exit    ExitMsg

	offset int // lines scrolled up from the bottom; 0 = live
	seenSB int // scrollback length at the last OutputMsg, to hold a scrolled view

	plain []string // after Close: the whole log, the emulator dropped
}

// New makes an idle terminal of w x h cells.
func New(w, h int) *Model {
	w, h = max(w, 1), max(h, 1)
	emu := vt.NewEmulator(w, h)
	emu.SetScrollbackSize(ScrollbackLines)
	m := &Model{
		id: lastID.Add(1), w: w, h: h, emu: emu,
		dirty: make(chan struct{}, 1), bell: make(chan struct{}, 1), done: make(chan ExitMsg, 1),
		quit: make(chan struct{}), reaped: make(chan struct{}), read: make(chan struct{}),
	}
	// Answer OSC 10/11 queries until SetColors gives the theme's.
	m.SetColors(color.RGBA{0xdd, 0xdd, 0xdd, 0xff}, color.RGBA{0x1e, 0x1e, 0x1e, 0xff})
	// Callbacks run inside emu.Write, under mu.
	emu.SetCallbacks(vt.Callbacks{
		Title: func(t string) { m.title = t },
		Bell:  func() { notify(m.bell) },
	})
	return m
}

// ID tells this terminal's messages from another's.
func (m *Model) ID() int64 { return m.id }

// SetColors sets the default foreground and background: the colours OSC
// 10/11 queries are answered with (programs pick light or dark from them).
func (m *Model) SetColors(fg, bg color.Color) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.emu != nil {
		m.emu.SetDefaultForegroundColor(fg)
		m.emu.SetDefaultBackgroundColor(bg)
	}
}

// Start runs cmd on a new PTY of the terminal's size. Its stdio becomes the
// PTY; its env (nil = this process's) gets TERM=xterm-256color and loses
// what describes the outer terminal. The returned command delivers this
// terminal's messages; Update keeps it going. A second Start is an error.
func (m *Model) Start(cmd *exec.Cmd) tea.Cmd {
	fail := func(err error) tea.Cmd {
		m.exited, m.exit = true, ExitMsg{ID: m.id, Code: -1, Err: err}
		msg := m.exit
		return func() tea.Msg { return msg }
	}
	if m.started || m.closed {
		return fail(errors.New("terminal already used"))
	}
	m.started = true
	ptmx, tty, err := pty.Open()
	if err != nil {
		return fail(err)
	}
	prepareMaster(ptmx)
	if err := setSize(ptmx, m.w, m.h); err != nil {
		_, _ = ptmx.Close(), tty.Close()
		return fail(err)
	}
	cmd.Env = terminalEnv(cmd.Env)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, tty, tty
	// Setsid: the child leads a new session (and process group, pgid = pid);
	// Setctty: the PTY (fd 0) is its controlling terminal.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	err = cmd.Start()
	_ = tty.Close() // the child holds its own copy
	if err != nil {
		_ = ptmx.Close()
		return fail(err)
	}
	m.cmd, m.ptmx = cmd, ptmx
	emu := m.emu // the goroutines keep their own reference: Close drops m.emu
	out := newQueue()
	m.wg.Add(4)
	// PTY -> emulator. Ends on EIO (Linux) or EOF (macOS) once every holder
	// of the tty closed it, or when Close closes the master.
	go func() {
		defer m.wg.Done()
		defer close(m.read)
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				m.mu.Lock()
				_, _ = emu.Write(buf[:n])
				m.mu.Unlock()
				notify(m.dirty)
			}
			if err != nil {
				return
			}
		}
	}()
	// Emulator -> queue: key encodings and answers to DA/DSR/OSC queries.
	// Always drained: emu.Write blocks on this pipe while answering, under mu.
	go func() {
		defer m.wg.Done()
		defer out.close()
		buf := make([]byte, 4096)
		for {
			n, err := emu.Read(buf)
			if n > 0 {
				out.push(append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				return
			}
		}
	}()
	// Queue -> PTY, apart from the drain: a child not reading its input
	// blocks this write, never the emulator.
	go func() {
		defer m.wg.Done()
		for {
			b, ok := out.pop()
			if !ok {
				return
			}
			_, _ = ptmx.Write(b)
		}
	}()
	// Reap; report only once the last output is in the emulator (bounded).
	go func() {
		defer m.wg.Done()
		err := cmd.Wait()
		close(m.reaped)
		select {
		case <-m.read:
		case <-time.After(exitGrace):
		}
		m.done <- exitMsg(m.id, cmd.ProcessState, err)
	}()
	return m.wait()
}

func (m *Model) wait() tea.Cmd {
	id, dirty, bell, done, quit := m.id, m.dirty, m.bell, m.done, m.quit
	return func() tea.Msg {
		select {
		case <-dirty:
			return OutputMsg{id}
		case <-bell:
			return BellMsg{id}
		case e := <-done:
			return e
		case <-quit:
			return nil
		}
	}
}

func exitMsg(id int64, ps *os.ProcessState, err error) ExitMsg {
	e := ExitMsg{ID: id, Code: -1}
	if ps != nil {
		if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			e.Code = 128 + int(ws.Signal())
			e.Interrupted = ws.Signal() == syscall.SIGINT
		} else {
			e.Code = ps.ExitCode()
		}
	}
	e.Interrupted = e.Interrupted || e.Code == 130
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		e.Err = err
	}
	return e
}

// Update handles this terminal's messages and, while it is focused and
// running, keys and pastes (every key: the parent keeps its own, such as
// ctrl+], from reaching it). It returns the command that keeps messages
// coming.
func (m *Model) Update(msg tea.Msg) (*Model, tea.Cmd) {
	switch msg := msg.(type) {
	case OutputMsg:
		if msg.ID == m.id && !m.closed {
			m.holdScroll()
			return m, m.wait()
		}
	case BellMsg:
		if msg.ID == m.id && !m.closed {
			return m, m.wait()
		}
	case ExitMsg:
		if msg.ID == m.id {
			m.exited, m.exit = true, msg
			m.holdScroll()
		}
	case tea.KeyPressMsg:
		if m.Running() && m.focused {
			m.offset = 0
			m.mu.Lock()
			m.emu.SendKey(uv.KeyPressEvent(msg))
			m.mu.Unlock()
		}
	case tea.PasteMsg:
		if m.Running() && m.focused {
			m.offset = 0
			m.mu.Lock()
			m.emu.Paste(msg.Content)
			m.mu.Unlock()
		}
	}
	return m, nil
}

// holdScroll keeps a scrolled view on the same lines while output pushes
// new ones into the scrollback.
func (m *Model) holdScroll() {
	if m.emu == nil {
		return
	}
	m.mu.Lock()
	n := m.emu.ScrollbackLen()
	m.mu.Unlock()
	if m.offset > 0 && n > m.seenSB {
		m.offset += n - m.seenSB
	}
	m.seenSB = n
	m.offset = min(m.offset, m.maxOffset())
}

// Running is true from Start until the child exited.
func (m *Model) Running() bool { return m.started && !m.exited && !m.closed }

// Exited is true once the child exited (or failed to start).
func (m *Model) Exited() bool { return m.exited }

// ExitCode is the child's exit code (see ExitMsg); -1 before it exits.
func (m *Model) ExitCode() int {
	if !m.exited {
		return -1
	}
	return m.exit.Code
}

// Interrupted is true when the child exited 130 or by SIGINT.
func (m *Model) Interrupted() bool { return m.exited && m.exit.Interrupted }

// Err is why the child couldn't start or be waited for, if so.
func (m *Model) Err() error { return m.exit.Err }

// Title is the last title the child set (OSC 0/2).
func (m *Model) Title() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.title
}

// Focus routes keys to the child (and reports focus to it if it asked).
func (m *Model) Focus() {
	m.focused = true
	m.withEmu(func(e *vt.Emulator) { e.Focus() })
}

// Blur stops routing keys to the child.
func (m *Model) Blur() {
	m.focused = false
	m.withEmu(func(e *vt.Emulator) { e.Blur() })
}

// Focused says whether keys go to the child.
func (m *Model) Focused() bool { return m.focused }

func (m *Model) withEmu(f func(*vt.Emulator)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.emu != nil && m.Running() {
		f(m.emu)
	}
}

// Size is the terminal's size in cells.
func (m *Model) Size() (w, h int) { return m.w, m.h }

// Resize resizes the emulator and the PTY (the child gets SIGWINCH).
func (m *Model) Resize(w, h int) {
	w, h = max(w, 1), max(h, 1)
	if w == m.w && h == m.h {
		return
	}
	m.w, m.h = w, h
	if m.emu != nil {
		m.mu.Lock()
		m.emu.Resize(w, h)
		m.mu.Unlock()
	}
	if m.ptmx != nil && !m.closed {
		_ = setSize(m.ptmx, w, h)
	}
	m.offset = min(m.offset, m.maxOffset())
}

// Interrupt sends SIGINT to the PTY's foreground process group (the
// child's, or a job it put in the foreground), as ^C would.
func (m *Model) Interrupt() {
	if !m.Running() {
		return
	}
	for _, pg := range m.groups() {
		_ = syscall.Kill(-pg, syscall.SIGINT)
	}
}

// groups is the child's process group and the PTY's foreground one.
func (m *Model) groups() []int {
	pid := m.cmd.Process.Pid
	groups := []int{pid}
	if fg := foreground(m.ptmx); fg > 0 && fg != pid {
		groups = append(groups, fg)
	}
	return groups
}

// Close ends the terminal: a running child's process groups get SIGHUP,
// then SIGKILL if they outlive the grace; the PTY and the goroutines are
// released, the emulator is dropped and its text kept for View and Plain.
// The child's exit is recorded if no ExitMsg was handled yet. Idempotent.
func (m *Model) Close() error {
	if m.closed {
		return nil
	}
	defer m.snapshot()
	m.closed = true
	close(m.quit)
	if m.ptmx == nil {
		return nil
	}
	if !isClosed(m.reaped) {
		for _, sig := range []syscall.Signal{syscall.SIGHUP, syscall.SIGKILL} {
			for _, pg := range m.groups() {
				_ = syscall.Kill(-pg, sig)
			}
			if waitFor(m.reaped, closeGrace) {
				break
			}
		}
	}
	err := m.ptmx.Close()
	waitFor(m.read, closeGrace)
	// End the drain: the emulator's reply pipe reports EOF.
	if pw, ok := m.emu.InputPipe().(*io.PipeWriter); ok {
		_ = pw.Close()
	}
	finished := make(chan struct{})
	go func() { m.wg.Wait(); close(finished) }()
	waitFor(finished, closeGrace)
	if !m.exited && isClosed(m.reaped) {
		m.exited, m.exit = true, exitMsg(m.id, m.cmd.ProcessState, nil)
	}
	return err
}

// snapshot keeps the text and drops the emulator (its parser alone holds
// 4 MiB).
func (m *Model) snapshot() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.emu == nil {
		return
	}
	m.plain = plainLines(m.emu)
	m.emu = nil
	m.offset = min(m.offset, max(len(m.plain)-m.h, 0))
}

// Plain is the whole log, scrollback then screen, without styles: trailing
// spaces and trailing blank lines trimmed. Cheap after Close.
func (m *Model) Plain() string {
	if m.emu == nil {
		return strings.Join(m.plain, "\n")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return strings.Join(plainLines(m.emu), "\n")
}

func plainLines(e *vt.Emulator) []string {
	var lines []string
	if sb := e.Scrollback(); sb != nil && !e.IsAltScreen() {
		for _, l := range sb.Lines() {
			lines = append(lines, strings.TrimRight(l.String(), " "))
		}
	}
	for l := range strings.SplitSeq(e.String(), "\n") {
		lines = append(lines, strings.TrimRight(l, " "))
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// View is the screen (or, scrolled, the lines above it): exactly h lines
// of w cells, styled. After Close it is the kept text, unstyled.
func (m *Model) View() string {
	if m.emu == nil {
		end := len(m.plain) - m.offset
		start := max(end-m.h, 0)
		return m.frame(m.plain[start:end])
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	screen := strings.Split(m.emu.Render(), "\n")
	if m.emu.IsAltScreen() {
		return m.frame(screen)
	}
	content, _ := m.content(screen)
	end := len(content) - m.offset
	return m.frame(content[max(end-m.h, 0):end])
}

// content is everything View can show, oldest first: the scrollback, then
// the screen down to its live end (its last written row, or the cursor's
// row when lower). The live view is its last h lines, scrolling moves back
// through it. So a panel that grew (z zooms it) shows the scrollback's last
// lines in the rows it gained, as kitty or iTerm do on a resize, instead of
// its output at the top over blank rows: the emulator itself keeps them in
// its scrollback. n is the scrollback's length. A full-screen program (the
// alternate screen) draws every row itself and isn't asked. The caller
// holds m.mu.
func (m *Model) content(screen []string) (lines []string, n int) {
	end := 0
	for i := len(screen) - 1; i >= 0; i-- {
		if strings.TrimSpace(ansi.Strip(screen[i])) != "" {
			end = i + 1
			break
		}
	}
	// The cursor's row is the live end, written or not: a prompt waits on it.
	end = min(max(end, m.emu.CursorPosition().Y+1), len(screen))
	if sb := m.emu.Scrollback(); sb != nil {
		n = sb.Len()
		lines = make([]string, 0, n+end)
		for y := range n {
			lines = append(lines, sb.Line(y).Render())
		}
	}
	return append(lines, screen[:end]...), n
}

// frame pads or cuts lines to exactly w x h.
func (m *Model) frame(lines []string) string {
	var b strings.Builder
	for y := range m.h {
		l := ""
		if y < len(lines) {
			l = lines[y]
		}
		if w := ansi.StringWidth(l); w > m.w {
			l = ansi.Truncate(l, m.w, "")
		} else if w < m.w {
			if strings.Contains(l, "\x1b") {
				l += ansi.ResetStyle
			}
			l += strings.Repeat(" ", m.w-w)
		}
		b.WriteString(l)
		if y < m.h-1 {
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// Cursor is the cursor's position inside View, or nil when it shouldn't
// show: not focused, not running, scrolled back, or hidden by the child.
// The parent adds the panel's offset.
func (m *Model) Cursor() *tea.Cursor {
	if !m.focused || !m.Running() || m.offset > 0 {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.emu.CursorHidden() {
		return nil
	}
	p := m.emu.CursorPosition()
	shift := 0
	if !m.emu.IsAltScreen() {
		// The live view starts at content's last h lines: screen row 0 sits
		// n-start rows down.
		content, n := m.content(strings.Split(m.emu.Render(), "\n"))
		shift = n - max(len(content)-m.h, 0)
	}
	c := tea.NewCursor(p.X, p.Y+shift)
	style, blink := m.emu.CursorStyle()
	c.Blink = blink
	switch style {
	case vt.CursorUnderline:
		c.Shape = tea.CursorUnderline
	case vt.CursorBar:
		c.Shape = tea.CursorBar
	}
	return c
}

// Scrolled is how many lines the view is above the live screen.
func (m *Model) Scrolled() int { return m.offset }

// ScrollUp moves the view n lines back into the scrollback (not while the
// child shows its alternate screen, which has none).
func (m *Model) ScrollUp(n int) { m.offset = min(m.offset+n, m.maxOffset()) }

// ScrollDown moves the view n lines towards the live screen.
func (m *Model) ScrollDown(n int) { m.offset = max(m.offset-n, 0) }

// PageUp scrolls back one screen.
func (m *Model) PageUp() { m.ScrollUp(max(m.h-1, 1)) }

// PageDown scrolls forward one screen.
func (m *Model) PageDown() { m.ScrollDown(max(m.h-1, 1)) }

// Top shows the start of the output: the oldest line the scrollback keeps.
func (m *Model) Top() { m.offset = m.maxOffset() }

// Bottom returns to the live screen.
func (m *Model) Bottom() { m.offset = 0 }

func (m *Model) maxOffset() int {
	if m.emu == nil {
		return max(len(m.plain)-m.h, 0)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.emu.IsAltScreen() {
		return 0
	}
	content, _ := m.content(strings.Split(m.emu.Render(), "\n"))
	return max(len(content)-m.h, 0)
}

// terminalEnv is env (nil = this process's) for a child of the emulator:
// TERM is what it emulates, and variables naming the outer terminal (or
// its size) go, so nothing talks to that terminal's extensions.
func terminalEnv(env []string) []string {
	if env == nil {
		env = os.Environ()
	}
	out := make([]string, 0, len(env)+2)
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		switch {
		case k == "TERM", k == "COLORTERM", k == "TERM_PROGRAM", k == "TERM_PROGRAM_VERSION",
			k == "COLUMNS", k == "LINES", k == "TERMINFO",
			strings.HasPrefix(k, "KITTY_"), strings.HasPrefix(k, "WEZTERM_"),
			strings.HasPrefix(k, "GHOSTTY_"), strings.HasPrefix(k, "ALACRITTY_"),
			k == "VTE_VERSION", k == "WT_SESSION", k == "ITERM_SESSION_ID":
			continue
		}
		out = append(out, kv)
	}
	return append(out, "TERM=xterm-256color", "COLORTERM=truecolor")
}

func notify(c chan struct{}) {
	select {
	case c <- struct{}{}:
	default:
	}
}

func isClosed(c chan struct{}) bool {
	select {
	case <-c:
		return true
	default:
		return false
	}
}

func waitFor(c chan struct{}, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-c:
		return true
	case <-t.C:
		return false
	}
}

// setSize sets the PTY's window size through SyscallConn: File.Fd would
// put the master back in blocking mode, and Close couldn't interrupt a Read.
func setSize(f *os.File, w, h int) error {
	rc, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var ierr error
	err = rc.Control(func(fd uintptr) {
		ierr = unix.IoctlSetWinsize(int(fd), unix.TIOCSWINSZ, &unix.Winsize{Row: uint16(h), Col: uint16(w)})
	})
	return errors.Join(err, ierr)
}

// foreground is the PTY's foreground process group, or 0.
func foreground(f *os.File) int {
	rc, err := f.SyscallConn()
	if err != nil {
		return 0
	}
	pg := 0
	_ = rc.Control(func(fd uintptr) {
		if v, err := unix.IoctlGetInt(int(fd), unix.TIOCGPGRP); err == nil {
			pg = v
		}
	})
	return pg
}

// queue is an unbounded FIFO of writes to the PTY.
type queue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	items  [][]byte
	closed bool
}

func newQueue() *queue {
	q := &queue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *queue) push(b []byte) {
	q.mu.Lock()
	q.items = append(q.items, b)
	q.mu.Unlock()
	q.cond.Signal()
}

func (q *queue) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.cond.Broadcast()
}

// pop waits for the next write; false once closed (pending writes dropped:
// nothing reads them once the PTY is gone).
func (q *queue) pop() ([]byte, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.items) == 0 && !q.closed {
		q.cond.Wait()
	}
	if q.closed {
		return nil, false
	}
	b := q.items[0]
	q.items = q.items[1:]
	return b, true
}
