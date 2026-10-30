package cli

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// TableRow is one printed row: usually a single line, plus any detail lines
// under it. Severity nil = settled, false = needs attention (warn), true =
// severe (error).
type TableRow struct {
	Lines    []string
	Severity *bool
}

var (
	attention = new(bool)
	severe    = func() *bool { b := true; return &b }()
)

var ansi = regexp.MustCompile("\x1b\\[[0-9;]*m")

// printedWidth is the visible width of a styled string — escape codes take no columns.
func printedWidth(text string) int { return utf8.RuneCountInString(ansi.ReplaceAllString(text, "")) }

// padEnd pads s with spaces to width characters, as Kotlin's padEnd does.
func padEnd(s string, width int) string {
	if n := utf8.RuneCountInString(s); n < width {
		return s + strings.Repeat(" ", width-n)
	}
	return s
}

// echoRows echoes table rows, wrapping the ones that need attention
// (Severity non-nil) in a rounded box. Consecutive attention rows share one
// box, so a run reads as a single block, and the box takes the severe colour
// if any row in it is severe. Plain rows get the same two-column gutter the
// border occupies, so columns line up either way.
func echoRows(rows []TableRow) {
	paint := func(severe bool, text string) string {
		if severe {
			return Style.Error(text)
		}
		return Style.Warn(text)
	}
	width := 0
	for _, row := range rows {
		if row.Severity == nil {
			continue
		}
		for _, line := range row.Lines {
			width = max(width, printedWidth(line))
		}
	}
	isSevere := false
	for index, row := range rows {
		if row.Severity == nil {
			for _, line := range row.Lines {
				echo("  " + line)
			}
			continue
		}
		if index == 0 || rows[index-1].Severity == nil {
			isSevere = false
			for i := index; i < len(rows) && rows[i].Severity != nil; i++ {
				isSevere = isSevere || *rows[i].Severity
			}
			echo(paint(isSevere, "╭"+strings.Repeat("─", width+2)+"╮"))
		}
		for _, line := range row.Lines {
			pad := strings.Repeat(" ", max(width-printedWidth(line), 0))
			echo(paint(isSevere, "│") + " " + line + pad + " " + paint(isSevere, "│"))
		}
		if index == len(rows)-1 || rows[index+1].Severity == nil {
			echo(paint(isSevere, "╰"+strings.Repeat("─", width+2)+"╯"))
		}
	}
}
