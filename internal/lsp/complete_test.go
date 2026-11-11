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

func at(file string) *hcl.Range { return &hcl.Range{Filename: file} }

var analysis = &hclconf.Analysis{
	Declarations: []hclconf.Declaration{
		{Kind: "installer", Name: "brew"},
		{Kind: "installer", Name: "omarchy"},
		{Kind: "installer", Name: "brew", Range: at("installers.loadout.hcl")},
		{Kind: "installer", Name: "copr", Range: at("installers.loadout.hcl"), Params: []string{"repo", "key"}},
		{Kind: "program", Name: "git", Range: at("cli.loadout.hcl"), Variants: []string{"brew", "omarchy"}},
		{Kind: "script", Name: "setup-git", Range: at("cli.loadout.hcl"), Variants: []string{"arch", "mac"}},
		{Kind: "script", Name: "setup-ssh"},
		{Kind: "profile", Name: "base", Range: at("machines.loadout.hcl")},
		{Kind: "local", Name: "everyday", Range: at("loadout.hcl")},
		{Kind: "function", Name: "pair", Range: at("loadout.hcl")},
		{Kind: "machine", Name: "t2", Range: at("machines.loadout.hcl")},
	},
	HasData: true,
	Data: []hclconf.DataKey{
		{Name: "dark", Kind: "flag"},
		{Name: "editor", Kind: "text"},
		{Name: "tools", Kind: "table", Table: []hclconf.DataKey{{Name: "extra", Kind: "list"}}},
	},
}

type completeOpts struct {
	encoding string
	entry    bool
	analysis *hclconf.Analysis
}

func inEntry(o *completeOpts)     { o.entry = true }
func utf8Encoded(o *completeOpts) { o.encoding = encodingUTF8 }
func withAnalysis(a *hclconf.Analysis) func(*completeOpts) {
	return func(o *completeOpts) { o.analysis = a }
}

type offeredItem struct{ label, newText string }

// itemsAt is the items at the `|` in src: each labelled with its label,
// plus `/<replaced>` when it replaces typed text.
func itemsAt(t *testing.T, src string, opts ...func(*completeOpts)) []offeredItem {
	t.Helper()
	o := completeOpts{encoding: encodingUTF16, analysis: analysis}
	for _, f := range opts {
		f(&o)
	}
	off := strings.Index(src, "|")
	text := []byte(src[:off] + src[off+1:])
	line := strings.Count(src[:off], "\n")
	var out []offeredItem
	for _, it := range complete(text, off, line, o.encoding, o.analysis, o.entry).Items {
		start := toOffset(text, it.TextEdit.Range.Start, o.encoding)
		end := toOffset(text, it.TextEdit.Range.End, o.encoding)
		if end != off {
			t.Errorf("%s replaces up to %d, not the cursor (%d)", it.Label, end, off)
		}
		label := it.Label
		if start != end {
			label += "/" + string(text[start:end])
		}
		out = append(out, offeredItem{label, it.TextEdit.NewText})
	}
	return out
}

// offered is the labels of what completion offers at the `|` in src.
func offered(t *testing.T, src string, opts ...func(*completeOpts)) []string {
	t.Helper()
	var out []string
	for _, it := range itemsAt(t, src, opts...) {
		out = append(out, it.label)
	}
	return out
}

// newText is what accepting label at the `|` in src inserts.
func newText(t *testing.T, src, label string, opts ...func(*completeOpts)) string {
	t.Helper()
	for _, it := range itemsAt(t, src, opts...) {
		if strings.SplitN(it.label, "/", 2)[0] == label {
			return it.newText
		}
	}
	t.Fatalf("%q not offered at %q", label, src)
	return ""
}

// --- Block types and attributes ---

