package style

import (
	"fmt"
	"image/color"
	"strings"
	"testing"
	"time"

	"charm.land/bubbles/v2/key"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/exp/charmtone"
)

func plain(s string) string { return ansi.Strip(s) }

func plainLines(lines []string) string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = ansi.Strip(l)
	}
	return strings.Join(out, "\n")
}

func eq(t *testing.T, what, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("%s:\n got: %q\nwant: %q", what, got, want)
	}
}

func widthIs(t *testing.T, what, s string, want int) {
	t.Helper()
	if w := Width(s); w != want {
		t.Errorf("%s: width %d, want %d (%q)", what, w, want, plain(s))
	}
}

var themes = map[string]Theme{"dark": Dark(), "light": Light()}

// --- contrast ---------------------------------------------------------

func TestContrastHelperMatchesWcag(t *testing.T) {
	black, white := color.RGBA{A: 0xff}, color.RGBA{0xff, 0xff, 0xff, 0xff}
	if r := Contrast(black, white); r < 20.99 || r > 21.01 {
		t.Errorf("black/white = %.2f, want 21", r)
	}
	if r := Contrast(white, white); r != 1 {
		t.Errorf("white/white = %.2f, want 1", r)
	}
	// #777777 on white is the textbook 4.48.
	if r := Contrast(color.RGBA{0x77, 0x77, 0x77, 0xff}, white); r < 4.47 || r > 4.49 {
		t.Errorf("#777/white = %.3f, want 4.48", r)
	}
}

type pair struct {
	name   string
	fg, bg color.Color
	min    float64
}

func pairsOf(th Theme) []pair {
	sel := pair{"selected row: OnPrimary on Primary", th.OnPrimary, th.Primary, 4.5}
	return []pair{
		{"FgBase", th.FgBase, th.BgBase, 4.5},
		{"FgSubtle", th.FgSubtle, th.BgBase, 4.5},
		{"FgMoreSubtle", th.FgMoreSubtle, th.BgBase, 4.5},
		{"FgMostSubtle (hints)", th.FgMostSubtle, th.BgBase, 3},
		{"Primary (titles, bar)", th.Primary, th.BgBase, 3},
		{"Secondary (gradient end)", th.Secondary, th.BgBase, 3},
		{"Success", th.Success, th.BgBase, 4.5},
		{"SuccessSubtle", th.SuccessSubtle, th.BgBase, 4.5},
		{"Warning", th.Warning, th.BgBase, 4.5},
		{"Attention", th.Attention, th.BgBase, 4.5},
		{"Busy", th.Busy, th.BgBase, 4.5},
		{"Error", th.Error, th.BgBase, 3},
		{"Destructive", th.Destructive, th.BgBase, 4.5},
		{"Info", th.Info, th.BgBase, 4.5},
		sel,
		{"selected blurred: FgSubtle on BgLess", th.FgSubtle, th.BgLess, 4.5},
		{"blurred button: FgBase on BgLess", th.FgBase, th.BgLess, 4.5},
		{"focused button: OnPrimary on Secondary", th.OnPrimary, th.Secondary, 3},
		{"OKAY! badge", th.Ink(th.Success), th.Success, 3},
		{"WARNING badge", th.Ink(th.Warning), th.Warning, 3},
		{"ERROR badge", th.Ink(th.Destructive), th.Destructive, 3},
		{"HEY! badge", th.Ink(th.Info), th.Info, 3},
	}
}

// Pantera is the spec's palette as Crush ships it: these pairs fall short of
// the bar and are kept on purpose (named here so a change is deliberate).
var darkExceptions = map[string]float64{
	"FgMoreSubtle":                           4.40, // Squid: Crush's secondary text
	"FgMostSubtle (hints)":                   2.60, // Oyster: decoration-level hints
	"Error":                                  4.29, // Sriracha: used with ×, never alone
	"focused button: OnPrimary on Secondary": 2.41, // Butter on Dolly, per spec
}

func TestThemesMeetContrast(t *testing.T) {
	for name, th := range themes {
		for _, p := range pairsOf(th) {
			r := Contrast(p.fg, p.bg)
			want := p.min
			if floor, ok := darkExceptions[p.name]; ok && th.Dark {
				want = floor - 0.01
			}
			if r < want {
				t.Errorf("%s %s: %s on %s = %.2f, want ≥ %.2f", name, p.name, Hex(p.fg), Hex(p.bg), r, want)
			}
		}
	}
}

func TestLightNeedsNoExceptions(t *testing.T) {
	for _, p := range pairsOf(Light()) {
		if r := Contrast(p.fg, p.bg); r < p.min {
			t.Errorf("light %s = %.2f < %.1f", p.name, r, p.min)
		}
	}
}

