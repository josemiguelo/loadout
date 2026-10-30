// Package style is the home screen's look: Charmtone colours (Crush's
// "Pantera" dark and a light variant designed here), and pure rendering
// helpers — wordmark, title rows, section headers, rows, dialogs, the status
// bar, toasts and the busy animation — that the screen composes. Nothing here
// holds screen state beyond the small toast and animation models.
//
// Colour roles map onto internal/theme's (the CLI keeps its own palette):
// ok = Success/SuccessSubtle, warn = Warning, error = Error, dim =
// FgMoreSubtle/FgMostSubtle, accent = Primary, machine = Secondary.
package style

import (
	"image/color"
	"math"

	"github.com/charmbracelet/x/exp/charmtone"
)

// Theme is every colour token of the screen. Names follow the spec's table;
// the comments name the Charmtone colour the dark theme uses.
type Theme struct {
	Dark bool

	Primary   color.Color // Charple: focus, titles, borders, selection
	Secondary color.Color // Dolly: gradient end, scrollbar thumb, focused button
	Accent    color.Color // Bok

	BgBase    color.Color // Pepper: the app background
	BgLeast   color.Color // BBQ
	BgLess    color.Color // Char: blurred buttons, dim selection
	BgMost    color.Color // Iron: unfocused selection bar
	Separator color.Color // Char: rules, the help separator, scrollbar track

	FgBase       color.Color // Sash: body text
	FgSubtle     color.Color // Smoke
	FgMoreSubtle color.Color // Squid: names, help keys
	FgMostSubtle color.Color // Oyster: summaries, help descriptions, hints
	OnPrimary    color.Color // Butter: text on Primary / Secondary fills

	Success       color.Color // Julep
	SuccessSubtle color.Color // Guac
	Warning       color.Color // Mustard
	Attention     color.Color // Tang
	Busy          color.Color // Citron
	Error         color.Color // Sriracha
	Destructive   color.Color // Coral
	Info          color.Color // Malibu
}

// Dark is Charmtone Pantera, Crush's theme.
func Dark() Theme {
	return Theme{
		Dark:          true,
		Primary:       charmtone.Charple,
		Secondary:     charmtone.Dolly,
		Accent:        charmtone.Bok,
		BgBase:        charmtone.Pepper,
		BgLeast:       charmtone.BBQ,
		BgLess:        charmtone.Char,
		BgMost:        charmtone.Iron,
		Separator:     charmtone.Char,
		FgBase:        charmtone.Sash,
		FgSubtle:      charmtone.Smoke,
		FgMoreSubtle:  charmtone.Squid,
		FgMostSubtle:  charmtone.Oyster,
		OnPrimary:     charmtone.Butter,
		Success:       charmtone.Julep,
		SuccessSubtle: charmtone.Guac,
		Warning:       charmtone.Mustard,
		Attention:     charmtone.Tang,
		Busy:          charmtone.Citron,
		Error:         charmtone.Sriracha,
		Destructive:   charmtone.Coral,
		Info:          charmtone.Malibu,
	}
}

// Light is the same roles on Salt. Neutrals step down the Charmtone greys
// (Pepper → Char → Oyster → Squid) so every text tier still reads; Primary
// stays Charple (4.6:1 on Salt); Secondary is Urchin, Dolly's darker
// neighbour, for the gradients. Charmtone has no yellow, orange or green dark
// enough for text on a light background, so those statuses keep their
// Charmtone hue and are deepened (scaled toward black) until they reach 4.5:1
// on Salt; Error is Pom and SuccessSubtle Gator, Charmtone's own deep red
// and green.
func Light() Theme {
	bg := color.Color(charmtone.Salt)
	return Theme{
		Dark:          false,
		Primary:       charmtone.Charple,
		Secondary:     charmtone.Urchin,
		Accent:        charmtone.Oceania,
		BgBase:        bg,
		BgLeast:       charmtone.Sash,
		BgLess:        charmtone.Steep,
		BgMost:        charmtone.Smoke,
		Separator:     charmtone.Steep,
		FgBase:        charmtone.Pepper,
		FgSubtle:      charmtone.Char,
		FgMoreSubtle:  charmtone.Oyster,
		FgMostSubtle:  charmtone.Squid,
		OnPrimary:     charmtone.Butter,
		Success:       Deepen(charmtone.Guac, bg, 4.5),
		SuccessSubtle: charmtone.Gator,
		Warning:       Deepen(charmtone.Mustard, bg, 4.5),
		Attention:     Deepen(charmtone.Tang, bg, 4.5),
		Busy:          Deepen(charmtone.Citron, bg, 4.5),
		Error:         charmtone.Pom,
		Destructive:   Deepen(charmtone.Coral, bg, 4.5),
		Info:          Deepen(charmtone.Malibu, bg, 4.5),
	}
}

