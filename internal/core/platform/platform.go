// Package platform is the posix surface the binary needs: the host, the
// clock, the terminal and Ctrl-C.
package platform

import (
	"fmt"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

// Hostname is the machine's hostname (its first label), the default machine
// name for state files; "unknown" when it can't be read.
func Hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	name, _, _ = strings.Cut(name, ".")
	return name
}

// IsStdoutTty says whether stdout is attached to a terminal (gates the TUI).
func IsStdoutTty() bool { return term.IsTerminal(int(os.Stdout.Fd())) }

// UnameInfo is the kernel name ("Linux", "Darwin") and hardware name ("x86_64", "arm64").
type UnameInfo struct{ Sysname, Machine string }

// Uname is this kernel's UnameInfo; "unknown" for both when it can't be read.
func Uname() UnameInfo {
	var u unix.Utsname
	if unix.Uname(&u) != nil {
		return UnameInfo{"unknown", "unknown"}
	}
	return UnameInfo{unix.ByteSliceToString(u.Sysname[:]), unix.ByteSliceToString(u.Machine[:])}
}

// NowIso is the current UTC time as ISO-8601, as Kotlin's Instant writes it:
// "2026-08-14T12:00:00Z", with a fraction of 3, 6 or 9 digits when there is one.
func NowIso() string { return IsoOf(time.Now()) }

// IsoOf is t as NowIso writes it.
func IsoOf(t time.Time) string {
	t = t.UTC()
	base := t.Format("2006-01-02T15:04:05")
	nanos := t.Nanosecond()
	switch {
	case nanos == 0:
		return base + "Z"
	case nanos%1_000_000 == 0:
		return fmt.Sprintf("%s.%03dZ", base, nanos/1_000_000)
	case nanos%1_000 == 0:
		return fmt.Sprintf("%s.%06dZ", base, nanos/1_000)
	}
	return fmt.Sprintf("%s.%09dZ", base, nanos)
}

// EnvVar is the environment variable name's value, and whether it is set.
func EnvVar(name string) (string, bool) { return os.LookupEnv(name) }

// SelfExecutable is this binary's own path, or "" when unreadable. Linux
// reads /proc/self/exe, which names a binary replaced since it started
// "<path> (deleted)"; os.Executable drops that suffix, so the path is the
// new binary's: read it BEFORE an install replaces it when the old one is
// meant (sync). macOS: the path the kernel started the binary from.
func SelfExecutable() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	return path
}

// ─── Ctrl-C ─────────────────────────────────────────────────────────────

// interrupts holds a Ctrl-C that arrived while trapped, until taken. A
// caught signal resets to default in a child at exec (an ignored one would
// stay ignored), so the command's processes still stop.
var interrupts = make(chan os.Signal, 1)

// TrapInterrupts on: Ctrl-C stops the running command's processes but not
// loadout, and is recorded for TakeInterrupt. Off restores the default.
// A home-screen run's child loadout (LOADOUT_HANDOFF) only.
func TrapInterrupts(on bool) {
	if on {
		signal.Notify(interrupts, os.Interrupt)
	} else {
		signal.Reset(os.Interrupt)
	}
}

// TakeInterrupt says whether Ctrl-C arrived since the last call; resets it.
func TakeInterrupt() bool {
	select {
	case <-interrupts:
		return true
	default:
		return false
	}
}

// TakeInterruptWithin is TakeInterrupt, waiting up to d for a Ctrl-C the
// runtime hasn't delivered yet (a child it killed may exit first).
func TakeInterruptWithin(d time.Duration) bool {
	select {
	case <-interrupts:
		return true
	case <-time.After(d):
		return false
	}
}

// ─── the terminal ───────────────────────────────────────────────────────