func TestToastTitlesReadOnTheBackground(t *testing.T) {
	// A card has no fill: its coloured title sits on the terminal's own
	// background, which the theme's BgBase stands for.
	for name, th := range themes {
		for _, k := range []ToastKind{ToastOK, ToastWarning, ToastError, ToastHey} {
			hue, _ := toastHue(th, k)
			if r := Contrast(hue, th.BgBase); r < 3 {
				t.Errorf("%s toast %d: %.2f", name, k, r)
			}
		}
	}
}

func TestInkPicksTheReadableOne(t *testing.T) {
	th := Dark()
	if got := th.Ink(charmtone.Charple); got != th.OnPrimary {
		t.Errorf("on Charple: %s, want Butter", Hex(got))
	}
	if got := th.Ink(charmtone.Citron); Contrast(got, charmtone.Citron) < 4.5 {
		t.Errorf("on Citron: %s reads at %.2f", Hex(got), Contrast(got, charmtone.Citron))
	}
}

func TestDeepenKeepsHueAndReachesTarget(t *testing.T) {
	bg := charmtone.Salt
	d := Deepen(charmtone.Mustard, bg, 4.5)
	if Contrast(d, bg) < 4.5 {
		t.Fatalf("%s: %.2f", Hex(d), Contrast(d, bg))
	}
	r, g, b := rgb8(d)
	if !(r > b && g > b) {
		t.Errorf("deepened mustard %s isn't yellowish", Hex(d))
	}
	if Deepen(charmtone.Pepper, bg, 4.5) != color.Color(charmtone.Pepper) {
		t.Error("a colour already there must come back as is")
	}
}

// --- layout -----------------------------------------------------------

func TestSectionHeaderWidths(t *testing.T) {
	th := Dark()
	eq(t, "plain", plain(Section(th, "Machine", "", 20)), "Machine ────────────")
	eq(t, "info", plain(Section(th, "Runs", "2", 20)), "Runs ───────────── 2")
	eq(t, "info dropped when narrow", plain(Section(th, "Runs", "2 running", 12)), "Runs ───────")
	eq(t, "title cut", plain(Section(th, "Machine", "", 5)), "Mach…")
	for w := 0; w <= 40; w++ {
		widthIs(t, "section", Section(th, "Machine", "5 ok", w), w)
	}
}

func TestTitleRow(t *testing.T) {
	th := Dark()
	eq(t, "info", plain(TitleRow(th, "Remote", "135 updates", 30)), "Remote             135 updates")
	eq(t, "no info", plain(TitleRow(th, "Upgrade", "", 12)), "Upgrade     ")
	eq(t, "info dropped when tight", plain(TitleRow(th, "Remote", "135 updates", 12)), "Remote      ")
	for w := 0; w <= 60; w++ {
		widthIs(t, "title row", TitleRow(th, "Remote", "135 updates · 3 ticked", w), w)
	}
	if strings.Contains(TitleRow(th, "Remote", "x", 30), "╱") {
		t.Error("no hatch")
	}
}

func TestSubjectRowAlignsSummaryRight(t *testing.T) {
	th := Dark()
	g := StatusGlyph(th, StatusOK).Render(th)
	eq(t, "unselected", plain(SubjectRow(th, g, "programs", "69/69", Unselected, 30)), "  ✓ programs             69/69")
	eq(t, "focused", plain(SubjectRow(th, g, "remote", "135", SelectedFocused, 30)), "  ✓ remote                 135")
	if !strings.Contains(SubjectRow(th, g, "remote", "135", SelectedFocused, 30), "48;2;107;80;255") {
		t.Error("the focused subject sits on a Primary fill, like the main pane's selected row")
	}
	if strings.Contains(SubjectRow(th, g, "programs", "69/69", Unselected, 30), "48;2") {
		t.Error("an unselected subject has no fill")
	}
	eq(t, "summary cut first", plain(SubjectRow(th, g, "configs", "2 drifted, 1 edited", Unselected, 20)), "  ✓ configs 2 drift…")
	eq(t, "name cut last", plain(SubjectRow(th, g, "programs", "69/69", Unselected, 10)), "  ✓ progr…")
	for w := 0; w <= 40; w++ {
		widthIs(t, "subject", SubjectRow(th, g, "programs", "69/69", SelectedBlurred, w), w)
	}
}

