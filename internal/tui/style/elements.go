package style

import (
	"github.com/charmbracelet/x/ansi"
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
)

// Ramp is n colours blending from → to (n ≥ 1).
func Ramp(n int, from, to color.Color) []color.Color {
	if n <= 0 {
		return nil
	}
	if n == 1 {
		return []color.Color{from}
	}
	return lipgloss.Blend1D(n, from, to)
}

// Gradient is s with a per-cell horizontal gradient from → to; spaces stay
// plain (they show no colour anyway).
func Gradient(s string, from, to color.Color, bold bool) string {
	runes := []rune(s)
	if len(runes) == 0 {
		return ""
	}
	ramp := Ramp(len(runes), from, to)
	var b strings.Builder
	for i, r := range runes {
		if r == ' ' {
			b.WriteRune(r)
			continue
		}
		st := lipgloss.NewStyle().Foreground(ramp[i])
		if bold {
			st = st.Bold(true)
		}
		b.WriteString(st.Render(string(r)))
	}
	return b.String()
}

// TitleRow is a pane or dialog title row, exactly width cells:
// `Title          info` — the title bold in Primary, info (already styled,
// or plain: FgMoreSubtle) at the right, spaces between. Narrow widths drop
// info first, then cut the title.
func TitleRow(t Theme, title, info string, width int) string {
	return titleRow(t, t.Primary, title, info, width)
}

// TitleRowFocused is the title row of the area that has the focus: the
// same highlight as a focused list's selected row (ListRow), a full-width
// Primary fill with OnPrimary ink and the title bold, so tab lands on
// something that stands out in every area, the run panel included (user
// decision). info's own colours give way to the fill's ink.
func TitleRowFocused(t Theme, title, info string, width int) string {
	if width <= 0 {
		return ""
	}
	return ListRow(t, []Span{{Text: title, Bold: true}}, []Span{S(ansi.Strip(info), nil)}, SelectedFocused, width)
}

// TitleRowMuted is TitleRow for an area without the focus: the title in
// FgMoreSubtle, so the focused area's purple title is the one that reads.
func TitleRowMuted(t Theme, title, info string, width int) string {
	return titleRow(t, t.FgMoreSubtle, title, info, width)
}

// Divider is the colour of the rules between the screen's areas (the
// sidebar's edge, the line above the run panel): BgMost, quiet but
// visible on the terminal's own background, transparent included.
func Divider(t Theme, s string) string { return Fg(t.BgMost, s) }

func titleRow(t Theme, c color.Color, title, info string, width int) string {
	if width <= 0 {
		return ""
	}
	tw := Width(title)
	iw := Width(info)
	if info != "" && tw+2+iw > width {
		info, iw = "", 0
	}
	if tw >= width {
		return Fit(boldFg(c, Truncate(title, width)), width)
	}
	if info == "" {
		return boldFg(c, title) + strings.Repeat(" ", width-tw)
	}
	return boldFg(c, title) + strings.Repeat(" ", width-tw-iw) + styledOr(info, t.FgMoreSubtle)
}

// Section is a sidebar/main section header, exactly width cells:
// `Title ────────── info` — title in FgMostSubtle, the rule in Separator,
// info (styled, or plain: FgMostSubtle) at the right.
func Section(t Theme, title, info string, width int) string {
	if width <= 0 {
		return ""
	}
	tw, iw := Width(title), Width(info)
	if info != "" && tw+1+2+1+iw > width {
		info, iw = "", 0
	}
	if tw+1 >= width {
		return Fit(Fg(t.FgMostSubtle, Truncate(title, width)), width)
	}
	rule := width - tw - 1
	tail := ""
	if info != "" {
		rule -= iw + 1
		tail = " " + styledOr(info, t.FgMostSubtle)
	}
	return Fg(t.FgMostSubtle, title) + " " + Fg(t.Separator, strings.Repeat(GlyphRule, rule)) + tail
}

// None is an empty section's placeholder.
func None(t Theme) string { return Fg(t.FgMostSubtle, "None") }

// styledOr colours plain s in c; styled s is left as the caller made it.
func styledOr(s string, c color.Color) string {
	if strings.ContainsRune(s, '\x1b') {
		return s
	}
	return Fg(c, s)
}

// Focus is a row's selection state.
type Focus int

const (
	// Unselected is a plain row.
	Unselected Focus = iota
	// SelectedFocused is the cursor's row in the focused area.
	SelectedFocused
	// SelectedBlurred is the cursor's row while its area isn't focused: kept,
	// in a dimmer tone.
	SelectedBlurred
)

// SubjectRow is a sidebar subject, exactly width cells:
// `▌ ● name            summary`. glyph is one styled cell (a status glyph
// or a busy frame). Unselected: name FgMoreSubtle, summary FgMostSubtle.
// The selected row stands out like the main pane's: the whole row on a
// fill — Primary with OnPrimary ink and a bold name when the sidebar has
// the focus, BgLess with FgSubtle when it doesn't. No bar.
// The summary is cut first when space runs out; summaries line up.
func SubjectRow(t Theme, glyph, name, summary string, focus Focus, width int) string {
	if width <= 0 {
		return ""
	}
	if glyph == "" {
		glyph = " "
	}
	var fg, bg color.Color
	bold := false
	switch focus {
	case SelectedFocused:
		fg, bg, bold = t.OnPrimary, t.Primary, true
	case SelectedBlurred:
		fg, bg = t.FgSubtle, t.BgLess
	default:
		lead := "  " + glyph + " "
		return Fit(lead+spread(t, []Span{S(name, t.FgMoreSubtle)}, []Span{S(summary, t.FgMostSubtle)}, width-Width(lead), nil, nil), width)
	}
	// Selected: the whole row on a fill, like the main pane's selected row,
	// with no bar (user decision); the glyph keeps its column and takes the
	// fill's ink so it stays legible.
	if width < 3 {
		return lipgloss.NewStyle().Background(bg).Render(strings.Repeat(" ", width))
	}
	fill := lipgloss.NewStyle().Background(bg).Render("  ")
	left := []Span{S(ansi.Strip(glyph)+" ", nil), {Text: name, Bold: bold}}
	return fill + spread(t, left, []Span{S(summary, nil)}, width-2, fg, bg)
}