// TerminalRows is the terminal height in rows (TIOCGWINSZ on stdout), or 0 when unknown.
func TerminalRows() int {
	ws, err := unix.IoctlGetWinsize(int(os.Stdout.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		return 0
	}
	return int(ws.Row)
}

// TerminalColumns is the terminal width in columns (TIOCGWINSZ), or 0 when not a tty.
func TerminalColumns() int {
	ws, err := unix.IoctlGetWinsize(int(os.Stdout.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		return 0
	}
	return int(ws.Col)
}

// replyTimeoutDeciseconds is VTIME, in tenths of a second: how long a silent terminal costs us.
const replyTimeoutDeciseconds = 2

// maxReplyReads caps a drip-feeding terminal at a few timeouts instead of 120 of them.
const maxReplyReads = 3

// makeRaw is cfmakeraw: no line buffering, no echo, Ctrl-C arrives as a
// byte (0x03); VMIN=1, VTIME=0, i.e. block until a byte arrives.
func makeRaw(t *unix.Termios) {
	t.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP | unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON
	t.Oflag &^= unix.OPOST
	t.Lflag &^= unix.ECHO | unix.ECHONL | unix.ICANON | unix.ISIG | unix.IEXTEN
	t.Cflag &^= unix.CSIZE | unix.PARENB
	t.Cflag |= unix.CS8
	t.Cc[unix.VMIN] = 1
	t.Cc[unix.VTIME] = 0
}

// withRawTty runs f on /dev/tty in raw mode (after tweak), restoring its
// modes after; false when there is no terminal.
func withRawTty(tweak func(*unix.Termios), f func(fd int)) bool {
	fd, err := unix.Open("/dev/tty", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return false
	}
	defer unix.Close(fd)
	saved, err := unix.IoctlGetTermios(fd, ioctlGetTermios)
	if err != nil {
		return false
	}
	raw := *saved
	makeRaw(&raw)
	if tweak != nil {
		tweak(&raw)
	}
	_ = unix.IoctlSetTermios(fd, ioctlSetTermios, &raw)
	defer unix.IoctlSetTermios(fd, ioctlSetTermios, saved)
	f(fd)
	return true
}

var rgbReply = regexp.MustCompile(`rgb:([0-9a-fA-F]{2,4})/([0-9a-fA-F]{2,4})/([0-9a-fA-F]{2,4})`)

// TerminalBackgroundLuma is the perceptual luminance (0 = black, 1 = white)
// of the terminal background, queried via OSC 11, and false if the terminal
// doesn't answer. Must be called BEFORE any TUI takes the terminal over
// (briefly switches the tty to raw mode to read the reply).
func TerminalBackgroundLuma() (float64, bool) {
	var reply string
	// The deadline MUST come from the terminal itself, never from poll():
	// on Darwin poll() answers /dev/tty with POLLNVAL instead of readiness,
	// so a poll guard waves through a read that then blocks FOREVER whenever
	// nothing replies — which is every terminal that swallows the query, a
	// nested tmux (a tmux popup running its own client) being the one people
	// actually hit. Raw mode leaves VMIN=1, i.e. "block until a byte
	// arrives"; VMIN=0 + VTIME makes read() return 0 when the reply doesn't
	// come, so detection stays fail-soft.
	ok := withRawTty(func(t *unix.Termios) {
		t.Cc[unix.VMIN] = 0
		t.Cc[unix.VTIME] = replyTimeoutDeciseconds
	}, func(fd int) {
		if _, err := unix.Write(fd, []byte("\x1b]11;?\x1b\\")); err != nil {
			return
		}
		// Reply: ESC ] 11 ; rgb:RRRR/GGGG/BBBB (ST or BEL terminated).
		buf := make([]byte, 128)
		total := 0
		for reads := 0; total < 120 && reads < maxReplyReads; reads++ {
			n, err := unix.Read(fd, buf[total:120])
			if err != nil || n <= 0 {
				break
			}
			total += n
			if strings.ContainsAny(string(buf[:total]), "\\\a") {
				break
			}
		}
		reply = string(buf[:total])
	})
	if !ok {
		return 0, false
	}
	rgb := rgbReply.FindStringSubmatch(reply)
	if rgb == nil {
		return 0, false
	}
	channel := func(hex string) float64 {
		v, _ := strconv.ParseInt(hex[:2], 16, 32)
		return float64(v) / 255.0
	}
	return 0.2126*channel(rgb[1]) + 0.7152*channel(rgb[2]) + 0.0722*channel(rgb[3]), true
}