func TestListRowStates(t *testing.T) {
	th := Dark()
	left := []Span{Tick(th, true), S(" 1password", nil)}
	right := []Span{S("8.12.40 → 8.12.42", nil)}
	eq(t, "row", plain(ListRow(th, left, right, Unselected, 36)), " ◉ 1password      8.12.40 → 8.12.42 ")
	eq(t, "cut", plain(ListRow(th, left, right, SelectedFocused, 20)), " ◉ 1password 8.12.… ")
	for _, f := range []Focus{Unselected, SelectedFocused, SelectedBlurred} {
		for w := 0; w <= 40; w++ {
			widthIs(t, "list row", ListRow(th, left, right, f, w), w)
		}
	}
	sel := ListRow(th, left, right, SelectedFocused, 36)
	if !strings.Contains(sel, "48;2;107;80;255") {
		t.Errorf("focused selection must paint Primary behind the row: %q", sel)
	}
	matched := ListRow(th, []Span{{Text: "brew", Matches: []int{0, 2}}}, nil, Unselected, 10)
	if matched == ListRow(th, []Span{{Text: "brew"}}, nil, Unselected, 10) || !strings.Contains(matched, "\x1b[4;") {
		t.Error("fuzzy matches must be underlined")
	}
}

func TestScrollbar(t *testing.T) {
	th := Dark()
	col := func(total, visible, offset int) string { return plainLines(Scrollbar(th, 5, total, visible, offset)) }
	eq(t, "fits", col(3, 5, 0), " \n \n \n \n ")
	eq(t, "top", col(20, 5, 0), "┃\n│\n│\n│\n│")
	eq(t, "bottom", col(20, 5, 15), "│\n│\n│\n│\n┃")
	eq(t, "nudged", col(100, 5, 1), "│\n┃\n│\n│\n│")
}

func TestTruncationNeverExceedsWidth(t *testing.T) {
	for w := 0; w < 12; w++ {
		widthIs(t, "fit", Fit("loadout · hello", w), w)
	}
	eq(t, "truncate", Truncate("abcdef", 4), "abc…")
}

// --- logo ---------------------------------------------------------------

func TestTitleRowFocusedIsTheSelectedRowsHighlight(t *testing.T) {
	th := Dark()
	row := TitleRowFocused(th, "Run", "loadout install x --yes ✓ done 4s", 50)
	widthIs(t, "focused title", row, 50)
	if !strings.Contains(row, "48;2;107;80;255") {
		t.Error("the focused title sits on the Primary fill")
	}
	eq(t, "focused title", plain(row), plain(ListRow(th, []Span{{Text: "Run", Bold: true}}, []Span{S("loadout install x --yes ✓ done 4s", nil)}, SelectedFocused, 50)))
	if strings.Contains(TitleRowMuted(th, "Run", "x", 50), "48;2") {
		t.Error("a muted title has no fill")
	}
}

func TestSidebarLogo(t *testing.T) {
	th := Dark()
	eq(t, "32", plainLines(SidebarLogo(th, "v4.0.0", 32)), "loadout"+strings.Repeat(" ", 19)+"v4.0.0")
	eq(t, "long version cut", plain(SidebarLogo(th, "v4.0.0-SNAPSHOT+abcdef", 20)[0]), "loadout v4.0.0-SNAP…")
	eq(t, "no room for the version", plain(SidebarLogo(th, "v4.0.0", 8)[0]), "loadout ")
	for w := 0; w <= 40; w++ {
		for _, l := range SidebarLogo(th, "v4.0.0", w) {
			widthIs(t, "brand row", l, w)
		}
	}
	if !strings.Contains(SidebarLogo(th, "v", 32)[0], "\x1b[1;") {
		t.Error("the name is bold")
	}
}

func TestOneLineLogoAndBreadcrumb(t *testing.T) {
	th := Dark()
	eq(t, "one line", plain(OneLineLogo(th, 14)), "loadout       ")
	for w := 0; w <= 20; w++ {
		widthIs(t, "one line", OneLineLogo(th, w), w)
	}
	b := Breadcrumb(th, []string{"programs", "inspect", "git"}, []string{"⟳ run pull", "✓2 ●3"}, 80)
	widthIs(t, "breadcrumb", b, 80)
	eq(t, "breadcrumb", strings.Join(strings.Fields(plain(b)), " "), "loadout › programs › inspect › git ⟳ run pull ✓2 ●3")
	eq(t, "the right's parts drop from the end", strings.Join(strings.Fields(plain(Breadcrumb(th, []string{"programs"}, []string{"⟳ run pull", "✓2 ●3"}, 36))), " "), "loadout › programs ⟳ run pull")
	for w := 0; w <= 80; w++ {
		widthIs(t, "breadcrumb", Breadcrumb(th, []string{"t2-macbook-omarchy"}, []string{"⟳ install kitty", "✓2 ●3"}, w), w)
	}
}

