package style

import (
	"image/color"
	"strings"
	"sync/atomic"
	"time"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// HelpStyles are bubbles/help's styles in t: keys FgMoreSubtle (Squid),
// descriptions FgMostSubtle (Oyster), separators Separator (Char).
func HelpStyles(t Theme) help.Styles {
	key := lipgloss.NewStyle().Foreground(t.FgMoreSubtle)
	desc := lipgloss.NewStyle().Foreground(t.FgMostSubtle)
	sep := lipgloss.NewStyle().Foreground(t.Separator)
	return help.Styles{
		Ellipsis:       sep,
		ShortKey:       key,
		ShortDesc:      desc,
		ShortSeparator: sep,
		FullKey:        key,
		FullDesc:       desc,
		FullSeparator:  sep,
	}
}

// NewHelp is a bubbles/help model styled in t, `•` between short items.
func NewHelp(t Theme, width int) help.Model {
	h := help.New()
	h.Styles = HelpStyles(t)
	h.ShortSeparator = " " + GlyphBullet + " "
	h.SetWidth(width)
	return h
}

// HelpLine is the status bar's short help: `key desc • key desc`, cut with
// `…` to width (one cell of left padding).
func HelpLine(t Theme, bindings []key.Binding, width int) string {
	if width <= 1 {
		return ""
	}
	return " " + NewHelp(t, width-1).ShortHelpView(bindings)
}

// FullHelp is help's full view: one column per group, as wide as width.
func FullHelp(t Theme, groups [][]key.Binding, width int) string {
	return NewHelp(t, width).FullHelpView(groups)
}

// ToastKind is a toast's kind: its colour, icon and title.
type ToastKind int

const (
	ToastOK      ToastKind = iota // ✓ Done, Success
	ToastWarning                  // ! Warning, Warning
	ToastError                    // × Error, Destructive
	ToastHey                      // • Note, Info
)

// ToastTTL is how long a toast's card shows.
const ToastTTL = 4 * time.Second

// ToastExpiredMsg ends the toast with its ID (a later toast keeps showing).
type ToastExpiredMsg struct{ ID uint64 }

var toastIDs atomic.Uint64

// Toasts is the screen's notification: at most one card shows; a new one
// replaces it and restarts the clock.
type Toasts struct {
	kind    ToastKind
	message string
	id      uint64
	shown   bool
	// TTL overrides ToastTTL (tests).
	TTL time.Duration
}

// Show puts message up; the command expires it after the TTL.
func (m *Toasts) Show(kind ToastKind, message string) tea.Cmd {
	m.kind, m.message, m.shown = kind, message, true
	m.id = toastIDs.Add(1)
	id, ttl := m.id, m.TTL
	if ttl <= 0 {
		ttl = ToastTTL
	}
	return tea.Tick(ttl, func(time.Time) tea.Msg { return ToastExpiredMsg{ID: id} })
}

// Update takes a ToastExpiredMsg for the showing toast down; it reports
// whether msg was a toast message at all.
func (m *Toasts) Update(msg tea.Msg) bool {
	e, ok := msg.(ToastExpiredMsg)
	if !ok {
		return false
	}
	if e.ID == m.id {
		m.shown = false
	}
	return true
}

// Active says a toast is showing (it replaces the help line).
func (m Toasts) Active() bool { return m.shown }

// Message is the showing toast's text.
func (m Toasts) Message() (ToastKind, string) { return m.kind, m.message }

// View is the toast row, exactly width cells: the bold badge on its hue,
// then the message on a subtler fill of the same hue to the end. "" when
// Card is the showing toast as a floating card, nil when none shows: see
// ToastCard.
func (m Toasts) Card(t Theme, maxWidth int) []string {
	if !m.shown {
		return nil
	}
	return ToastCard(t, m.kind, m.message, maxWidth)
}

// ToastCard is a notification as a small card, the dialogs' language
// (user decision, replacing a full-width band): a rounded border in the
// kind's colour, its icon and title bold in that colour, the message below
// in FgBase, wrapped, at most toastLines lines. Nothing inside is filled, so
// a transparent terminal stays transparent. Width fits the text, capped at
// maxWidth (and toastMaxWidth).
func ToastCard(t Theme, kind ToastKind, message string, maxWidth int) []string {
	hue, title := toastHue(t, kind)
	message = strings.Join(strings.Fields(message), " ")
	inner := min(max(Width(title), Width(message)), toastMaxWidth, maxWidth-4)
	if inner < 4 {
		return nil
	}
	head := lipgloss.NewStyle().Bold(true).Foreground(hue).Render(Truncate(title, inner))
	lines := []string{Fit(head, inner)}
	for i, l := range wrap(message, inner) {
		if i == toastLines {
			lines[len(lines)-1] = Fit(Truncate(ansi.Strip(lines[len(lines)-1])+" …", inner), inner)
			break
		}
		lines = append(lines, Fit(Fg(t.FgBase, l), inner))
	}
	border := lipgloss.NewStyle().Foreground(hue)
	out := []string{border.Render("╭" + strings.Repeat("─", inner+2) + "╮")}
	for _, l := range lines {
		out = append(out, border.Render("│")+" "+l+" "+border.Render("│"))
	}
	return append(out, border.Render("╰"+strings.Repeat("─", inner+2)+"╯"))
}

const (
	// toastMaxWidth is a card's widest text; toastLines its most message lines.
	toastMaxWidth = 48
	toastLines    = 3
)

// wrap is text broken into lines of at most width cells, at spaces; a word
// longer than width is cut.
func wrap(text string, width int) []string {
	var lines []string
	line := ""
	for _, w := range strings.Fields(text) {
		switch {
		case line == "":
			line = Truncate(w, width)
		case Width(line)+1+Width(w) <= width:
			line += " " + w
		default:
			lines = append(lines, line)
			line = Truncate(w, width)
		}
	}
	if line != "" {
		lines = append(lines, line)
	}
	return lines
}

func toastHue(t Theme, kind ToastKind) (color.Color, string) {
	switch kind {
	case ToastWarning:
		return t.Warning, "! Warning"
	case ToastError:
		return t.Destructive, "× Error"
	case ToastHey:
		return t.Info, "• Note"
	}
	return t.Success, "✓ Done"
}
