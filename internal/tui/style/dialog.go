package style

import (
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// Dialog caps from the spec: 70×20 unless the content needs more; a wide
// dialog (the confirm's step lines) may grow to 100.
const (
	DialogMaxWidth     = 70
	DialogMaxHeight    = 20
	DialogWideMaxWidth = 100
)

// Dialog is a centred overlay's frame and content. Body lines come
// pre-styled (rows from ListRow etc.); the frame cuts what doesn't fit.
type Dialog struct {
	Title string
	// Info sits at the title row's right.
	Info string
	Body []string
	// Buttons are labels; Focused is the focused one's index (-1: none).
	Buttons []string
	Focused int
	// Help is the bottom hint line (plain: FgMostSubtle).
	Help string
	// Destructive draws the border in Destructive instead of Primary.
	Destructive bool
	// Width is the inner width wanted (0: fit the content). MaxWidth and
	// MaxHeight cap the whole frame (0: DialogMaxWidth/DialogMaxHeight).
	Width, MaxWidth, MaxHeight int
}

// dialog chrome: border 1 each side + Padding(0,1) inside.
const dialogHChrome = 4

// Button is one dialog button: focused OnPrimary on Secondary, bold;
// blurred FgBase on BgLess. Padding(0,2).
func Button(t Theme, label string, focused bool) string {
	st := lipgloss.NewStyle().Padding(0, 2)
	if focused {
		st = st.Foreground(t.OnPrimary).Background(t.Secondary).Bold(true)
	} else {
		st = st.Foreground(t.FgBase).Background(t.BgLess)
	}
	return st.Render(label)
}

// Buttons are labels side by side, two cells apart.
func Buttons(t Theme, labels []string, focused int) string {
	parts := make([]string, len(labels))
	for i, l := range labels {
		parts[i] = Button(t, l, i == focused)
	}
	return strings.Join(parts, "  ")
}

// Render is the dialog as lines, for a screen of screenW × screenH cells:
// rounded border, the hatch title row, a blank line, the body, the buttons
// (right-aligned) and the help line, each section separated by a blank line.
// The frame never exceeds the caps or the screen; the body is cut first.
func (d Dialog) Render(t Theme, screenW, screenH int) []string {
	maxW, maxH := d.MaxWidth, d.MaxHeight
	if maxW <= 0 {
		maxW = DialogMaxWidth
	}
	if maxH <= 0 {
		maxH = DialogMaxHeight
	}
	maxW = min(maxW, screenW)
	maxH = min(maxH, screenH)
	if maxW < dialogHChrome+1 || maxH < 3 {
		return nil
	}

	buttons := Buttons(t, d.Buttons, d.Focused)
	inner := d.Width
	if inner <= 0 {
		inner = Width(d.Title) + 1 + 8
		if d.Info != "" {
			inner += Width(d.Info) + 1
		}
		for _, l := range d.Body {
			inner = max(inner, Width(l))
		}
		inner = max(inner, Width(buttons), Width(d.Help))
	}
	inner = min(inner, maxW-dialogHChrome)

	var rows []string
	rows = append(rows, TitleRow(t, d.Title, d.Info, inner))
	var tail []string
	if len(d.Buttons) > 0 {
		b := Truncate(buttons, inner)
		tail = append(tail, "", strings.Repeat(" ", max(inner-Width(b), 0))+b)
	}
	if d.Help != "" {
		tail = append(tail, "", styledOr(Truncate(d.Help, inner), t.FgMostSubtle))
	}
	bodyRoom := maxH - 2 - len(rows) - len(tail)
	if len(d.Body) > 0 && bodyRoom >= 2 {
		rows = append(rows, "")
		body := d.Body
		if len(body) > bodyRoom-1 {
			body = body[:bodyRoom-1]
		}
		for _, l := range body {
			rows = append(rows, Truncate(l, inner))
		}
	}
	if len(rows)+len(tail)+2 <= maxH {
		rows = append(rows, tail...)
	}

	border := t.Primary
	if d.Destructive {
		border = t.Destructive
	}
	bs := lipgloss.NewStyle().Foreground(border)
	rb := lipgloss.RoundedBorder()
	out := make([]string, 0, len(rows)+2)
	out = append(out, bs.Render(rb.TopLeft+strings.Repeat(rb.Top, inner+2)+rb.TopRight))
	side := bs.Render(rb.Left)
	for _, r := range rows {
		out = append(out, side+" "+Fit(r, inner)+" "+bs.Render(rb.Right))
	}
	out = append(out, bs.Render(rb.BottomLeft+strings.Repeat(rb.Bottom, inner+2)+rb.BottomRight))
	return out
}

// Overlay draws fg's lines over bg's at column x, row y (cells), keeping
// bg's cells left and right of each fg line; bg is padded with blank lines
// and spaces where it's short. No dimming. Lines are styled strings.
func Overlay(bg, fg []string, x, y int) []string {
	out := make([]string, max(len(bg), y+len(fg)))
	copy(out, bg)
	x = max(x, 0)
	for i, line := range fg {
		row := y + i
		if row < 0 {
			continue
		}
		base := out[row]
		fw := Width(line)
		left := ansi.Truncate(base, x, "")
		if lw := Width(left); lw < x { // short line, or a wide rune split
			left += strings.Repeat(" ", x-lw)
		}
		right := ""
		if Width(base) > x+fw {
			right = ansi.TruncateLeft(base, x+fw, "")
			// a wide rune straddling the edge comes back whole: blank its
			// covered half instead
			if Width(right) > Width(base)-(x+fw) {
				right = " " + ansi.TruncateLeft(base, x+fw+1, "")
			}
		}
		out[row] = left + ansi.ResetStyle + line + ansi.ResetStyle + right
	}
	return out
}

// Center is fg drawn centred over bg on a width × height screen.
func Center(bg, fg []string, width, height int) []string {
	fw := 0
	for _, l := range fg {
		fw = max(fw, Width(l))
	}
	return Overlay(bg, fg, max((width-fw)/2, 0), max((height-len(fg))/2, 0))
}