// --- dialog -------------------------------------------------------------

func TestDialogFrame(t *testing.T) {
	th := Dark()
	d := Dialog{
		Title:   "Upgrade",
		Info:    "2 steps",
		Body:    []string{"omarchy   omarchy update -y", "brew      brew upgrade"},
		Buttons: []string{"Run", "Cancel"},
		Focused: 0,
		Help:    "←→ choose • enter press • esc cancel",
	}
	got := plainLines(d.Render(th, 120, 40))
	want := strings.Join([]string{
		"╭──────────────────────────────────────╮",
		"│ Upgrade                      2 steps │",
		"│                                      │",
		"│ omarchy   omarchy update -y          │",
		"│ brew      brew upgrade               │",
		"│                                      │",
		"│                    Run      Cancel   │",
		"│                                      │",
		"│ ←→ choose • enter press • esc cancel │",
		"╰──────────────────────────────────────╯",
	}, "\n")
	eq(t, "frame", got, want)

	// Caps: 70 wide, 20 tall by default; the body is cut, never the frame.
	long := Dialog{Title: "List", Body: make([]string, 50)}
	for i := range long.Body {
		long.Body[i] = strings.Repeat("x", 200)
	}
	lines := long.Render(th, 200, 60)
	if len(lines) != DialogMaxHeight {
		t.Errorf("height %d, want %d", len(lines), DialogMaxHeight)
	}
	for _, l := range lines {
		widthIs(t, "capped", l, DialogMaxWidth)
	}
	long.MaxWidth = DialogWideMaxWidth
	widthIs(t, "wide", long.Render(th, 200, 60)[0], DialogWideMaxWidth)
	// The screen caps too.
	small := long.Render(th, 30, 8)
	if len(small) > 8 {
		t.Errorf("small screen: %d rows", len(small))
	}
	for _, l := range small {
		widthIs(t, "small screen", l, 30)
	}
}

func TestOverlayPlacement(t *testing.T) {
	bg := []string{"aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"}
	fg := []string{"XX", "YY"}
	eq(t, "at", plainLines(Overlay(bg, fg, 3, 1)), "aaaaaaaaaa\nbbbXXbbbbb\ncccYYccccc\ndddddddddd")
	eq(t, "centre", plainLines(Center(bg, fg, 10, 4)), "aaaaaaaaaa\nbbbbXXbbbb\nccccYYcccc\ndddddddddd")
	eq(t, "past short lines", plainLines(Overlay([]string{"ab"}, []string{"Z"}, 4, 0)), "ab  Z")
	eq(t, "past the bottom", plainLines(Overlay([]string{"ab"}, []string{"Z"}, 0, 2)), "ab\n\nZ")
	// a wide rune split by the edge leaves a space, never a shifted row
	got := plainLines(Overlay([]string{"世界世界"}, []string{"Z"}, 1, 0))
	eq(t, "wide, left edge", got, " Z界世界")
	eq(t, "wide, right edge", plainLines(Overlay([]string{"世界世界"}, []string{"Z"}, 0, 0)), "Z 界世界")
	// styles of the background don't leak into the overlay and resume after
	styled := Fg(charmtone.Coral, "rrrrrrrr")
	out := Overlay([]string{styled}, []string{"Z"}, 2, 0)[0]
	eq(t, "styled", plain(out), "rrZrrrrr")
	if !strings.Contains(out, ansi.ResetStyle+"Z") {
		t.Errorf("overlay must reset before its own cells: %q", out)
	}
}

// --- status ---------------------------------------------------------------

func TestHelpLine(t *testing.T) {
	th := Dark()
	b := []key.Binding{
		key.NewBinding(key.WithKeys("ctrl+]"), key.WithHelp("ctrl+]", "dashboard")),
		key.NewBinding(key.WithKeys("ctrl+c"), key.WithHelp("ctrl+c", "interrupt")),
		key.NewBinding(key.WithKeys("ctrl+g"), key.WithHelp("ctrl+g", "help")),
	}
	eq(t, "short", plain(HelpLine(th, b, 80)), " ctrl+] dashboard • ctrl+c interrupt • ctrl+g help")
	if w := Width(HelpLine(th, b, 30)); w > 30 {
		t.Errorf("help at 30 is %d wide", w)
	}
	full := plain(FullHelp(th, [][]key.Binding{b[:2], b[2:]}, 80))
	eq(t, "full", full, "ctrl+] dashboard    ctrl+g help\nctrl+c interrupt               ")
}

