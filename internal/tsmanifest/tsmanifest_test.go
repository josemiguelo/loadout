package tsmanifest

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/core/exec/fakeexec"
	"github.com/josemiguelo/loadout/internal/model"
)

func s(v string) *string { return &v }

// draftOf assembles d (no file checks), for the warnings.
func draftOf(t *testing.T, d assemble.ManifestDraft) (assemble.ManifestDraft, model.Manifest) {
	t.Helper()
	if d.Manifest.Layout.State == "" {
		d.Manifest.Layout.State = "state"
	}
	m, err := assemble.AssembleWithoutFiles(d)
	if err != nil {
		t.Fatal(err)
	}
	return d, m
}

func via(installers ...string) model.Map[model.InstallVariant] {
	var out model.Map[model.InstallVariant]
	for _, i := range installers {
		out.Set(i, model.InstallVariant{})
	}
	return out
}

func pm(pairs ...string) model.Map[string] {
	var out model.Map[string]
	for i := 0; i+1 < len(pairs); i += 2 {
		out.Set(pairs[i], pairs[i+1])
	}
	return out
}

func contains(t *testing.T, got []string, want string) {
	t.Helper()
	for _, g := range got {
		if strings.Contains(g, want) {
			return
		}
	}
	t.Errorf("no warning saying %q in %q", want, got)
}

// ─── the draft ──────────────────────────────────────────────────────────

