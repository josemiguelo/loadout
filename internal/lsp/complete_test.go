package lsp

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"

	"github.com/josemiguelo/loadout/internal/hclconf"
)

// Completion at the `|` in a source.

var analysis = &hclconf.Analysis{Declarations: []hclconf.Declaration{
	{Kind: "installer", Name: "brew"},
	{Kind: "installer", Name: "omarchy"},
	{Kind: "installer", Name: "brew", Range: &hcl.Range{Filename: "installers.loadout.hcl"}},
	{Kind: "program", Name: "git", Range: &hcl.Range{Filename: "cli.loadout.hcl"}},
	{Kind: "script", Name: "setup-git", Range: &hcl.Range{Filename: "cli.loadout.hcl"}},
	{Kind: "script", Name: "setup-ssh"},
	{Kind: "local", Name: "everyday", Range: &hcl.Range{Filename: "loadout.hcl"}},
	{Kind: "machine", Name: "t2", Range: &hcl.Range{Filename: "machines.loadout.hcl"}},
}}

// completeAt is what completion offers at the `|` in src: each item as
// `label` and, when it replaces typed text, `label/<replaced>`.
func completeAt(t *testing.T, src string, encoding string) []string {
	t.Helper()
	off := strings.Index(src, "|")
	text := []byte(src[:off] + src[off+1:])
	line := strings.Count(src[:off], "\n")
	list := complete(text, off, line, encoding, analysis)
	var out []string
	for _, it := range list.Items {
		r := it.TextEdit.Range
		start := toOffset(text, r.Start, encoding)
		end := toOffset(text, r.End, encoding)
		if end != off {
			t.Errorf("%s replaces up to %d, not the cursor (%d)", it.Label, end, off)
		}
		label := it.Label
		if start != end {
			label += "/" + string(text[start:end])
		}
		out = append(out, label)
	}
	return out
}

func TestAKindAndADotOfferThatKindsNames(t *testing.T) {
	equalSlices(t, completeAt(t, "machine \"m\" {\n  install = [program.|]\n}", encodingUTF16), []string{"git"})
	equalSlices(t, completeAt(t, "machine \"m\" {\n  run = [script.|", encodingUTF16), []string{"setup-git", "setup-ssh"})
	equalSlices(t, completeAt(t, "locals {\n  x = [local.|", encodingUTF16), []string{"everyday"})
}

func TestAPartialNameIsReplacedWholeHyphensIncluded(t *testing.T) {
	equalSlices(t, completeAt(t, "  run_after = [script.setup-g|", encodingUTF16), []string{"setup-git/setup-g", "setup-ssh/setup-g"})
	equalSlices(t, completeAt(t, "  run = args(script.se|, \"x\")", encodingUTF16), []string{"setup-git/se", "setup-ssh/se"})
}

func TestABuiltInTheRepoRedefinesIsOfferedOnceFromTheRepo(t *testing.T) {
	list := complete([]byte("x = installer."), 14, 0, encodingUTF16, analysis)
	if len(list.Items) != 2 || list.Items[0].Detail != "installer · installers.loadout.hcl" || list.Items[1].Detail != "built-in installer (or the parent's)" {
		t.Errorf("items: %+v", list.Items)
	}
}

func TestAValueStartOffersInstallersAndKinds(t *testing.T) {
	want := []string{"brew/b", "omarchy/b", "program./b", "script./b", "profile./b", "installer./b", "local./b"}
	equalSlices(t, completeAt(t, "program \"x\" {\n  install_via = [b|", encodingUTF16), want)
	equalSlices(t, completeAt(t, "program \"x\" {\n  install_via = [\n    brew,\n    b|", encodingUTF16), want)
	equalSlices(t, completeAt(t, "  depends_on = b|", encodingUTF16), want)
}

func TestNothingIsOfferedWhereNoReferenceGoes(t *testing.T) {
	for name, src := range map[string]string{
		"an attribute's name":         "program \"x\" {\n  inst|",
		"after a value on its line":   "program \"x\" {\n  install_via = [brew]\n  |",
		"a string":                    "script \"x\" {\n  run = \"echo program.|",
		"a closed string's neighbour": "script \"x\" {\n  run = \"a\"\n  check = \"program.|",
		"a comment":                   "program \"x\" {\n  # see program.|",
		"a block comment":             "program \"x\" {\n  /* program.| */",
		"a heredoc":                   "script \"x\" {\n  run = <<-EOT\n    program.|",
		"an unknown kind":             "  install = [machine.|",
		"a block's label":             "program \"|",
	} {
		t.Run(name, func(t *testing.T) {
			if got := completeAt(t, src, encodingUTF16); len(got) != 0 {
				t.Errorf("offered %q", got)
			}
		})
	}
}

func TestWhatCloses(t *testing.T) {
	// Closed strings, comments and heredocs before the cursor don't hide it.
	src := "script \"x\" {\n  # a comment with program.\n  /* [ */\n  run = <<-EOT\n    [ program.\n  EOT\n  check = \"[\"\n  run_after = [script.|"
	equalSlices(t, completeAt(t, src, encodingUTF16), []string{"setup-git", "setup-ssh"})
}

func TestTheCursorIsReadInTheNegotiatedEncoding(t *testing.T) {
	src := "  # ñ𝄞\n  run_after = [/*ñ𝄞*/script.se|"
	for _, encoding := range []string{encodingUTF8, encodingUTF16} {
		equalSlices(t, completeAt(t, src, encoding), []string{"setup-git/se", "setup-ssh/se"})
	}
}

func TestCompletionInAnEditorSession(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"loadout.hcl": repoEntry, "programs/jq.loadout.hcl": `program "jq" { install_via = [brew] }`})
	// Declared only in an unsaved buffer, and completed in another.
	fresh := filepath.Join(dir, "programs/new.loadout.hcl")
	entry := filepath.Join(dir, "loadout.hcl")
	edited := strings.Replace(repoEntry, "install = [program.jq]", "install = [program.jq, program.]", 1)
	completion := jsonOf(t, map[string]any{"jsonrpc": "2.0", "id": 7, "method": "textDocument/completion", "params": map[string]any{
		"textDocument": map[string]any{"uri": uriOf(entry)},
		"position":     map[string]any{"line": 7, "character": 33},
	}})
	replies, _, _ := session(t, frame(initializeIn(t, dir),
		didOpen(t, fresh, `program "yq" { install_via = [brew] }`),
		didOpen(t, entry, edited),
		completion, shutdown, exit))
	var labels []string
	for _, r := range replies {
		if r["id"] == 7.0 {
			for _, it := range r["result"].(map[string]any)["items"].([]any) {
				labels = append(labels, it.(map[string]any)["label"].(string))
			}
		}
	}
	slices.Sort(labels)
	equalSlices(t, labels, []string{"jq", "yq"})
}

func equalSlices[T comparable](t *testing.T, got, want []T) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}