func TestToastCardAndExpiry(t *testing.T) {
	th := Dark()
	var m Toasts
	m.TTL = 5 * time.Millisecond
	first := m.Show(ToastOK, "synced")
	eq(t, "card", plainLines(m.Card(th, 80)), strings.Join([]string{
		"╭────────╮",
		"│ ✓ Done │",
		"│ synced │",
		"╰────────╯",
	}, "\n"))
	second := m.Show(ToastError, "a command is running")
	// The first toast's timer fires: the second keeps showing.
	if !m.Update(first()) || !m.Active() {
		t.Fatal("an older toast's expiry must not take the new one down")
	}
	msg := second()
	if _, ok := msg.(ToastExpiredMsg); !ok {
		t.Fatalf("expiry is a ToastExpiredMsg, got %T", msg)
	}
	m.Update(msg)
	if m.Active() || m.Card(th, 80) != nil {
		t.Error("the toast must expire")
	}
	if m.Update("other") {
		t.Error("only toast messages are the toast's")
	}
}

func TestToastCardWrapsFitsAndPaintsNoBackground(t *testing.T) {
	th := Dark()
	long := "configs not checked: chezmoi could not read the source state because a template failed to render"
	card := ToastCard(th, ToastWarning, long, 40)
	w := Width(card[0])
	for i, l := range card {
		widthIs(t, fmt.Sprintf("card row %d", i), l, w)
		if strings.Contains(l, "48;2") {
			t.Errorf("row %d paints a background: %q", i, l)
		}
	}
	if w > 40 {
		t.Errorf("the card is %d wide, given 40", w)
	}
	eq(t, "title", strings.TrimSpace(strings.Trim(plain(card[1]), "│")), "! Warning")
	if len(card) > 2+1+toastLines {
		t.Errorf("the card has %d rows", len(card))
	}
	eq(t, "titles", strings.Join([]string{
		strings.TrimSpace(strings.Trim(plain(ToastCard(th, ToastError, "x", 40)[1]), "│")),
		strings.TrimSpace(strings.Trim(plain(ToastCard(th, ToastHey, "x", 40)[1]), "│")),
	}, " / "), "× Error / • Note")
	if ToastCard(th, ToastOK, "x", 6) != nil {
		t.Error("no card where none fits")
	}
}

// --- animation --------------------------------------------------------

func TestBusyClockStopsWhenNothingIsBusy(t *testing.T) {
	b := NewBusy()
	b.Interval = time.Millisecond
	if b.Sync(false) != nil || b.Running() {
		t.Fatal("idle: no ticking")
	}
	cmd := b.Sync(true)
	if cmd == nil || !b.Running() {
		t.Fatal("busy: the clock starts")
	}
	if b.Sync(true) != nil {
		t.Fatal("one clock: starting a running clock adds no second timer")
	}
	next, ok := b.Update(cmd())
	if !ok || next == nil || b.Frame() != 1 {
		t.Fatalf("a tick advances and schedules the next (ok %v, frame %d)", ok, b.Frame())
	}
	b.Sync(false)
	stale := next() // a Tick command fires once
	if again, ok := b.Update(stale); !ok || again != nil {
		t.Fatal("stopped: the pending tick is dropped and nothing more is scheduled")
	}
	if b.Frame() != 1 {
		t.Error("a stopped clock doesn't advance")
	}
	// Restarted: the old generation's tick still does nothing.
	restart := b.Sync(true)
	if c, _ := b.Update(stale); c != nil {
		t.Error("a stale tick after a restart must not double the clock")
	}
	fresh := restart()
	if c, _ := b.Update(fresh); c == nil {
		t.Error("the new tick keeps going")
	}
	other := NewBusy()
	if _, ok := other.Update(fresh); ok {
		t.Error("another clock's tick isn't mine")
	}
}

func TestBusyGlyphIsABrailleSpinner(t *testing.T) {
	th := Dark()
	seen := map[string]bool{}
	for f := range 10 {
		g := plain(BusyGlyph(th, f))
		widthIs(t, "glyph", BusyGlyph(th, f), 1)
		if !strings.Contains("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", g) {
			t.Errorf("frame %d is %q, not a braille spinner frame", f, g)
		}
		seen[g] = true
	}
	if len(seen) != 10 {
		t.Errorf("every frame shows: %d of 10", len(seen))
	}
	eq(t, "it loops", plain(BusyGlyph(th, 0)), plain(BusyGlyph(th, 10)))
	eq(t, "label", plain(BusyLabel(th, 2, "checking…")), "⠹ checking…")
}

func TestCanvas(t *testing.T) {
	eq(t, "canvas", plainLines(Canvas([]string{"abc", "toolong"}, 4, 3)), "abc \ntoo…\n    ")
}
