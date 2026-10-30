package hclconf

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/version"
)

// `loadout compile` over a repo on disk: what it reads, writes and refuses.

func writeRepo(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for p, text := range files {
		target := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func compile(t *testing.T, dir string) []string {
	t.Helper()
	warnings, err := Compile(dir)
	if err != nil {
		t.Fatalf("doesn't compile: %v", err)
	}
	return warnings
}

const smallRepo = `repo {
  name    = "test"
  state   = "machines/state"
  sources = ["programs/**/*.loadout.hcl"]
}

program "jq" {
  description = "json <tool> & more"
  install_via = [brew]
}

machine "m" {
  install = [program.jq]
}
`

func TestCompileWritesTheLock(t *testing.T) {
	dir := t.TempDir()
	writeRepo(t, dir, map[string]string{EntryFile: smallRepo, "programs/tool.loadout.hcl": `
script "hello" {
  file  = "hello.sh"
  check = "test -f done"
}
machine "n" { run = [script.hello] }
`, "programs/hello.sh": "#!/bin/sh\n"})
	equalSlices(t, compile(t, dir), nil)
	hash, err := model.SourcesHash(os.DirFS(dir), []string{EntryFile, "programs/**/*.loadout.hcl"})
	if err != nil {
		t.Fatal(err)
	}
	want := `{
  "format": 1,
  "toolVersion": "` + version.Version + `",
  "sources": "` + hash + `",
  "manifest": {
    "meta": {
      "name": "test"
    },
    "layout": {
      "state": "machines/state",
      "sources": [
        "loadout.hcl",
        "programs/**/*.loadout.hcl"
      ]
    },
    "programs": {
      "jq": {
        "description": "json <tool> & more",
        "install": {
          "brew": {}
        }
      }
    },
    "scripts": {
      "hello": {
        "file": "hello.sh",
        "check": "test -f done",
        "origin": "programs"
      }
    },
    "machines": {
      "m": {
        "pm": {
          "jq": "brew"
        }
      },
      "n": {
        "scripts": [
          "hello"
        ]
      }
    },
    "builtinInstallers": [
      "apt",
      "brew",
      "brew-cask",
      "dnf",
      "dnf-copr",
      "dnf-repo",
      "flatpak",
      "omarchy",
      "omarchy-aur",
      "pacman"
    ]
  }
}
`
	got := read(t, filepath.Join(dir, model.LockFileName))
	// The built-in installers are written in full; compare around them.
	start := strings.Index(got, `    "installers": {`)
	end := strings.Index(got, `    "programs": {`)
	if start < 0 || end < start {
		t.Fatalf("no installers in the lock:\n%s", got)
	}
	got = got[:start] + got[end:]
	if got != want {
		t.Errorf("lock:\n%s\nwant:\n%s", got, want)
	}
}

func TestCompileWritesOnlyWhatChanged(t *testing.T) {
	dir := t.TempDir()
	writeRepo(t, dir, map[string]string{EntryFile: smallRepo})
	compile(t, dir)
	lock := filepath.Join(dir, model.LockFileName)
	old := time.Unix(1, 0)
	if err := os.Chtimes(lock, old, old); err != nil {
		t.Fatal(err)
	}
	compile(t, dir)
	info, _ := os.Stat(lock)
	if !info.ModTime().Equal(old) {
		t.Error("an unchanged lock is left alone")
	}
	writeRepo(t, dir, map[string]string{EntryFile: smallRepo + "\n# edited\n"})
	compile(t, dir)
	info, _ = os.Stat(lock)
	if info.ModTime().Equal(old) {
		t.Error("a changed source rewrites the lock")
	}
}

func TestCompileWritesTheChezmoiDataWithConfigs(t *testing.T) {
	dir := t.TempDir()
	writeRepo(t, dir, map[string]string{EntryFile: strings.Replace(smallRepo, `name    = "test"`, "name    = \"test\"\n  configs = \"loadouts\"", 1) + `
data {
  work = flag(false)
}
`})
	compile(t, dir)
	data := read(t, filepath.Join(dir, "loadouts/.chezmoidata/loadout.json"))
	contains(t, data, `"work": false`)
	equal(t, read(t, filepath.Join(dir, "loadouts/.chezmoitemplates/loadout/machine")), model.ChezmoiPartial)
}

func TestCompileRefusesAKotlinRepo(t *testing.T) {
	for _, file := range []string{"loadout.kt", "build.gradle.kts"} {
		dir := t.TempDir()
		writeRepo(t, dir, map[string]string{file: "package repo\n"})
		_, err := Compile(dir)
		if err == nil || err.Error() != KotlinRepoMessage {
			t.Errorf("%s: %v", file, err)
		}
		if _, err := os.Stat(filepath.Join(dir, model.LockFileName)); err == nil {
			t.Error("nothing is written for a Kotlin repo")
		}
	}
	_, err := Compile(t.TempDir())
	contains(t, err.Error(), "has no loadout.hcl")
}

func TestCompileReportsEveryDiagnosticRepoRelative(t *testing.T) {
	dir := t.TempDir()
	writeRepo(t, dir, map[string]string{EntryFile: smallRepo, "programs/x.loadout.hcl": `machine "m2" {
  install = [program.ghost]
  run     = [script.ghost]
}`})
	_, err := Compile(dir)
	var de *DiagnosticsError
	if !errors.As(err, &de) {
		t.Fatalf("%T: %v", err, err)
	}
	equalSlices(t, de.Lines, []string{
		`programs/x.loadout.hcl:2,21: Unsupported attribute; This object does not have an attribute named "ghost".`,
		`programs/x.loadout.hcl:3,20: Unsupported attribute; This object does not have an attribute named "ghost".`,
	})
}

func TestCompileWarnsAndReadsStateForTransitionalScripts(t *testing.T) {
	dir := t.TempDir()
	writeRepo(t, dir, map[string]string{EntryFile: `repo {
  name  = "t"
  state = "machines/state"
}
program "orphan" { install_via = [dnf] }
script "cleanup" {
  run          = "rm -f old"
  check        = "test ! -e old"
  transitional = true
}
machine "m1" { run = [script.cleanup] }
machine "m2" { run = [script.cleanup] }
`})
	warnings := compile(t, dir)
	equalSlices(t, warnings, []string{`program 'orphan' isn't installed on any machine — if it's kept on purpose, mark it spare = "…"`})
	writeRepo(t, dir, map[string]string{
		"machines/state/m1.json": `{"scripts": {"cleanup": {"status": "done"}}}`,
		"machines/state/m2.json": `{"scripts": {"cleanup": {"status": "done"}}, "extra": 1}`,
	})
	warnings = compile(t, dir)
	equal(t, len(warnings), 2)
	equal(t, warnings[1], "script 'cleanup' is done on every machine that runs it (m1, m2): it's transitional, so delete it")
}

// parentAndChild is a compiled parent at dir/dots and an uncompiled child at dir/work.
func parentAndChild(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	parent := filepath.Join(dir, "dots")
	writeRepo(t, parent, map[string]string{
		EntryFile: `repo {
  name    = "dots"
  state   = "machines/state"
  configs = "configs"
  sources = ["programs/**/*.loadout.hcl"]
}
data {
  work = flag(false)
}
script "marker" {
  file  = "marker.sh"
  check = "test -f marker.txt"
}
`,
		"marker.sh": "#!/bin/sh\n",
		"programs/git.loadout.hcl": `program "git" {
  custom "manual" { command = "false" }
}
machine "m1" {
  install = [program.git]
  run     = [script.marker]
}
`,
	})
	compile(t, parent)
	child := filepath.Join(dir, "work")
	writeRepo(t, child, map[string]string{
		EntryFile: `repo {
  name  = "work"
  state = "machines/state"
  sources = ["machines/**/*.loadout.hcl"]
  parent {
    name = "dots"
    path = "../dots"
  }
}
`,
		"machines/work.loadout.hcl": `program "forgotten" {
  custom { command = "true" }
}
machine "work" {
  install = [program.git]
  run     = [script.marker]
  data    = { work = true }
}
`,
	})
	return parent, child
}

func TestAChildCompilesAgainstItsParent(t *testing.T) {
	parent, child := parentAndChild(t)
	before := read(t, filepath.Join(parent, model.LockFileName))
	warnings := compile(t, child)
	equalSlices(t, warnings, []string{`program 'forgotten' isn't installed on any machine — if it's kept on purpose, mark it spare = "…"`})
	lock, err := model.DecodeLock(read(t, filepath.Join(child, model.LockFileName)), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	m := lock.Manifest
	equalSlices(t, m.Machines.Keys(), []string{"work"})
	equal(t, m.Scripts.Value("marker").Origin, "parent:")
	equal(t, m.Programs.Value("git").Origin, "parent:programs")
	p := m.Layout.Parent
	equal(t, p.Name, "dots")
	equal(t, p.Path, "../dots")
	equal(t, deref(p.Configs), "configs")
	equalSlices(t, p.Sources, []string{EntryFile, "programs/**/*.loadout.hcl"})
	hash, _ := model.SourcesHash(os.DirFS(parent), p.Sources)
	equal(t, p.Hash, hash)
	// Nothing is written under the parent.
	equal(t, read(t, filepath.Join(parent, model.LockFileName)), before)
}

func TestAChildRefusesAStaleParentOrAParentWithAParent(t *testing.T) {
	parent, child := parentAndChild(t)
	writeRepo(t, parent, map[string]string{"programs/git.loadout.hcl": read(t, filepath.Join(parent, "programs/git.loadout.hcl")) + "\n# edited\n"})
	_, err := Compile(child)
	contains(t, err.Error(), "parent dots: loadout.lock.json is older than its manifests — run: loadout compile there first")

	compile(t, parent)
	grandchild := filepath.Join(filepath.Dir(child), "deeper")
	writeRepo(t, grandchild, map[string]string{EntryFile: `repo {
  state = "s"
  parent {
    name = "work"
    path = "../work"
  }
}`})
	compile(t, child)
	_, err = Compile(grandchild)
	contains(t, err.Error(), "parent work is itself a child: a parent can't have a parent")

	writeRepo(t, child, map[string]string{"machines/work.loadout.hcl": `program "git" {
  custom { command = "true" }
}`})
	_, err = Compile(child)
	contains(t, err.Error(), "program 'git' is declared by parent dots too")

	os.Remove(filepath.Join(parent, model.LockFileName))
	_, err = Compile(child)
	contains(t, err.Error(), "parent dots (../dots) has no loadout.lock.json — run: loadout compile there first")
}

func TestWritesStayUnderTheRepo(t *testing.T) {
	dir := t.TempDir()
	err := writeIfChanged(filepath.Join(dir, "child"), filepath.Join(dir, "parent", "x"), "x")
	if err == nil {
		t.Fatal("a write outside the root is refused")
	}
	err = writeIfChanged(filepath.Join(dir, "child"), filepath.Join(dir, "child", "..", "parent", "x"), "x")
	if err == nil {
		t.Fatal("a write that leaves the root through .. is refused")
	}
}
