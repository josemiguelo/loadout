package theme

import (
	"errors"
	"strings"
	"testing"
)

func TestOscLumaWinsOverColorFgBg(t *testing.T) {
	if !DetectDarkTerminal(0.08, true, "") {
		t.Error("a dark background is dark")
	}
	if DetectDarkTerminal(0.93, true, "15;0") {
		t.Error("a light background is light, whatever COLORFGBG says")
	}
}

func TestColorFgBgFallbackAndUnknownDefaultsDark(t *testing.T) {
	cases := []struct {
		fgbg string
		dark bool
	}{
		{"15;0", true},
		{"0;15", false},
		{"0;7", false},
		{"", true},
		{"garbage", true},
		{"12;default;15", false},
	}
	for _, c := range cases {
		if got := DetectDarkTerminal(0, false, c.fgbg); got != c.dark {
			t.Errorf("COLORFGBG %q: dark = %v, want %v", c.fgbg, got, c.dark)
		}
	}
}

func TestLoadoutThemeAnswersForTerminalsThatCannotBeAsked(t *testing.T) {
	cases := []struct {
		value        string
		dark, forced bool
	}{
		{"dark", true, true},
		{"light", false, true},
		{" LIGHT ", false, true},
		{"", false, false},
	}
	for _, c := range cases {
		dark, forced, err := ForcedDark(c.value)
		if err != nil || dark != c.dark || forced != c.forced {
			t.Errorf("%q: got (%v, %v, %v), want (%v, %v)", c.value, dark, forced, err, c.dark, c.forced)
		}
	}
}

func TestAnUnreadableLoadoutThemeIsRefusedNotIgnored(t *testing.T) {
	// Ignoring it would look exactly like the bug it was set to fix.
	_, _, err := ForcedDark("lite")
	var refusal *ThemeException
	if !errors.As(err, &refusal) || !strings.Contains(err.Error(), "lite") {
		t.Fatalf("want a ThemeException naming the value, got %v", err)
	}
}

func TestHexIsLipGlossColour(t *testing.T) {
	if got := Dark.Accent.Hex(); got != "#7aa2f7" {
		t.Errorf("got %s", got)
	}
}
