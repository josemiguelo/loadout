package term

import (
	"fmt"
	"image/color"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// harness drives one terminal the way Bubble Tea would: it runs the pending
// command, feeds its message to Update and keeps the next command.
type harness struct {
	t    *testing.T
	m    *Model
	cmd  tea.Cmd
	msgs []tea.Msg
}

func start(t *testing.T, w, h int, script string) *harness {
	t.Helper()
	m := New(w, h)
	t.Cleanup(func() { _ = m.Close() })
	m.Focus()
	return &harness{t: t, m: m, cmd: m.Start(exec.Command("sh", "-c", script))}
}

// next runs the pending command (5s cap) and feeds its message to Update.
func (h *harness) next() tea.Msg {
	h.t.Helper()
	if h.cmd == nil {
		h.t.Fatalf("no pending command; screen:\n%s", h.m.Plain())
	}
	got := make(chan tea.Msg, 1)
	cmd := h.cmd
	go func() { got <- cmd() }()
	select {
	case msg := <-got:
		h.msgs = append(h.msgs, msg)
		_, h.cmd = h.m.Update(msg)
		return msg
	case <-time.After(5 * time.Second):
		h.t.Fatalf("no message in 5s; screen:\n%s", h.m.Plain())
		return nil
	}
}

func (h *harness) until(cond func() bool) {
	h.t.Helper()
	for !cond() {
		h.next()
	}
}

func (h *harness) waitText(s string) {
	h.t.Helper()
	h.until(func() bool { return strings.Contains(h.m.Plain(), s) })
}

func (h *harness) waitExit() {
	h.t.Helper()
	h.until(h.m.Exited)
}

func (h *harness) keys(s string) {
	for _, r := range s {
		h.m.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
}

func (h *harness) key(k tea.KeyPressMsg) { h.m.Update(k) }

var (
	enter = tea.KeyPressMsg{Code: tea.KeyEnter}
	ctrlC = tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl}
)

func TestColouredOutputLandsInView(t *testing.T) {
	h := start(t, 40, 5, `printf '\033[31mred\033[0m plain\n'`)
	h.waitExit()
	v := h.m.View()
	if !strings.Contains(ansi.Strip(v), "red plain") {
		t.Fatalf("view:\n%s", v)
	}
	if !strings.Contains(v, "\x1b[31mred") {
		t.Errorf("no colour in %q", v)
	}
	if lines := strings.Split(v, "\n"); len(lines) != 5 || ansi.StringWidth(lines[0]) != 40 || ansi.StringWidth(lines[4]) != 40 {
		t.Errorf("view isn't 40x5: %q", v)
	}
	if h.m.ExitCode() != 0 || h.m.Interrupted() {
		t.Errorf("exit %d interrupted %v", h.m.ExitCode(), h.m.Interrupted())
	}
}

func TestCarriageReturnOverwritesProgress(t *testing.T) {
	h := start(t, 40, 5, `printf 'progress 1'; sleep 0.1; printf '\rprogress 2'; sleep 0.1; printf '\rdone      \n'`)
	h.waitExit()
	if p := h.m.Plain(); p != "done" {
		t.Errorf("plain = %q", p)
	}
}

func TestReadGetsForwardedKeys(t *testing.T) {
	h := start(t, 40, 5, `printf 'name? '; read a; echo "got $a"`)
	h.waitText("name?")
	h.keys("xy")
	h.key(enter)
	h.waitText("got xy")
}

func TestDevTtyPromptUsesThePty(t *testing.T) {
	h := start(t, 40, 5, `exec </dev/null >/dev/null; printf 'pw: ' >/dev/tty; read p </dev/tty; echo "ok $p" >/dev/tty`)
	h.waitText("pw:")
	h.keys("s3")
	h.key(enter)
	h.waitText("ok s3")
}

func TestCtrlCInterruptsTheChild(t *testing.T) {
	h := start(t, 40, 5, `echo ready; sleep 30; echo not-reached`)
	h.waitText("ready")
	h.key(ctrlC)
	h.waitExit()
	if !h.m.Interrupted() || h.m.ExitCode() != 130 {
		t.Errorf("exit %d interrupted %v", h.m.ExitCode(), h.m.Interrupted())
	}
}

func TestInterruptSignalsTheGroupAndExit130IsInterrupted(t *testing.T) {
	h := start(t, 40, 5, `trap 'echo trapped; exit 130' INT; echo ready; while :; do sleep 0.1; done`)
	h.waitText("ready")
	h.m.Interrupt()
	h.waitExit()
	if !h.m.Interrupted() || !strings.Contains(h.m.Plain(), "trapped") {
		t.Errorf("exit %d interrupted %v:\n%s", h.m.ExitCode(), h.m.Interrupted(), h.m.Plain())
	}
}

func TestExitCodeIsReported(t *testing.T) {
	h := start(t, 40, 5, `echo bye; exit 3`)
	h.waitExit()
	last := h.msgs[len(h.msgs)-1].(ExitMsg)
	if h.m.ExitCode() != 3 || h.m.Interrupted() || last.Code != 3 || last.Err != nil {
		t.Errorf("exit %d, msg %+v", h.m.ExitCode(), last)
	}
	// The last output is in before the exit.
	if !strings.Contains(h.m.Plain(), "bye") {
		t.Errorf("plain = %q", h.m.Plain())
	}
}

func TestStartFailureIsAnExit(t *testing.T) {
	m := New(10, 2)
	msg := m.Start(exec.Command("/nonexistent/loadout-test"))()
	if e, ok := msg.(ExitMsg); !ok || e.Err == nil || e.Code != -1 || !m.Exited() {
		t.Errorf("msg %+v", msg)
	}
	_ = m.Close()
}

func TestResizeReachesTheChild(t *testing.T) {
	h := start(t, 40, 5, `stty size; echo ready; read x; stty size`)
	h.waitText("ready")
	h.m.Resize(50, 12)
	h.key(enter)
	h.waitExit()
	if p := h.m.Plain(); !strings.Contains(p, "5 40") || !strings.Contains(p, "12 50") {
		t.Errorf("plain:\n%s", p)
	}
}

func TestColourQueriesAreAnsweredWithTheThemesColours(t *testing.T) {
	h := start(t, 60, 5, `stty -icanon -echo min 0 time 20; printf '\033]11;?\007'; r=$(dd bs=64 count=1 2>/dev/null); printf '%s\n' "$r" | tr -d '\033\007'`)
	h.m.SetColors(color.RGBA{0xab, 0xcd, 0xef, 0xff}, color.RGBA{0x12, 0x34, 0x56, 0xff})
	h.waitExit()
	if p := h.m.Plain(); !strings.Contains(p, "rgb:1212/3434/5656") {
		t.Errorf("plain = %q", p)
	}
}

func TestTitleAndBell(t *testing.T) {
	h := start(t, 40, 5, `printf '\033]0;hello\007'; sleep 0.1; printf '\a'; sleep 0.1; echo x`)
	h.waitExit()
	bell := false
	for _, msg := range h.msgs {
		_, ok := msg.(BellMsg)
		bell = bell || ok
	}
	if h.m.Title() != "hello" || !bell {
		t.Errorf("title %q bell %v", h.m.Title(), bell)
	}
}

func TestAGrownPanelPullsItsOutputDownInsteadOfLeavingBlankRows(t *testing.T) {
	h := start(t, 20, 10, `seq 1 30`)
	h.waitExit()
	h.m.Resize(20, 25) // z zooms the panel
	rows := strings.Split(ansi.Strip(h.m.View()), "\n")
	if len(rows) != 25 {
		t.Fatalf("%d rows", len(rows))
	}
	if top := strings.TrimSpace(rows[0]); top != "7" {
		t.Errorf("top row %q: the scrollback should come down into the new rows", top)
	}
	if last := strings.TrimSpace(rows[23]); last != "30" {
		t.Errorf("row 23 is %q: the output should end at the bottom, above the cursor's row", last)
	}
	for i, r := range rows[:24] {
		if strings.TrimSpace(r) == "" {
			t.Errorf("blank row %d inside the output", i)
		}
	}
	h.m.ScrollUp(3)
	if top := strings.TrimSpace(strings.Split(ansi.Strip(h.m.View()), "\n")[0]); top != "4" {
		t.Errorf("scrolled 3 from the grown view, top is %q", top)
	}
	h.m.Top()
	if top := strings.TrimSpace(strings.Split(ansi.Strip(h.m.View()), "\n")[0]); top != "1" {
		t.Errorf("Top shows the start of the output, top is %q", top)
	}
	h.m.Bottom()
	if top := strings.TrimSpace(strings.Split(ansi.Strip(h.m.View()), "\n")[0]); top != "7" {
		t.Errorf("Bottom is the live view again, top is %q", top)
	}
}

func TestScrollbackScrollsAndPlainKeepsEverythingAfterClose(t *testing.T) {
	h := start(t, 20, 10, `seq 1 300`)
	h.waitExit()
	if top := strings.Fields(ansi.Strip(h.m.View()))[0]; top != "292" { // the cursor sits on an empty last line
		t.Errorf("live top line %s", top)
	}
	h.m.ScrollUp(5)
	if top := strings.Fields(ansi.Strip(h.m.View()))[0]; top != "287" {
		t.Errorf("scrolled top line %s", top)
	}
	for range 100 {
		h.m.PageUp()
	}
	if top := strings.Fields(ansi.Strip(h.m.View()))[0]; top != "1" {
		t.Errorf("top after paging up %s", top)
	}
	h.m.Bottom()
	if err := h.m.Close(); err != nil {
		t.Fatal(err)
	}
	want := make([]string, 300)
	for i := range want {
		want[i] = fmt.Sprint(i + 1)
	}
	if got := h.m.Plain(); got != strings.Join(want, "\n") {
		t.Errorf("plain after close: %q", got)
	}
	if v := strings.Fields(h.m.View()); len(v) != 10 || v[0] != "291" || v[9] != "300" {
		t.Errorf("view after close: %v", v)
	}
	h.m.ScrollUp(1000)
	if v := strings.Fields(h.m.View()); v[0] != "1" {
		t.Errorf("scrolled view after close: %v", v)
	}
	if !h.m.Exited() || h.m.ExitCode() != 0 {
		t.Errorf("exit %d", h.m.ExitCode())
	}
}

func TestScrollbackIsBounded(t *testing.T) {
	h := start(t, 20, 5, fmt.Sprintf(`seq 1 %d`, ScrollbackLines+500))
	h.waitExit()
	if n := len(strings.Split(h.m.Plain(), "\n")); n > ScrollbackLines+5 {
		t.Errorf("%d lines kept", n)
	}
}

func TestTwoTerminalsMessagesDontMix(t *testing.T) {
	a := start(t, 20, 3, `echo aaa; exit 1`)
	b := start(t, 20, 3, `echo bbb; exit 2`)
	if a.m.ID() == b.m.ID() {
		t.Fatal("same ID")
	}
	// Every message goes to both models, as a parent broadcasting would.
	for !a.m.Exited() || !b.m.Exited() {
		for _, h := range []*harness{a, b} {
			if h.cmd == nil {
				continue
			}
			msg := h.next()
			other := a
			if h == a {
				other = b
			}
			if _, cmd := other.m.Update(msg); cmd != nil {
				t.Fatalf("%T for the other terminal returned a command", msg)
			}
		}
	}
	if a.m.ExitCode() != 1 || b.m.ExitCode() != 2 {
		t.Errorf("exits %d %d", a.m.ExitCode(), b.m.ExitCode())
	}
	if a.m.Plain() != "aaa" || b.m.Plain() != "bbb" {
		t.Errorf("plain %q %q", a.m.Plain(), b.m.Plain())
	}
}

func TestKeysGoNowhereUnlessFocused(t *testing.T) {
	h := start(t, 40, 5, `printf 'name? '; read a; echo "got $a"`)
	h.waitText("name?")
	h.m.Blur()
	h.keys("no")
	h.m.Focus()
	h.keys("yes")
	h.key(enter)
	h.waitText("got ")
	if !strings.Contains(h.m.Plain(), "got yes") {
		t.Errorf("plain:\n%s", h.m.Plain())
	}
}

func TestCloseKillsTheChildAndLeavesNoGoroutines(t *testing.T) {
	base := runtime.NumGoroutine()
	var pids []int
	for _, script := range []string{
		`echo done`,
		`echo ready; sleep 30`,
		`trap '' HUP; echo ready; sleep 30`,          // outlives SIGHUP: SIGKILL
		`sleep 30 & echo ready; wait`,                // a grandchild holds the tty
		`printf 'q? '; read a`,                       // waits on input
		`echo ready; exec 0<&-; while :; do :; done`, // never reads its input
	} {
		m := New(20, 3)
		h := &harness{t: t, m: m, cmd: m.Start(exec.Command("sh", "-c", script))}
		h.until(func() bool {
			return strings.Contains(m.Plain(), "ready") || strings.Contains(m.Plain(), "?") || m.Exited()
		})
		m.Focus()
		h.keys(strings.Repeat("x", 10000)) // queued input a child may never read
		pids = append(pids, m.cmd.Process.Pid)
		// A pending wait, as Bubble Tea would hold, must end on Close.
		pending := make(chan tea.Msg, 1)
		if h.cmd != nil {
			go func(c tea.Cmd) { pending <- c() }(h.cmd)
		} else {
			pending <- nil
		}
		began := time.Now()
		if err := m.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
		if d := time.Since(began); d > 2500*time.Millisecond {
			t.Errorf("close took %v", d)
		}
		select {
		case <-pending:
		case <-time.After(time.Second):
			t.Errorf("%q: pending command still waiting after Close", script)
		}
		if !m.Exited() {
			t.Errorf("%q: no exit recorded", script)
		}
		_ = m.Close() // idempotent
	}
	for _, pid := range pids {
		if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
			t.Errorf("child %d still exists (%v)", pid, err)
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for runtime.NumGoroutine() > base+1 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := runtime.NumGoroutine(); n > base+1 {
		buf := make([]byte, 1<<16)
		t.Errorf("%d goroutines, %d before:\n%s", n, base, buf[:runtime.Stack(buf, true)])
	}
}