func TestAFilesTopLevelOffersEveryBlockType(t *testing.T) {
	equalSlices(t, offered(t, "scri|"), []string{
		"function/scri", "installer/scri", "locals/scri", "machine/scri", "outdated/scri",
		"profile/scri", "program/scri", "requires/scri", "script/scri",
	})
	equalSlices(t, offered(t, "# a comment\n\n|"), offered(t, "|"))
	equal(t, newText(t, "scri|", "script"), "script \"${1}\" {\n\t$0\n}")
	equal(t, newText(t, "|", "locals"), "locals {\n\t$0\n}")
	// repo only in loadout.hcl, data only while the repo has no schema.
	if got := offered(t, "|", inEntry); !slices.Contains(got, "repo") || slices.Contains(got, "data") {
		t.Errorf("in loadout.hcl: %q", got)
	}
	if got := offered(t, "|", withAnalysis(&hclconf.Analysis{})); !slices.Contains(got, "data") || slices.Contains(got, "repo") {
		t.Errorf("without a schema: %q", got)
	}
	// After the blocks before it.
	equalSlices(t, offered(t, "program \"x\" {\n  install_via = [brew]\n}\n|"), offered(t, "|"))
}

func TestEveryBlockOffersItsAttributesAndBlocks(t *testing.T) {
	variant := []string{"pkg", "command", "installed_by", "managed_by", "version", "present", "regex", "probe", "outdated", "needs_sudo", "depends_on", "params", "spare", "provides"}
	outdated := []string{"name", "command", "upgrade", "needs_sudo"}
	machine := []string{"extends", "data", "spare", "install", "run", "via"}
	for _, c := range []struct {
		name, src string
		want      []string
	}{
		{"repo", "repo {\n  |", []string{"name", "state", "configs", "min_tool_version", "sources", "parent"}},
		{"repo's parent", "repo {\n  parent {\n    |", []string{"name", "path"}},
		{"function", "function \"f\" {\n  |", []string{"params", "variadic_param", "result"}},
		{"installer", "installer \"i\" {\n  |", []string{"probe", "install", "check", "regex", "outdated", "outdated_all", "upgrade", "needs_sudo", "params", "spare"}},
		{"requires", "requires \"brew\" {\n  |", []string{"programs"}},
		{"program", "program \"p\" {\n  |", []string{"description", "tags", "depends_on", "version", "regex", "path", "outdated", "upgrade", "updates_managed_by", "spare", "install_via", "later", "custom", "via"}},
		{"a program's via", "program \"p\" {\n  via \"brew\" {\n    |", variant},
		{"a program's custom", "program \"p\" {\n  custom {\n    |", variant},
		{"provides", "program \"p\" {\n  via \"brew\" {\n    provides \"x\" {\n      |", []string{"at"}},
		{"script", "script \"s\" {\n  |", []string{"description", "file", "run", "check", "managed_by", "needs_sudo", "setup_only", "maintain_only", "transitional", "spare", "updates_managed_by", "run_after", "later", "outdated", "variant"}},
		{"a script's variant", "script \"s\" {\n  variant \"arch\" {\n    |", []string{"file", "run", "check", "managed_by", "run_after", "spare", "transitional"}},
		{"a script's outdated", "script \"s\" {\n  outdated {\n    |", outdated},
		{"outdated", "outdated \"o\" {\n  |", outdated},
		{"profile", "profile \"p\" {\n  |", machine},
		{"machine", "machine \"m\" {\n  |", machine},
		{"a machine's via", "machine \"m\" {\n  via \"brew\" {\n    |", []string{"install"}},
		{"locals", "locals {\n  |", nil},
		{"data", "data {\n  |", nil},
		{"a data table", "data {\n  tools {\n    |", nil},
		{"an unknown block", "program \"x\" {\n  nonsense {\n    |", nil},
	} {
		t.Run(c.name, func(t *testing.T) { equalSlices(t, offered(t, c.src), c.want) })
	}
}

func TestWhatABlockAlreadySetsIsntOfferedAgain(t *testing.T) {
	got := offered(t, "program \"p\" {\n  description = \"x\"\n  install_via = [\n    brew,\n  ]\n  via \"brew\" { pkg = \"x\" }\n  |")
	if slices.Contains(got, "description") || slices.Contains(got, "install_via") || !slices.Contains(got, "tags") || !slices.Contains(got, "via") {
		t.Errorf("offered %q", got)
	}
	// A closed block's attributes are its own.
	if got := offered(t, "program \"p\" {\n  via \"brew\" {\n    pkg = \"x\"\n  }\n  |"); !slices.Contains(got, "description") || slices.Contains(got, "pkg") {
		t.Errorf("offered %q", got)
	}
}

