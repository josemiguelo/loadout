// Package theme is the one source of truth for loadout's visual identity,
// shared by the home screen (Lip Gloss colours) and the CLI (24-bit ANSI).
// Color is signal, never decoration: every role below means something
// (ok/warn/error/dim as statuses, accent for headers and actions, machine
// for machine identity).
package theme

import (
	"strconv"
	"strings"

	"github.com/josemiguelo/loadout/internal/core/platform"
)

// Rgb is one 24-bit colour.
type Rgb struct{ R, G, B uint8 }

// Hex is the colour as `#rrggbb`, how Lip Gloss takes it.
func (c Rgb) Hex() string {
	const digits = "0123456789abcdef"
	b := []byte{'#', 0, 0, 0, 0, 0, 0}
	for i, v := range []uint8{c.R, c.G, c.B} {
		b[1+2*i] = digits[v>>4]
		b[2+2*i] = digits[v&0xf]
	}
	return string(b)
}

// ThemePalette is every role a surface paints with.
type ThemePalette struct {
	// Text is body text. Explicit so an overlay can paint over coloured cells.
	Text        Rgb
	Accent      Rgb
	OnAccent    Rgb
	Machine     Rgb
	Dim         Rgb
	Ok          Rgb
	Warn        Rgb
	Error       Rgb
	SelectionBg Rgb
	SelectionFg Rgb
	// IdleBg/IdleFg is an unfocused button; a focused one is Accent/OnAccent.
	IdleBg Rgb
	IdleFg Rgb
}

// Dark is Tokyo Night.
var Dark = ThemePalette{
	Text:     Rgb{0xc0, 0xca, 0xf5},
	Accent:   Rgb{0x7a, 0xa2, 0xf7},
	OnAccent: Rgb{0x1a, 0x1b, 0x26},
	Machine:  Rgb{0xbb, 0x9a, 0xf7},
	// Tokyo Night dark5, not comment (0x565f89): de-emphasized must still be
	// readable — comment-gray drowned on translucent terminal backgrounds.
	Dim:         Rgb{0x73, 0x7a, 0xa2},
	Ok:          Rgb{0x9e, 0xce, 0x6a},
	Warn:        Rgb{0xe0, 0xaf, 0x68},
	Error:       Rgb{0xf7, 0x76, 0x8e},
	SelectionBg: Rgb{0x36, 0x4a, 0x82},
	SelectionFg: Rgb{0xc0, 0xca, 0xf5},
	IdleBg:      Rgb{0x3b, 0x42, 0x61},
	IdleFg:      Rgb{0xa9, 0xb1, 0xd6},
}

// Light is vivid-but-readable on white (GitHub-light-like saturation).
var Light = ThemePalette{
	Text: Rgb{0x37, 0x60, 0xbf},
	// Navy, not GitHub's #0969da: on white the lighter blue sat too close to
	// the dark palette's pastel accent to read as a different mode.
	Accent:      Rgb{0x03, 0x3a, 0x85},
	OnAccent:    Rgb{0xff, 0xff, 0xff},
	Machine:     Rgb{0x82, 0x50, 0xdf},
	Dim:         Rgb{0x6e, 0x77, 0x81},
	Ok:          Rgb{0x1a, 0x7f, 0x37},
	Warn:        Rgb{0x9a, 0x67, 0x00},
	Error:       Rgb{0xd1, 0x24, 0x2f},
	SelectionBg: Rgb{0x2e, 0x33, 0x40},
	SelectionFg: Rgb{0xe5, 0xe9, 0xf0},
	IdleBg:      Rgb{0xd8, 0xde, 0xe4},
	IdleFg:      Rgb{0x24, 0x29, 0x2f},
}

// PaletteFor is the palette for a dark or a light terminal.
func PaletteFor(dark bool) ThemePalette {
	if dark {
		return Dark
	}
	return Light
}

// DetectDarkTerminal says whether the terminal looks dark: from its
// background's luminance (OSC 11, hasLuma false when it didn't answer), else
// the COLORFGBG convention ("<fg>;<bg>", bg 7/15 = light). Unknown -> dark,
// the safer default.
func DetectDarkTerminal(bgLuma float64, hasLuma bool, colorFgBg string) bool {
	if hasLuma {
		return bgLuma < 0.5
	}
	i := strings.LastIndexByte(colorFgBg, ';')
	bg, err := strconv.Atoi(colorFgBg[i+1:])
	if colorFgBg == "" || err != nil {
		return true
	}
	return bg != 7 && bg != 15
}

// ThemeException is a LOADOUT_THEME that is neither dark nor light.
type ThemeException struct{ Message string }

func (e *ThemeException) Error() string { return e.Message }

// Refusal marks it a refusal.
func (*ThemeException) Refusal() {}

// ForcedDark is the palette LOADOUT_THEME asks for: dark (true) or light
// (false), and whether it asks at all ("" = detect one). Some terminals
// can't be asked: a tmux popup running its own tmux client answers no
// background query at all, so a light one gets painted dark. This is the
// explicit answer for those — and being explicit, it also spares the
// terminal the question. A value that is neither is a refusal, not a shrug:
// a typo that silently kept detecting would look exactly like the bug it
// was set to fix. main validates it first, so later callers can ignore the
// error.
func ForcedDark(loadoutTheme string) (dark, forced bool, err error) {
	switch strings.ToLower(strings.TrimSpace(loadoutTheme)) {
	case "":
		return false, false, nil
	case "dark":
		return true, true, nil
	case "light":
		return false, true, nil
	}
	return false, false, &ThemeException{
		Message: `LOADOUT_THEME must be dark or light, not "` + strings.TrimSpace(loadoutTheme) + `"`,
	}
}

// TerminalIsDark is the answer both surfaces use: what LOADOUT_THEME asks
// for, else what the terminal says (an OSC 11 query: call it before a
// screen owns the terminal).
func TerminalIsDark() bool {
	env, _ := platform.EnvVar("LOADOUT_THEME")
	if dark, forced, err := ForcedDark(env); err == nil && forced {
		return dark
	}
	luma, ok := platform.TerminalBackgroundLuma()
	fgbg, _ := platform.EnvVar("COLORFGBG")
	return DetectDarkTerminal(luma, ok, fgbg)
}