// For is the theme for a dark (true) or light terminal; internal/theme's
// TerminalIsDark decides which.
func For(dark bool) Theme {
	if dark {
		return Dark()
	}
	return Light()
}

// Ink is the text colour to put on fill: the default ink (t.OnPrimary) when
// it reads at 4.5:1, else whichever of OnPrimary, FgBase and BgBase
// contrasts most.
func (t Theme) Ink(fill color.Color) color.Color {
	if Contrast(t.OnPrimary, fill) >= 4.5 {
		return t.OnPrimary
	}
	return BestInk(fill, t.OnPrimary, t.FgBase, t.BgBase)
}

// BestInk is the candidate with the highest contrast against fill.
func BestInk(fill color.Color, candidates ...color.Color) color.Color {
	var best color.Color
	bestRatio := -1.0
	for _, c := range candidates {
		if r := Contrast(c, fill); r > bestRatio {
			best, bestRatio = c, r
		}
	}
	return best
}

// Luminance is a colour's WCAG 2 relative luminance, 0 (black) to 1 (white).
func Luminance(c color.Color) float64 {
	r, g, b := rgb8(c)
	lin := func(v uint8) float64 {
		s := float64(v) / 255
		if s <= 0.03928 {
			return s / 12.92
		}
		return math.Pow((s+0.055)/1.055, 2.4)
	}
	return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)
}

// Contrast is the WCAG 2 contrast ratio of two colours, 1 to 21. Body text
// wants 4.5, large text and badges 3.
func Contrast(a, b color.Color) float64 {
	la, lb := Luminance(a), Luminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

// Deepen scales c toward black, keeping its hue, until it contrasts at least
// target with bg (a light background). c already there comes back as is.
func Deepen(c, bg color.Color, target float64) color.Color {
	if Contrast(c, bg) >= target {
		return c
	}
	r, g, b := rgb8(c)
	for f := 0.99; f > 0; f -= 0.01 {
		d := color.RGBA{R: uint8(float64(r) * f), G: uint8(float64(g) * f), B: uint8(float64(b) * f), A: 0xff}
		if Contrast(d, bg) >= target {
			return d
		}
	}
	return color.RGBA{A: 0xff}
}

// Mix is a over b at weight w (0 = all b, 1 = all a), in sRGB: subtler
// fills of a hue over the background.
func Mix(a, b color.Color, w float64) color.Color {
	ar, ag, ab := rgb8(a)
	br, bg, bb := rgb8(b)
	m := func(x, y uint8) uint8 { return uint8(math.Round(float64(x)*w + float64(y)*(1-w))) }
	return color.RGBA{R: m(ar, br), G: m(ag, bg), B: m(ab, bb), A: 0xff}
}

// Hex is c as `#rrggbb`.
func Hex(c color.Color) string {
	const digits = "0123456789abcdef"
	r, g, b := rgb8(c)
	out := []byte{'#', 0, 0, 0, 0, 0, 0}
	for i, v := range []uint8{r, g, b} {
		out[1+2*i] = digits[v>>4]
		out[2+2*i] = digits[v&0xf]
	}
	return string(out)
}

func rgb8(c color.Color) (r, g, b uint8) {
	if c == nil {
		return 0, 0, 0
	}
	R, G, B, _ := c.RGBA()
	return uint8(R >> 8), uint8(G >> 8), uint8(B >> 8)
}
