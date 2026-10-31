package hclconf

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"

	"github.com/josemiguelo/loadout/internal/model"
)

// Analyze: what an editor gets from manifests, mistakes and all.

// declared is a's declarations of kind, each as `name` or `name@file:line,col`.
func declared(a *Analysis, kind string) []string {
	var out []string
	for _, d := range a.Declarations {
		if d.Kind != kind {
			continue
		}
		if d.Range == nil {
			out = append(out, d.Name)
		} else {
			out = append(out, fmt.Sprintf("%s@%s:%d,%d", d.Name, d.Range.Filename, d.Range.Start.Line, d.Range.Start.Column))
		}
	}
	return out
}

// lines is diags as `file:line,col: summary`.
func lines(diags hcl.Diagnostics) []string {
	var out []string
	for _, d := range diags {
		out = append(out, fmt.Sprintf("%s:%d,%d: %s", d.Subject.Filename, d.Subject.Start.Line, d.Subject.Start.Column, d.Summary))
	}
	return out
}

func TestAnalyzeNamesEveryDeclarationWhereItIs(t *testing.T) {
	a := Analyze(filesOf(map[string]string{
		EntryFile: `locals {
  everyday = [program.bat]
}`,
		"cli/cli.loadout.hcl": `program "bat" { install_via = [brew] }
script "setup-bat" { run = "true" }`,
		"machines/m.loadout.hcl": `installer "mine" { install = "true" }
profile "base" { install = [program.bat] }`,
	}), Options{})
	equalSlices(t, lines(a.Diagnostics), nil)
	equalSlices(t, declared(a, "program"), []string{"bat@cli/cli.loadout.hcl:1,9"})
	equalSlices(t, declared(a, "script"), []string{"setup-bat@cli/cli.loadout.hcl:2,8"})
	equalSlices(t, declared(a, "profile"), []string{"base@machines/m.loadout.hcl:2,9"})
	equalSlices(t, declared(a, "local"), []string{"everyday@loadout.hcl:2,3"})
	installers := declared(a, "installer")
	if !slices.Contains(installers, "brew") || installers[len(installers)-1] != "mine@machines/m.loadout.hcl:1,11" {
		t.Errorf("installers: %q", installers)
	}
}

func TestAnalyzeKeepsGoingPastAFileThatDoesntParse(t *testing.T) {
	a := Analyze(filesOf(map[string]string{
		"cli/cli.loadout.hcl": `program "bat" { install_via = [brew] }
program "half" {
  install_via = [
`,
		"machines/m.loadout.hcl": `machine "m" {
  install = [program.bat, program.half, program.ghost]
}`,
	}), Options{})
	// The broken file still names its programs, so only the ghost is unknown.
	equalSlices(t, declared(a, "program"), []string{"bat@cli/cli.loadout.hcl:1,9", "half@cli/cli.loadout.hcl:2,9"})
	got := lines(a.Diagnostics)
	if len(got) != 2 || !strings.HasPrefix(got[0], "cli/cli.loadout.hcl:") || got[1] != "machines/m.loadout.hcl:2,48: Unsupported attribute" {
		t.Errorf("diagnostics: %q", got)
	}
}

func TestAnalyzeReportsEveryMistakeAtOnce(t *testing.T) {
	a := Analyze(filesOf(map[string]string{
		"cli/cli.loadout.hcl": `program "bat" {
  install_via = [brew]
  colour      = "red"
}
program "bat" { install_via = [brew] }`,
		"machines/m.loadout.hcl": `machine "m" { run = [script.ghost] }`,
	}), Options{})
	equalSlices(t, lines(a.Diagnostics), []string{
		"cli/cli.loadout.hcl:3,3: Unsupported argument",
		"machines/m.loadout.hcl:1,28: Unsupported attribute",
	})
	equalSlices(t, a.Errors, []string{"duplicate program 'bat'"})
}

func TestAnalyzeNamesTheParentsDeclarationsWithoutAPlace(t *testing.T) {
	parent, err := Decode(filesOf(map[string]string{"lib/lib.loadout.hcl": `program "git" { install_via = [brew] }
script "helper" { managed_by = "helper.sh" }`}), Options{AsParent: true})
	if err != nil {
		t.Fatal(err)
	}
	a := Analyze(filesOf(map[string]string{"mine/mine.loadout.hcl": `script "mine" {
  run       = "true"
  run_after = [program.git, script.helper]
}`}), Options{Parent: parent})
	equalSlices(t, lines(a.Diagnostics), nil)
	equalSlices(t, declared(a, "program"), []string{"git"})
	equalSlices(t, declared(a, "script"), []string{"helper", "mine@mine/mine.loadout.hcl:1,8"})
}

const checkedRepo = `repo {
  name    = "test"
  state   = "machines/state"
  sources = ["programs/**/*.loadout.hcl"]
}

machine "m" {
  install = [program.jq]
}
`