func TestAttributesInsertTheirValuesShape(t *testing.T) {
	for label, want := range map[string]string{
		"description": `description = "${1}"`,
		"tags":        "tags = [${1}]",
		"install_via": "install_via = [${1}]",
		"via":         "via \"${1}\" {\n\t$0\n}",
		"custom":      "custom {\n\t$0\n}",
	} {
		equal(t, newText(t, "program \"p\" {\n  |", label), want)
	}
	equal(t, newText(t, "script \"s\" {\n  |", "needs_sudo"), "needs_sudo = ${1:true}")
	equal(t, newText(t, "script \"s\" {\n  |", "run"), `run = "${1}"`)
	equal(t, newText(t, "machine \"m\" {\n  |", "data"), "data = {\n\t$0\n}")
	equal(t, newText(t, "program \"p\" {\n  via \"copr\" {\n    |", "params"), "params = {\n\t$0\n}")
	equal(t, newText(t, "function \"f\" {\n  |", "result"), "result = ${1}")
}

func TestNothingIsOfferedInABlockHeader(t *testing.T) {
	for _, src := range []string{"program \"x\" |", "program \"x\" {}\nprogram |", "program x |"} {
		equalSlices(t, offered(t, src), nil)
	}
}

// --- Values ---

func TestAReferenceListOffersTheKindsItTakes(t *testing.T) {
	equalSlices(t, offered(t, "program \"p\" {\n  install_via = [b|"), []string{"brew/b", "omarchy/b", "copr/b", "local.everyday/b", "pair/b"})
	equalSlices(t, offered(t, "program \"p\" {\n  depends_on = [|"), []string{"program.git", "local.everyday", "pair"})
	equalSlices(t, offered(t, "script \"s\" {\n  run_after = [\n    program.git,\n    |"), []string{
		"program.git", "script.setup-git", "script.setup-ssh", "local.everyday", "pair",
	})
	equalSlices(t, offered(t, "machine \"m\" {\n  extends = [|"), []string{"profile.base", "local.everyday", "pair"})
	equalSlices(t, offered(t, "requires \"brew\" {\n  programs = [|"), []string{"program.git", "local.everyday", "pair"})
	// A machine's install and run also pick variants and arguments.
	equalSlices(t, offered(t, "machine \"m\" {\n  install = [|"), []string{"program.git", "local.everyday", "pair", "args", "variant"})
	equalSlices(t, offered(t, "machine \"m\" {\n  run = |"), []string{"script.setup-git", "script.setup-ssh", "local.everyday", "pair", "args", "variant"})
	equal(t, newText(t, "machine \"m\" {\n  install = [|", "variant"), `variant(${1}, "${2}")`)
	equalSlices(t, offered(t, "machine \"m\" {\n  via \"brew\" {\n    install = [|"), []string{"program.git", "local.everyday", "pair"})
}

func TestAPartialNameIsReplacedWholeHyphensIncluded(t *testing.T) {
	equalSlices(t, offered(t, "  run_after = [script.setup-g|"), []string{"setup-git/setup-g", "setup-ssh/setup-g"})
	equalSlices(t, offered(t, "  run = args(script.se|, \"x\")"), []string{"setup-git/se", "setup-ssh/se"})
	equalSlices(t, offered(t, "machine \"m\" {\n  install = [program.|]\n}"), []string{"git"})
	equalSlices(t, offered(t, "locals {\n  x = [local.|"), []string{"everyday"})
}

func TestABuiltInTheRepoRedefinesIsOfferedOnceFromTheRepo(t *testing.T) {
	list := complete([]byte("x = installer."), 14, 0, encodingUTF16, analysis, false)
	if len(list.Items) != 3 || list.Items[0].Detail != "installer · installers.loadout.hcl" || list.Items[1].Detail != "built-in installer (or the parent's)" {
		t.Errorf("items: %+v", list.Items)
	}
}