// spread lays left and right spans over width cells: right flush right,
// cut first, left cut after; one space at least between them.
func spread(t Theme, left, right []Span, width int, fg, bg color.Color) string {
	if width <= 0 {
		return ""
	}
	lw, rw := spansWidth(left), spansWidth(right)
	if rw > 0 && lw+1+rw > width {
		right = truncateSpans(right, max(width-lw-1, 0))
		if spansWidth(right) < 2 { // a lone "…" says nothing
			right = nil
		}
		rw = spansWidth(right)
	}
	gapMin := 0
	if rw > 0 {
		gapMin = 1
	}
	left = truncateSpans(left, width-rw-gapMin)
	lw = spansWidth(left)
	gap := strings.Repeat(" ", max(width-lw-rw, 0))
	if bg != nil {
		gap = lipgloss.NewStyle().Background(bg).Render(gap)
	}
	return renderSpans(left, t.FgBase, fg, bg) + gap + renderSpans(right, t.FgMostSubtle, fg, bg)
}

// ListRow is a main-pane list row, exactly width cells, Padding(0,1): left
// spans (default FgBase) and right spans (an info column, default
// FgMostSubtle) flush right. Selected in the focused area: the full width on
// Primary with OnPrimary ink; selected while blurred: BgLess with FgSubtle.
func ListRow(t Theme, left, right []Span, focus Focus, width int) string {
	if width <= 0 {
		return ""
	}
	var fg, bg color.Color
	switch focus {
	case SelectedFocused:
		fg, bg = t.OnPrimary, t.Primary
	case SelectedBlurred:
		fg, bg = t.FgSubtle, t.BgLess
	}
	if width < 3 {
		return Fit(renderSpans(truncateSpans(left, width), t.FgBase, fg, bg), width)
	}
	pad := " "
	if bg != nil {
		pad = lipgloss.NewStyle().Background(bg).Render(" ")
	}
	return pad + spread(t, left, right, width-2, fg, bg) + pad
}

// Tick is a tick-list box: ◉ ticked (Primary), ○ not (FgMostSubtle).
func Tick(t Theme, ticked bool) Span {
	if ticked {
		return S(GlyphTicked, t.Primary)
	}
	return S(GlyphUnticked, t.FgMostSubtle)
}

// Fold is a tree group's fold mark: ▾ open, ▸ shut (FgMoreSubtle).
func Fold(t Theme, open bool) Span {
	if open {
		return S(GlyphFoldOpen, t.FgMoreSubtle)
	}
	return S(GlyphFoldShut, t.FgMoreSubtle)
}

// Status is what a status glyph says.
type Status int

const (
	StatusOK          Status = iota // ✓ Success
	StatusDone                      // ✓ SuccessSubtle (a finished run)
	StatusPending                   // ● Warning: something to do
	StatusAttention                 // ● Attention
	StatusFailed                    // × Error
	StatusInterrupted               // × Attention
	StatusRunning                   // ⟳ Busy
	StatusIdle                      // ○ FgMostSubtle
)

// StatusGlyph is the one-cell glyph for s.
func StatusGlyph(t Theme, s Status) Span {
	switch s {
	case StatusOK:
		return S(GlyphCheck, t.Success)
	case StatusDone:
		return S(GlyphCheck, t.SuccessSubtle)
	case StatusPending:
		return S(GlyphDot, t.Warning)
	case StatusAttention:
		return S(GlyphDot, t.Attention)
	case StatusFailed:
		return S(GlyphCross, t.Error)
	case StatusInterrupted:
		return S(GlyphCross, t.Attention)
	case StatusRunning:
		return S(GlyphRunning, t.Busy)
	}
	return S(GlyphUnticked, t.FgMostSubtle)
}

// Render is a lone span styled (nil Fg = FgBase).
func (s Span) Render(t Theme) string { return renderSpans([]Span{s}, t.FgBase, nil, nil) }

// Scrollbar is a height-cell column for a list of total rows showing
// visible of them from offset: thumb `┃` in Secondary over a `│` track in
// Separator. Everything fits: blank cells.
func Scrollbar(t Theme, height, total, visible, offset int) []string {
	out := make([]string, max(height, 0))
	if height <= 0 {
		return out
	}
	if total <= visible || visible <= 0 {
		for i := range out {
			out[i] = " "
		}
		return out
	}
	thumb := max(height*visible/total, 1)
	maxOffset := total - visible
	offset = min(max(offset, 0), maxOffset)
	start := 0
	if maxOffset > 0 {
		start = (height - thumb) * offset / maxOffset
		if offset > 0 && start == 0 { // moved at all: show it moved
			start = min(1, height-thumb)
		}
	}
	thumbCell, trackCell := Fg(t.Secondary, GlyphThumb), Fg(t.Separator, GlyphTrack)
	for i := range out {
		if i >= start && i < start+thumb {
			out[i] = thumbCell
		} else {
			out[i] = trackCell
		}
	}
	return out
}
