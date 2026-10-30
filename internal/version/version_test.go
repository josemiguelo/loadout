package version

import "testing"

func TestVersionComparisonIsNumericNotLexicographic(t *testing.T) {
	cases := []struct {
		current, required string
		want              bool
	}{
		{"0.10.0", "0.9.0", true},
		{"1.0", "0.99.99", true},
		{"0.2.0", "0.2", true},
		{"0.2.0", "0.2.1", false},
		{"0.2.0", "0.2.0", true},
	}
	for _, c := range cases {
		if got := AtLeast(c.current, c.required); got != c.want {
			t.Errorf("AtLeast(%q, %q) = %v, want %v", c.current, c.required, got, c.want)
		}
	}
}
