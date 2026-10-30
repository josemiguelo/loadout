package cli

import (
	"fmt"
	"sync"

	"github.com/josemiguelo/loadout/internal/core/platform"
	"github.com/josemiguelo/loadout/internal/theme"
)

// styler is ANSI styling for CLI screens, using the SAME Tokyo Night / Day
// palette as the home screen (internal/theme) so every surface speaks one
// visual language — same roles too: ok/warn/error/dim as statuses, accent
// for headers/actions, machine for machine identity. Color is signal, never
// decoration. Dark vs light is settled once, at the first styled output
// (LOADOUT_THEME if set, else an OSC 11 background query, COLORFGBG
// fallback, dark default) — only when stdout is a TTY, so piped output stays
// plain and never touches the terminal.
// Style AFTER padding — escape codes would break padEnd widths.
type styler struct {
	once    sync.Once
	enabled bool
	palette theme.ThemePalette
}

// Style is the CLI's one styler.
var Style = &styler{}

func (s *styler) init() {
	s.once.Do(func() {
		s.enabled = platform.IsStdoutTty()
		s.palette = theme.Dark
		if s.enabled && !theme.TerminalIsDark() {
			s.palette = theme.Light
		}
	})
}

// Enabled says whether output is styled (stdout is a terminal).
func (s *styler) Enabled() bool { s.init(); return s.enabled }

// Palette is the palette output is styled with.
func (s *styler) Palette() theme.ThemePalette { s.init(); return s.palette }

func (s *styler) Ok(text string) string      { return s.fg(text, s.Palette().Ok) }
func (s *styler) Warn(text string) string    { return s.fg(text, s.Palette().Warn) }
func (s *styler) Error(text string) string   { return s.fg(text, s.Palette().Error) }
func (s *styler) Dim(text string) string     { return s.fg(text, s.Palette().Dim) }
func (s *styler) Accent(text string) string  { return s.fg(text, s.Palette().Accent) }
func (s *styler) Machine(text string) string { return s.fg(text, s.Palette().Machine) }

func (s *styler) Bold(text string) string {
	if !s.Enabled() {
		return text
	}
	return "\x1b[1m" + text + "\x1b[0m"
}

// Header is bold accent — section headers, mirroring the TUI's title styling.
func (s *styler) Header(text string) string { return s.Bold(s.Accent(text)) }

func (s *styler) fg(text string, c theme.Rgb) string {
	if !s.Enabled() {
		return text
	}
	return fmt.Sprintf("\x1b[38;2;%d;%d;%dm%s\x1b[0m", c.R, c.G, c.B, text)
}

// Help's roles, as Clikt mapped the palette onto Mordant's theme: warning =
// section titles, info = option/argument/command names, muted = metavars,
// danger = errors. Reset to the default foreground, as Mordant does.
func (s *styler) helpFg(text string, c theme.Rgb) string {
	if !s.Enabled() || text == "" {
		return text
	}
	return fmt.Sprintf("\x1b[38;2;%d;%d;%dm%s\x1b[39m", c.R, c.G, c.B, text)
}

func (s *styler) helpTitle(text string) string  { return s.helpFg(text, s.Palette().Warn) }
func (s *styler) helpName(text string) string   { return s.helpFg(text, s.Palette().Accent) }
func (s *styler) helpMuted(text string) string  { return s.helpFg(text, s.Palette().Dim) }
func (s *styler) helpDanger(text string) string { return s.helpFg(text, s.Palette().Error) }