func TestAFlagOffersTrueAndFalse(t *testing.T) {
	equalSlices(t, offered(t, "script \"s\" {\n  needs_sudo = |"), []string{"true", "false"})
	equalSlices(t, offered(t, "installer \"i\" {\n  needs_sudo = t|"), []string{"true/t", "false/t"})
}

func TestAStringOrAListOfStringsOffersNothing(t *testing.T) {
	for _, src := range []string{
		"program \"p\" {\n  description = |", "program \"p\" {\n  tags = [|", "repo {\n  sources = [|",
		"script \"s\" {\n  run = |", "function \"f\" {\n  params = [|",
	} {
		equalSlices(t, offered(t, src), nil)
	}
}

func TestAnyExpressionOffersTheWholeLanguage(t *testing.T) {
	for _, src := range []string{"locals {\n  x = |", "function \"f\" {\n  params = [a]\n  result = |"} {
		got := offered(t, src)
		for _, want := range []string{"brew", "program.", "script.", "local.", "pair", "args", "variant", "concat", "file", "run_script"} {
			if !slices.Contains(got, want) {
				t.Errorf("%q: %q missing from %q", src, want, got)
			}
		}
	}
}

func TestADataSchemaKeyIsDeclaredWithItsKind(t *testing.T) {
	equalSlices(t, offered(t, "data {\n  dark = |"), []string{"flag", "text", "number", "whole", "list"})
	equalSlices(t, offered(t, "data {\n  tools {\n    extra = l|"), []string{"flag/l", "text/l", "number/l", "whole/l", "list/l"})
	equal(t, newText(t, "data {\n  dark = |", "text"), `text("${1}")`)
}

// --- Object keys ---

func TestAMachinesDataOffersTheSchemasKeys(t *testing.T) {
	equalSlices(t, offered(t, "machine \"m\" {\n  data = {\n    |"), []string{"dark", "editor", "tools"})
	equalSlices(t, offered(t, "profile \"p\" {\n  data = { dark = true, |"), []string{"editor", "tools"})
	equalSlices(t, offered(t, "machine \"m\" {\n  data = {\n    dark = false\n    tools = {\n      |"), []string{"extra"})
	equalSlices(t, offered(t, "machine \"m\" {\n  data = {\n    dark = |"), []string{"true", "false"})
	equalSlices(t, offered(t, "machine \"m\" {\n  data = {\n    editor = |"), nil)
	equal(t, newText(t, "machine \"m\" {\n  data = {\n    |", "tools"), "tools = {\n\t$0\n}")
	equal(t, newText(t, "machine \"m\" {\n  data = {\n    |", "editor"), `editor = "${1}"`)
	// Past the data object, the machine's attributes again.
	if got := offered(t, "machine \"m\" {\n  data = {\n    dark = true\n  }\n  |"); !slices.Contains(got, "install") || slices.Contains(got, "data") {
		t.Errorf("offered %q", got)
	}
}

func TestAVariantsParamsAreItsInstallers(t *testing.T) {
	equalSlices(t, offered(t, "program \"p\" {\n  via \"copr\" {\n    params = {\n      |"), []string{"repo", "key"})
	equalSlices(t, offered(t, "program \"p\" {\n  via \"copr\" {\n    params = { repo = \"x/y\", |"), []string{"key"})
	equalSlices(t, offered(t, "program \"p\" {\n  custom {\n    params = {\n      |"), nil)
}

// --- Inside strings ---

func TestALabelThatNamesAnInstallerOffersThem(t *testing.T) {
	equalSlices(t, offered(t, "program \"p\" {\n  via \"b|"), []string{"brew/b", "omarchy/b", "copr/b"})
	equalSlices(t, offered(t, "machine \"m\" {\n  via \"|"), []string{"brew", "omarchy", "copr"})
	equalSlices(t, offered(t, "requires \"|"), []string{"brew", "omarchy", "copr"})
	for _, src := range []string{"program \"|", "script \"s\" {\n  variant \"|", "program \"p\" {\n  via \"brew\" {\n    provides \"|"} {
		equalSlices(t, offered(t, src), nil)
	}
}

