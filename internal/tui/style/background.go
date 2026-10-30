package style

import "strings"

// Canvas is lines made exactly width × height cells: short lines padded with
// spaces, long ones cut, missing rows blank, extra rows dropped. Cells
// without a style keep the terminal's own background, so a transparent
// terminal stays transparent: the screen never paints one.
func Canvas(lines []string, width, height int) []string {
	out := make([]string, max(height, 0))
	blank := strings.Repeat(" ", max(width, 0))
	for i := range out {
		if i < len(lines) {
			out[i] = Fit(lines[i], width)
		} else {
			out[i] = blank
		}
	}
	return out
}
