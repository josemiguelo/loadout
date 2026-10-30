package cli

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/josemiguelo/loadout/internal/version"
)

// capture is what f echoes on stdout (tests run without a terminal, so
// nothing is styled).
func capture(t *testing.T, f func()) string {
	t.Helper()
	var b bytes.Buffer
	saved := stdout
	stdout = &b
	defer func() { stdout = saved }()
	f()
	return b.String()
}

func golden(t *testing.T, name string) string {
	t.Helper()
	text, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return strings.ReplaceAll(string(text), "{{VERSION}}", version.Version)
}

// The layout Clikt printed, off a terminal (79 columns): the same bytes.
func TestHelpIsLaidOutAsCliktDid(t *testing.T) {
	root := NewRoot()
	if got, want := renderHelp(root), golden(t, "root-help-head.txt"); !strings.HasPrefix(got, want) {
		t.Errorf("root help:\n%s\nwant it to start with:\n%s", got, want)
	}
	for _, sub := range root.Commands() {
		if sub.Name() == "upgrade" {
			if got, want := renderHelp(sub), golden(t, "upgrade-help.txt"); got != want {
				t.Errorf("upgrade help:\n%s\nwant:\n%s", got, want)
			}
		}
	}
}

func TestCommandHelpAlignsTheDetailLines(t *testing.T) {
	got := commandHelp("Do it.", "--a  first", "--long  second", "[x]")
	want := "Do it.\n  --a     first\n  --long  second\n  [x]"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestWrapKeepsIndentationAndBreaksAtTheLastSpaceThatFits(t *testing.T) {
	got := wrap("  --item x  one two three\nshort", 15)
	want := []string{"  --item x  one", "two three", "short"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestSuggestionsAreCliktsDidYouMean(t *testing.T) {
	if got := suggest("--jsn", []string{"--json", "--no-write", "--help"}, "options"); got != ". Did you mean --json?" {
		t.Errorf("got %q", got)
	}
	if got := suggest("--verbos", []string{"--version", "--repo", "--machine", "--verbose", "--help"}, "options"); got != ". (Possible options: --verbose, --version, --repo)" {
		t.Errorf("got %q", got)
	}
	if got := suggest("help", []string{"status", "install"}, "subcommands"); got != "" {
		t.Errorf("got %q", got)
	}
}

func TestUnsettledRowsShareOneBoxThatIsSevereIfAnyRowIs(t *testing.T) {
	out := capture(t, func() {
		echoRows([]TableRow{
			{Lines: []string{"ok row"}},
			{Lines: []string{"pending"}, Severity: attention},
			{Lines: []string{"missing", "  detail"}, Severity: severe},
			{Lines: []string{"last"}},
		})
	})
	want := "  ok row\n" +
		"╭──────────╮\n" +
		"│ pending  │\n" +
		"│ missing  │\n" +
		"│   detail │\n" +
		"╰──────────╯\n" +
		"  last\n"
	if out != want {
		t.Errorf("got\n%s\nwant\n%s", out, want)
	}
}

func TestScaffoldValuesAreEscapedInsideHclStrings(t *testing.T) {
	files, err := renderScaffold("child", scaffoldVars{Hostname: "box", ParentName: `my "pub"`, ParentPath: "~/${x}"})
	if err != nil {
		t.Fatal(err)
	}
	paths := map[string]string{}
	for _, f := range files {
		paths[f.path] = string(f.content)
	}
	if _, ok := paths["machines/box.loadout.hcl"]; !ok {
		t.Fatalf("the machine file is named by its hostname: %v", paths)
	}
	root := paths["loadout.hcl"]
	if !strings.Contains(root, `name = "my \"pub\""`) || !strings.Contains(root, `path = "~/$${x}"`) {
		t.Errorf("the parent block escapes its values:\n%s", root)
	}
	for p := range paths {
		if strings.Contains(p, "gradle") || strings.HasSuffix(p, ".kt") {
			t.Errorf("no Kotlin or Gradle file: %s", p)
		}
	}
}
