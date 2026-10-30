package style

import (
	"sync/atomic"
	"time"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
)

// busySpinner is the busy glyph: Bubbles' MiniDot braille spinner
// (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏), at its own pace. One cell, calm, and unlike any status
// glyph (● means "needs attention" in the sidebar), so a row being checked
// never reads as a verdict (user decision, replacing scrambling glyphs).
var busySpinner = spinner.MiniDot

// BusyTickMsg advances a Busy clock. Ticks of a stopped (or restarted) clock
// are dropped, so a stop really stops.
type BusyTickMsg struct {
	id, gen uint64
}

var busyIDs atomic.Uint64

// Busy is the one shared clock every busy row animates from: it ticks at
// the spinner's pace while something is busy and not at all otherwise. Rows draw their
// own frame from Frame (Run / Inline), so a hundred busy rows cost one
// timer.
type Busy struct {
	id      uint64
	gen     uint64
	frame   int
	running bool
	// Interval overrides the spinner's pace (tests).
	Interval time.Duration
}

// NewBusy is a stopped clock.
func NewBusy() *Busy { return &Busy{id: busyIDs.Add(1)} }

// Running says the clock ticks.
func (b *Busy) Running() bool { return b.running }

// Frame is the clock's current frame.
func (b *Busy) Frame() int { return b.frame }

// Start makes the clock tick; already running, it does nothing (nil).
func (b *Busy) Start() tea.Cmd {
	if b.running {
		return nil
	}
	b.running = true
	b.gen++
	return b.tick()
}

// Stop ends the ticking: the pending tick is dropped when it arrives.
func (b *Busy) Stop() {
	if b.running {
		b.running = false
		b.gen++
	}
}

// Sync starts or stops the clock to match whether anything is busy: call it
// after every update that may change that (and Sync(false) on exit).
func (b *Busy) Sync(anyBusy bool) tea.Cmd {
	if anyBusy {
		return b.Start()
	}
	b.Stop()
	return nil
}

// Update advances on this clock's current tick and schedules the next; it
// reports whether msg was this clock's tick (a stale one counts, returning
// no command).
func (b *Busy) Update(msg tea.Msg) (tea.Cmd, bool) {
	m, ok := msg.(BusyTickMsg)
	if !ok || m.id != b.id {
		return nil, false
	}
	if !b.running || m.gen != b.gen {
		return nil, true
	}
	b.frame++
	return b.tick(), true
}

func (b *Busy) tick() tea.Cmd {
	id, gen := b.id, b.gen
	d := b.Interval
	if d <= 0 {
		d = busySpinner.FPS
	}
	return tea.Tick(d, func(time.Time) tea.Msg { return BusyTickMsg{id: id, gen: gen} })
}

// BusyGlyph is a busy row's status slot at frame: the spinner's frame in
// Primary. Every row shows the same frame: one calm rhythm on the screen.
func BusyGlyph(t Theme, frame int) string {
	frames := busySpinner.Frames
	return Fg(t.Primary, frames[((frame%len(frames))+len(frames))%len(frames)])
}

// BusyLabel is the spinner then label in FgMostSubtle: `⠹ checking…`.
func BusyLabel(t Theme, frame int, label string) string {
	return BusyGlyph(t, frame) + " " + Fg(t.FgMostSubtle, label)
}
