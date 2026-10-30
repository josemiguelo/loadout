package style

import (
	"image/color"
	"strings"
)

// Name is the product name as the brand line writes it.
const Name = "loadout"

// SidebarLogo is the sidebar's brand line, exactly width cells: the name
// bold in a Secondary→Primary gradient, the version at the right in
// FgMostSubtle. Plain text: no block letters, no hatch. Narrow widths drop
// the version first, then cut the name.
func SidebarLogo(t Theme, version string, width int) []string {
	if width <= 0 {
		return []string{""}
	}
	name := Gradient(Name, t.Secondary, t.Primary, true)
	nw := Width(Name)
	if width <= nw+1 || version == "" {
		return []string{Fit(name, width)}
	}
	version = Truncate(version, width-nw-1)
	gap := width - nw - Width(version)
	return []string{name + strings.Repeat(" ", gap) + Fg(t.FgMostSubtle, version)}
}

// OneLineLogo is the name alone, bold in a Secondary→Primary gradient,
// exactly width cells.
func OneLineLogo(t Theme, width int) string {
	if width <= 0 {
		return ""
	}
	return Fit(Gradient(Name, t.Secondary, t.Primary, true), width)
}

// Breadcrumb is the stacked layout's header row (user decision: a narrow
// screen shows one page at a time, like a website's mobile view), exactly
// width cells: `loadout › crumb › crumb` at the left — the name bold in the
// brand gradient, the separators in Separator, the crumbs FgMoreSubtle but
// the last, the page you're on, in FgBase — and right's parts (pre-styled,
// or plain: FgMostSubtle) at the right, two cells apart. Parts that don't
// fit are dropped from the end, then the crumbs are cut.
func Breadcrumb(t Theme, crumbs, right []string, width int) string {
	if width <= 0 {
		return ""
	}
	left := Gradient(Name, t.Secondary, t.Primary, true)
	sep := Fg(t.Separator, " "+GlyphCrumb+" ")
	for i, c := range crumbs {
		fg := t.FgMoreSubtle
		if i == len(crumbs)-1 {
			fg = t.FgBase
		}
		left += sep + Fg(fg, c)
	}
	tail := func(parts []string) (string, int) {
		styled := make([]string, len(parts))
		for i, p := range parts {
			styled[i] = styledOr(p, t.FgMostSubtle)
		}
		s := strings.Join(styled, "  ")
		return s, Width(s)
	}
	tailS, tailW := tail(right)
	for len(right) > 0 && Width(left)+2+tailW > width {
		right = right[:len(right)-1]
		tailS, tailW = tail(right)
	}
	if len(right) == 0 {
		return Fit(left, width)
	}
	return Fit(left, width-tailW-2) + "  " + tailS
}

func boldFg(c color.Color, s string) string {
	return renderSpans([]Span{{Text: s, Fg: c, Bold: true}}, nil, nil, nil)
}