func checked(t *testing.T, dir string, overlay map[string][]byte) *Analysis {
	t.Helper()
	a, err := Check(dir, overlay)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestCheckReadsTheRepoAndWritesNothing(t *testing.T) {
	dir := t.TempDir()
	writeRepo(t, dir, map[string]string{EntryFile: checkedRepo, "programs/jq.loadout.hcl": `program "jq" { install_via = [brew] }`})
	a := checked(t, dir, nil)
	equalSlices(t, lines(a.Diagnostics), nil)
	equalSlices(t, a.Errors, nil)
	equalSlices(t, declared(a, "program"), []string{"jq@programs/jq.loadout.hcl:1,9"})
	if _, err := os.Stat(filepath.Join(dir, model.LockFileName)); !os.IsNotExist(err) {
		t.Errorf("wrote the lock: %v", err)
	}
}

func TestCheckReadsUnsavedBuffersOverTheDisk(t *testing.T) {
	dir := t.TempDir()
	writeRepo(t, dir, map[string]string{EntryFile: checkedRepo, "programs/jq.loadout.hcl": `program "jq" { install_via = [brew] }`})
	a := checked(t, dir, map[string][]byte{
		// jq's file, emptied: the machine's reference breaks.
		"programs/jq.loadout.hcl": nil,
		// A new file the globs match, never saved, declares it again.
		"programs/new/jq.loadout.hcl": []byte(`program "jq" { install_via = [brew] }`),
		// Outside the globs: never read.
		"elsewhere/x.loadout.hcl": []byte(`not hcl at all {`),
	})
	equalSlices(t, lines(a.Diagnostics), nil)
	equalSlices(t, declared(a, "program"), []string{"jq@programs/new/jq.loadout.hcl:1,9"})
}

func TestCheckFindsWhatOnlyAssemblingCatches(t *testing.T) {
	dir := t.TempDir()
	writeRepo(t, dir, map[string]string{EntryFile: checkedRepo, "programs/jq.loadout.hcl": `program "jq" { install_via = [brew] }
script "setup" { file = "missing.sh" }`})
	a := checked(t, dir, nil)
	equalSlices(t, lines(a.Diagnostics), nil)
	if len(a.Errors) != 1 || !strings.Contains(a.Errors[0], "missing.sh") {
		t.Errorf("errors: %q", a.Errors)
	}
}

func TestCheckReadsABrokenEntryFileAlone(t *testing.T) {
	dir := t.TempDir()
	writeRepo(t, dir, map[string]string{EntryFile: checkedRepo, "programs/jq.loadout.hcl": `program "jq" {`})
	a := checked(t, dir, map[string][]byte{EntryFile: []byte("repo {\n  sources = [\n")})
	got := lines(a.Diagnostics)
	if len(got) == 0 || !strings.HasPrefix(got[0], "loadout.hcl:") || slices.ContainsFunc(got, func(l string) bool { return strings.HasPrefix(l, "programs/") }) {
		t.Errorf("diagnostics: %q", got)
	}
}

func TestCheckSaysWhyTheParentCantBeRead(t *testing.T) {
	dir := t.TempDir()
	writeRepo(t, dir, map[string]string{EntryFile: `repo {
  name    = "child"
  state   = "machines/state"
  sources = []
  parent {
    name = "base"
    path = "../nowhere"
  }
}`})
	a := checked(t, dir, nil)
	if len(a.Errors) != 1 || !strings.Contains(a.Errors[0], "parent base") {
		t.Errorf("errors: %q", a.Errors)
	}
}

func TestCheckRefusesADirectoryThatIsntARepo(t *testing.T) {
	if _, err := Check(t.TempDir(), nil); err == nil {
		t.Error("checked a directory without " + EntryFile)
	}
}

func TestCheckReadsTheGlobsPastASyntaxErrorInTheEntryFile(t *testing.T) {
	dir := t.TempDir()
	writeRepo(t, dir, map[string]string{EntryFile: checkedRepo, "programs/jq.loadout.hcl": `program "jq" { install_via = [brew] }`})
	// Half-typed below the repo block: the other files are still read.
	a := checked(t, dir, map[string][]byte{EntryFile: []byte(strings.Replace(checkedRepo, "[program.jq]", "[program.jq, program.]", 1))})
	equalSlices(t, declared(a, "program"), []string{"jq@programs/jq.loadout.hcl:1,9"})
	got := lines(a.Diagnostics)
	if len(got) == 0 || !strings.HasPrefix(got[0], "loadout.hcl:8,") {
		t.Errorf("diagnostics: %q", got)
	}
	// Compile stays strict.
	if _, err := Compile(dir); err != nil {
		t.Fatal(err) // the disk's entry file is fine
	}
	writeRepo(t, dir, map[string]string{EntryFile: "repo {\n  sources = []\n}\nmachine \"m\" {\n  install = [program.]\n}\n"})
	var diags *DiagnosticsError
	if _, err := Compile(dir); !errors.As(err, &diags) {
		t.Errorf("compiled a broken entry file: %v", err)
	}
}