func TestVariantsSecondArgumentIsTheVariant(t *testing.T) {
	equalSlices(t, offered(t, "machine \"m\" {\n  install = [variant(program.git, \"|"), []string{"brew", "omarchy"})
	equalSlices(t, offered(t, "machine \"m\" {\n  run = [variant(script.setup-git, \"m|"), []string{"arch/m", "mac/m"})
}

func TestNothingIsOfferedWhereNothingGoes(t *testing.T) {
	for name, src := range map[string]string{
		"a string":                    "script \"x\" {\n  run = \"echo program.|",
		"a closed string's neighbour": "script \"x\" {\n  run = \"a\"\n  check = \"program.|",
		"a comment":                   "program \"x\" {\n  # see program.|",
		"a block comment":             "program \"x\" {\n  /* program.| */",
		"a heredoc":                   "script \"x\" {\n  run = <<-EOT\n    program.|",
		"an unknown kind":             "  install = [machine.|",
	} {
		t.Run(name, func(t *testing.T) {
			if got := offered(t, src); len(got) != 0 {
				t.Errorf("offered %q", got)
			}
		})
	}
}

func TestWhatCloses(t *testing.T) {
	// Closed strings, comments, heredocs and blocks before the cursor don't hide it.
	src := "script \"x\" {\n  # a comment with program. {\n  /* [ { */\n  run = <<-EOT\n    [ program. {\n  EOT\n  check = \"[{\"\n  run_after = [script.|"
	equalSlices(t, offered(t, src), []string{"setup-git", "setup-ssh"})
	src = "program \"a\" {\n  via \"brew\" {\n    params = { x = \"}\" }\n  }\n}\nscript \"b\" {\n  |"
	if got := offered(t, src); !slices.Contains(got, "run_after") {
		t.Errorf("offered %q", got)
	}
}

func TestTheCursorIsReadInTheNegotiatedEncoding(t *testing.T) {
	src := "  # ñ𝄞\n  run_after = [/*ñ𝄞*/script.se|"
	equalSlices(t, offered(t, src), []string{"setup-git/se", "setup-ssh/se"})
	equalSlices(t, offered(t, src, utf8Encoded), []string{"setup-git/se", "setup-ssh/se"})
}

func TestCompletionInAnEditorSession(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"loadout.hcl": repoEntry, "programs/jq.loadout.hcl": `program "jq" { install_via = [brew] }`})
	// Declared only in an unsaved buffer, and completed in another.
	fresh := filepath.Join(dir, "programs/new.loadout.hcl")
	entry := filepath.Join(dir, "loadout.hcl")
	edited := strings.Replace(repoEntry, "install = [program.jq]", "install = [program.jq, program.]", 1)
	completion := func(id int, path string, line, char int) string {
		return jsonOf(t, map[string]any{"jsonrpc": "2.0", "id": id, "method": "textDocument/completion", "params": map[string]any{
			"textDocument": map[string]any{"uri": uriOf(path)},
			"position":     map[string]any{"line": line, "character": char},
		}})
	}
	replies, _, _ := session(t, frame(initializeIn(t, dir),
		didOpen(t, fresh, "program \"yq\" { install_via = [brew] }\nscri"),
		didOpen(t, entry, edited),
		completion(7, entry, 7, 33),
		completion(8, fresh, 1, 4),
		shutdown, exit))
	labels := map[float64][]string{}
	for _, r := range replies {
		if id, ok := r["id"].(float64); ok && id >= 7 {
			for _, it := range r["result"].(map[string]any)["items"].([]any) {
				labels[id] = append(labels[id], it.(map[string]any)["label"].(string))
			}
		}
	}
	slices.Sort(labels[7])
	equalSlices(t, labels[7], []string{"jq", "yq"})
	// A manifest's top level, outside loadout.hcl.
	if !slices.Contains(labels[8], "script") || slices.Contains(labels[8], "repo") {
		t.Errorf("top level: %q", labels[8])
	}
}

func equalSlices[T comparable](t *testing.T, got, want []T) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Errorf("got %#v, want %#v", got, want)
	}
}

func equal[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Errorf("got %#v, want %#v", got, want)
	}
}
