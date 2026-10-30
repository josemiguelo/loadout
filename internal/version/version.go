// Package version is loadout's own version: the one place it's written.
package version

import (
	"strconv"
	"strings"
)

// Version is this binary's version; release builds may override it with
// -ldflags "-X github.com/josemiguelo/loadout/internal/version.Version=…".
var Version = "4.0.0"

// InstallCommand is the curl|sh bootstrap — used by `loadout self-upgrade`
// and the floor refusal.
const InstallCommand = "curl -fsSL https://raw.githubusercontent.com/josemiguelo/loadout/master/install.sh | sh"

// AtLeast is the numeric dotted-version comparison:
// is current >= required? A part that isn't a number counts as 0.
func AtLeast(current, required string) bool {
	c := parts(current)
	r := parts(required)
	for i := 0; i < max(len(c), len(r)); i++ {
		a, b := at(c, i), at(r, i)
		if a != b {
			return a > b
		}
	}
	return true
}

func parts(v string) []int {
	fields := strings.Split(v, ".")
	out := make([]int, len(fields))
	for i, f := range fields {
		n, err := strconv.ParseInt(f, 10, 32)
		if err == nil {
			out[i] = int(n)
		}
	}
	return out
}

func at(xs []int, i int) int {
	if i < len(xs) {
		return xs[i]
	}
	return 0
}
