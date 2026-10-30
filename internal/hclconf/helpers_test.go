package hclconf

import (
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/model"
)

// Fixtures: an HCL source is one file at the repo root (loadout.hcl); a map
// is several, keyed by path, each declaring for its own folder.

func filesOf(files map[string]string) []File {
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	slices.Sort(paths)
	if i := slices.Index(paths, EntryFile); i > 0 {
		paths = append([]string{EntryFile}, slices.Delete(paths, i, i+1)...)
	}
	out := make([]File, len(paths))
	for i, p := range paths {
		out[i] = File{Path: p, Src: []byte(files[p])}
	}
	return out
}

func root(src string) map[string]string { return map[string]string{EntryFile: src} }

// decode is what files declare, failing the test on HCL diagnostics.
func decode(t *testing.T, files map[string]string) *Decoded {
	t.Helper()
	d, err := Decode(filesOf(files), Options{})
	if err != nil {
		t.Fatalf("doesn't decode: %v", err)
	}
	return d
}

// draftOf is files' draft with state in `state/`.
func draftOf(t *testing.T, files map[string]string) (assemble.ManifestDraft, *Decoded) {
	t.Helper()
	d := decode(t, files)
	draft, err := d.DraftOf()
	if err != nil {
		t.Fatal(err)
	}
	if draft.Manifest.Layout.State == "" {
		draft.Manifest.Layout.State = "state"
	}
	return draft, d
}

func manifestOf(t *testing.T, src string) model.Manifest {
	t.Helper()
	return manifestFiles(t, root(src))
}

func manifestFiles(t *testing.T, files map[string]string) model.Manifest {
	t.Helper()
	m, err := ManifestOf(filesOf(files)...)
	if err != nil {
		t.Fatalf("manifest doesn't assemble: %v", err)
	}
	return m
}

// refusal is why src doesn't make a manifest (files unchecked).
func refusal(t *testing.T, src string) string {
	t.Helper()
	return refusalFiles(t, root(src))
}

func refusalFiles(t *testing.T, files map[string]string) string {
	t.Helper()
	_, err := ManifestOf(filesOf(files)...)
	if err == nil {
		t.Fatal("assembled; wanted a refusal")
	}
	if _, ok := err.(model.Refusal); !ok {
		t.Fatalf("%T is not a refusal: %v", err, err)
	}
	return err.Error()
}

func repoFS(files ...string) fstest.MapFS {
	repo := fstest.MapFS{}
	for _, f := range files {
		repo[f] = &fstest.MapFile{Data: []byte("#!/bin/sh\n")}
	}
	return repo
}

// inRepo is src assembled with `file:` paths checked against a repo holding
// files.
func inRepo(t *testing.T, src string, files ...string) model.Manifest {
	t.Helper()
	draft, _ := draftOf(t, root(src))
	m, err := assemble.Assemble(draft, repoFS(files...), nil)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func refusalInRepo(t *testing.T, src string, files ...string) string {
	t.Helper()
	draft, _ := draftOf(t, root(src))
	_, err := assemble.Assemble(draft, repoFS(files...), nil)
	if err == nil {
		t.Fatal("assembled; wanted a refusal")
	}
	return err.Error()
}

func contains(t *testing.T, message string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(message, want) {
			t.Errorf("%q not in:\n%s", want, message)
		}
	}
}

func equal[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Errorf("got %v, want %v", got, want)
	}
}

func equalSlices[T comparable](t *testing.T, got, want []T) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func pmOf(t *testing.T, m model.Manifest, machine string) map[string]string {
	t.Helper()
	config, ok := m.Machines.Get(machine)
	if !ok {
		t.Fatalf("no machine %q", machine)
	}
	out := map[string]string{}
	for k, v := range config.PM.All() {
		out[k] = v
	}
	return out
}

func equalMaps(t *testing.T, got, want map[string]string) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("got %v, want %v", got, want)
		return
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("got %v, want %v", got, want)
			return
		}
	}
}