func TestADraftCarriesTheManifestAndWhatOnlyCompileReads(t *testing.T) {
	d, err := decodeDraft(`{
		"manifest": {"layout": {"state": "machines/state"}, "programs": {"git": {"install": {"dnf": {}}, "origin": "programs"}}},
		"profiles": {"base": {"pm": {"git": "dnf"}}},
		"requires": {"dnf": ["git"]},
		"spares": {"program 'git'": "kept"},
		"transitional": ["cleanup"],
		"parent": {"name": "dots", "path": "~/dots"}
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if !d.Manifest.Programs.Has("git") || d.Manifest.Programs.Value("git").Origin != "programs" {
		t.Errorf("programs %v", d.Manifest.Programs.Keys())
	}
	if d.Profiles.Value("base").Label != "profile 'base'" {
		t.Errorf("a profile's label is %q: assembly's messages name it", d.Profiles.Value("base").Label)
	}
	if d.Profiles.Value("base").PM.Value("git") != "dnf" || !slices.Equal(d.Requires.Value("dnf"), []string{"git"}) {
		t.Errorf("profiles %v requires %v", d.Profiles, d.Requires)
	}
	if d.Spares.Value("program 'git'") != "kept" || !slices.Equal(d.Transitional, []string{"cleanup"}) {
		t.Errorf("spares %v transitional %v", d.Spares, d.Transitional)
	}
	if d.Parent == nil || d.Parent.Name != "dots" || d.Parent.Path != "~/dots" {
		t.Errorf("parent %+v", d.Parent)
	}
}

func TestWhatIsntADraftIsRefusedAsSuch(t *testing.T) {
	for _, text := range []string{"not json", `{"manifest": {"programs": 3}}`} {
		if _, err := decodeDraft(text); err == nil {
			t.Errorf("%q read as a draft", text)
		}
	}
}

// ─── compile, before bun runs ──────────────────────────────────────────

func TestARepoStillInHCLOrKotlinIsRefusedByName(t *testing.T) {
	for file, want := range map[string]string{"loadout.hcl": "manifests are HCL", "loadout.kt": "manifests are Kotlin"} {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, file), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		_, err := Compile(root, fakeexec.New())
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", file, err)
		}
	}
	if _, err := Compile(t.TempDir(), fakeexec.New()); err == nil || !strings.Contains(err.Error(), "has no loadout.ts") {
		t.Errorf("an empty folder: %v", err)
	}
}

func TestCompileWritesOnlyUnderTheRootAndOnlyWhatChanged(t *testing.T) {
	root := t.TempDir()
	if err := writeIfChanged(root, filepath.Join(filepath.Dir(root), "outside"), "x"); err == nil {
		t.Error("wrote outside the root")
	}
	target := filepath.Join(root, "sub", "f")
	if err := writeIfChanged(root, target, "one"); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(target)
	before := info.ModTime()
	if err := os.Chtimes(target, before.Add(-3600e9), before.Add(-3600e9)); err != nil {
		t.Fatal(err)
	}
	if err := writeIfChanged(root, target, "one"); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(target); !info.ModTime().Before(before) {
		t.Error("rewrote a file that already held the text")
	}
}

// ─── warnings ──────────────────────────────────────────────────────────

func TestWhatNoMachineUsesIsNamedAndSpareSilencesIt(t *testing.T) {
	d := assemble.ManifestDraft{}
	d.Manifest.Programs.Set("git", model.Program{Install: via("dnf")})
	d.Manifest.Programs.Set("htop", model.Program{Install: via("dnf")})
	d.Manifest.Scripts.Set("hello", model.ScriptStep{Run: s("true")})
	d.Profiles.Set("unused", model.MachineConfig{})
	d.Manifest.Machines.Set("m", model.MachineConfig{PM: pm("git", "dnf"), Label: "machine 'm'"})
	draft, manifest := draftOf(t, d)

	warnings := UnusedWarnings(draft, manifest, model.Map[string]{}, nil)
	contains(t, warnings, "program 'htop' isn't installed on any machine")
	contains(t, warnings, "script 'hello' isn't run on any machine")
	contains(t, warnings, "profile 'unused'")

	var spares model.Map[string]
	spares.Set("program 'htop'", "kept for later")
	spares.Set("program 'git'", "but it's used")
	warnings = UnusedWarnings(draft, manifest, spares, nil)
	for _, w := range warnings {
		if strings.Contains(w, "htop") {
			t.Errorf("a spare program is named: %q", w)
		}
	}
	contains(t, warnings, "program 'git' is marked spare")
}

func TestAChildsWarningsAreAboutItsOwnDeclarations(t *testing.T) {
	d := assemble.ManifestDraft{}
	d.Manifest.Programs.Set("parents", model.Program{Install: via("dnf"), Origin: "parent:programs"})
	d.Manifest.Machines.Set("m", model.MachineConfig{Label: "machine 'm'"})
	draft, manifest := draftOf(t, d)
	if w := UnusedWarnings(draft, manifest, model.Map[string]{}, []string{"program 'parents'"}); len(w) != 0 {
		t.Errorf("warned about the parent's: %q", w)
	}
}

func TestATransitionalScriptEveryRunnerHasDoneIsNamedForDeletion(t *testing.T) {
	d := assemble.ManifestDraft{}
	d.Manifest.Scripts.Set("cleanup", model.ScriptStep{Run: s("true"), Check: s("true")})
	d.Manifest.Machines.Set("a", model.MachineConfig{Scripts: []string{"cleanup"}, Label: "machine 'a'"})
	d.Manifest.Machines.Set("b", model.MachineConfig{Scripts: []string{"cleanup"}, Label: "machine 'b'"})
	_, manifest := draftOf(t, d)

	done := map[string]map[string]bool{"a": {"cleanup": true}, "b": {"cleanup": true}}
	contains(t, TransitionalWarnings(manifest, []string{"cleanup"}, done), "script 'cleanup' is done on every machine that runs it (a, b)")
	delete(done["b"], "cleanup")
	if w := TransitionalWarnings(manifest, []string{"cleanup"}, done); len(w) != 0 {
		t.Errorf("one runner not done, still named: %q", w)
	}
}

func TestAStateFileSaysWhichScriptsAMachineHasDone(t *testing.T) {
	dir := t.TempDir()
	state := `{"scripts": {"cleanup": {"status": "done"}, "other": {"status": "pending"}}}`
	if err := os.WriteFile(filepath.Join(dir, "a.json"), []byte(state), 0o644); err != nil {
		t.Fatal(err)
	}
	done := doneScripts(dir, []string{"a", "missing"})
	if !done["a"]["cleanup"] || done["a"]["other"] || len(done["missing"]) != 0 {
		t.Errorf("done %v", done)
	}
}
