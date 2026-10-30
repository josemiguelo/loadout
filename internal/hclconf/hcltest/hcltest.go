// Package hcltest builds test fixtures from HCL manifests, through the real
// front end. TEST-ONLY (contract 10).
package hcltest

import (
	"slices"
	"testing"

	"github.com/josemiguelo/loadout/internal/hclconf"
	"github.com/josemiguelo/loadout/internal/model"
)

// ManifestOf is the manifest src declares, as one file at the repo root
// (loadout.hcl, so it may hold the repo block): built-ins merged, profiles
// flattened, everything validated, `file:` paths unchecked; state in
// `state/` unless src says otherwise. A refusal fails the test.
func ManifestOf(t testing.TB, src string) model.Manifest {
	t.Helper()
	return ManifestOfFiles(t, map[string]string{hclconf.EntryFile: src})
}

// ManifestOfFiles is ManifestOf over several files, keyed by repo-relative
// path: each declaration's origin is its file's folder. loadout.hcl comes
// first, the rest in path order.
func ManifestOfFiles(t testing.TB, files map[string]string) model.Manifest {
	t.Helper()
	manifest, err := hclconf.ManifestOf(Files(files)...)
	if err != nil {
		t.Fatalf("manifest doesn't assemble: %v", err)
	}
	return manifest
}

// Refusal is why src doesn't make a manifest (ManifestOf's refusal); the
// test fails when it does.
func Refusal(t testing.TB, src string) string {
	t.Helper()
	_, err := hclconf.ManifestOf(Files(map[string]string{hclconf.EntryFile: src})...)
	if err == nil {
		t.Fatal("the manifest assembled; wanted a refusal")
	}
	return err.Error()
}

// Files is files as hclconf.Files: loadout.hcl first, the rest in path order.
func Files(files map[string]string) []hclconf.File {
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	slices.SortFunc(paths, func(a, b string) int {
		switch {
		case a == hclconf.EntryFile:
			return -1
		case b == hclconf.EntryFile:
			return 1
		case a < b:
			return -1
		case a > b:
			return 1
		}
		return 0
	})
	out := make([]hclconf.File, len(paths))
	for i, p := range paths {
		out[i] = hclconf.File{Path: p, Src: []byte(files[p])}
	}
	return out
}
