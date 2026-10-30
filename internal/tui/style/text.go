package style

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// Glyphs the screen uses. One cell each.
const (
	GlyphDot       = "●"
	GlyphCheck     = "✓"
	GlyphCross     = "×"
	GlyphDiamond   = "◇"
	GlyphDiamondOn = "◆"
	GlyphMore      = "⋯"
	GlyphRunning   = "⟳"
	GlyphArrow     = "→"
	GlyphUp        = "↑"
	GlyphTicked    = "◉"
	GlyphUnticked  = "○"
	GlyphTrack     = "│"
	GlyphThumb     = "┃"
	GlyphRule      = "─"
	GlyphBullet    = "•"
	GlyphCrumb     = "›"
	GlyphFoldOpen  = "▾"
	GlyphFoldShut  = "▸"
	Ellipsis       = "…"
)

// Width is s's width in cells, styles ignored.
func Width(s string) int { return ansi.StringWidth(s) }

// Truncate cuts s (styled or not) to at most width cells, ending in "…" when
// it cut. Width ≤ 0 is "".
func Truncate(s string, width int) string {
	if width <= 0 {
		return ""
	}
	return ansi.Truncate(s, width, Ellipsis)
}

// Fit is s cut or padded with spaces to exactly width cells.
func Fit(s string, width int) string {
	if width <= 0 {
		return ""
	}
	s = Truncate(s, width)
	if w := Width(s); w < width {
		s += strings.Repeat(" ", width-w)
	}
	return s
}

// Fg is s in colour c.
func Fg(c color.Color, s string) string {
	if s == "" {
		return ""
	}
	return lipgloss.NewStyle().Foreground(c).Render(s)
}

// Span is a piece of a row: text in a colour (nil = the row's default),
// optionally bold, with the rune positions a fuzzy filter matched
// (underlined).
type Span struct {
	Text    string
	Fg      color.Color
	Bold    bool
	Matches []int
}

// S is a Span of text in c.
func S(text string, c color.Color) Span { return Span{Text: text, Fg: c} }

func spansWidth(spans []Span) int {
	w := 0
	for _, s := range spans {
		w += Width(s.Text)
	}
	return w
}

// truncateSpans cuts spans to width cells, the last kept one ending in "…".
func truncateSpans(spans []Span, width int) []Span {
	if spansWidth(spans) <= width {
		return spans
	}
	if width <= 0 {
		return nil
	}
	var out []Span
	left := width - 1 // room for the ellipsis
	for _, s := range spans {
		w := Width(s.Text)
		if w <= left {
			out = append(out, s)
			left -= w
			continue
		}
		cut := s
		cut.Text = ansi.Truncate(s.Text, left, "") + Ellipsis
		out = append(out, cut)
		return out
	}
	return out
}

// renderSpans styles spans; fg, when not nil, overrides every span's colour
// (a selected row's ink), bg paints behind them, def is the colour of spans
// without one.
func renderSpans(spans []Span, def, fg, bg color.Color) string {
	var b strings.Builder
	for _, s := range spans {
		st := lipgloss.NewStyle()
		c := s.Fg
		if c == nil {
			c = def
		}
		if fg != nil {
			c = fg
		}
		if c != nil {
			st = st.Foreground(c)
		}
		if bg != nil {
			st = st.Background(bg)
		}
		if s.Bold {
			st = st.Bold(true)
		}
		b.WriteString(underlineMatches(st, s.Text, s.Matches))
	}
	return b.String()
}

// Underline is text in st with the runes at matches (rune indices, as a
// fuzzy matcher reports them) underlined.
func Underline(st lipgloss.Style, text string, matches []int) string {
	return underlineMatches(st, text, matches)
}

func underlineMatches(st lipgloss.Style, text string, matches []int) string {
	if text == "" {
		return ""
	}
	if len(matches) == 0 {
		return st.Render(text)
	}
	hit := make(map[int]bool, len(matches))
	for _, m := range matches {
		hit[m] = true
	}
	ul := st.Underline(true)
	var b strings.Builder
	var run []rune
	runHit := false
	flush := func() {
		if len(run) == 0 {
			return
		}
		if runHit {
			b.WriteString(ul.Render(string(run)))
		} else {
			b.WriteString(st.Render(string(run)))
		}
		run = run[:0]
	}
	for i, r := range []rune(text) {
		if hit[i] != runHit {
			flush()
			runHit = hit[i]
		}
		run = append(run, r)
	}
	flush()
	return b.String()
}
