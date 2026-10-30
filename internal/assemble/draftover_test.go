package assemble

import (
	"slices"
	"strings"
	"testing"

	m "github.com/josemiguelo/loadout/internal/model"
)

// A child repo's draft over its parent's declarations (contract 18), as
// `loadout compile` builds it.

// parentDraft is the parent: a program, a profile, a machine of its own and a data schema.
func parentDraft() ManifestDraft {
	return ManifestDraft{
		Manifest: m.Manifest{
			Meta:   m.Meta{Name: "dots", MinToolVersion: s("3.1.0")},
			Layout: m.RepoLayout{State: "state", Configs: s("configs")},
			Data:   data(m.E[any]("work", false)),
			Programs: programs(
				m.E("git", m.Program{Install: custom("true"), Origin: "parent:programs"}),
				// Declared at the repo root, in the parent: the parent's root.
				m.E("htop", m.Program{Install: custom("true"), Origin: "parent:"}),
			),
			Machines: m.MapOf(machine("laptop", m.MachineConfig{Extends: []string{"base"}, PM: pm("htop", "custom")})),
		},
		Profiles: m.MapOf(profile("base", m.MachineConfig{PM: pm("git", "custom")})),
		Requires: m.MapOf(m.E("brew", []string{"git"})),
	}
}

func TestAChildMachineUsesTheParentsDeclarationsButNotItsMachines(t *testing.T) {
	child := ManifestDraft{
		Manifest: m.Manifest{
			Meta:     m.Meta{Name: "work", MinToolVersion: s("3.3.0")},
			Layout:   m.RepoLayout{State: "state"},
			Programs: programs(m.E("worktool", m.Program{Install: custom("true"), Origin: "programs"})),
			Machines: m.MapOf(machine("work-mac", m.MachineConfig{
				Extends: []string{"base"}, PM: pm("worktool", "custom"), Data: data(m.E[any]("work", true)),
			})),
		},
		Requires: m.MapOf(m.E("brew", []string{"worktool", "git"})),
	}
	draft, errors := DraftOver(child, parentDraft(), "dotfiles")
	if len(errors) > 0 {
		t.Fatal(errors)
	}
	manifest, err := AssembleWithoutFiles(draft)
	if err != nil {
		t.Fatal(err)
	}
	if got := manifest.Machines.Keys(); !slices.Equal(got, []string{"work-mac"}) {
		t.Fatalf("machines %v", got)
	}
	if got := manifest.Machines.Value("work-mac").PM.Sorted().Keys(); !slices.Equal(got, []string{"git", "worktool"}) {
		t.Fatalf("pm %v", got)
	}
	ps := manifest.Programs
	if ps.Value("git").Origin != "parent:programs" || ps.Value("htop").Origin != "parent:" || ps.Value("worktool").Origin != "programs" {
		t.Fatal("origins")
	}
	if v := manifest.Machines.Value("work-mac").Data.Value("work"); v != true {
		t.Fatalf("work = %v", v)
	}
	// The floor is the higher of the two; meta and layout are the child's.
	if *manifest.Meta.MinToolVersion != "3.3.0" || manifest.Meta.Name != "work" || manifest.Layout.Configs != nil {
		t.Fatalf("meta %+v layout %+v", manifest.Meta, manifest.Layout)
	}
	if got := draft.Requires.Value("brew"); !slices.Equal(got, []string{"git", "worktool"}) {
		t.Fatalf("requires %v", got)
	}
	// The parent's floor wins when it's higher.
	child.Manifest.Meta.MinToolVersion = nil
	over, _ := DraftOver(child, parentDraft(), "dotfiles")
	if *over.Manifest.Meta.MinToolVersion != "3.1.0" {
		t.Fatalf("floor %s", *over.Manifest.Meta.MinToolVersion)
	}
}

func TestANameBothReposDeclareIsRefusedNamingTheParent(t *testing.T) {
	child := ManifestDraft{Manifest: m.Manifest{
		Layout:   m.RepoLayout{State: "state"},
		Programs: programs(m.E("git", m.Program{Install: custom("true")})),
		Machines: m.MapOf(machine("laptop", m.MachineConfig{})),
	}}
	_, errors := DraftOver(child, parentDraft(), "dotfiles")
	message := strings.Join(errors, "\n")
	contains(t, message,
		"program 'git' is declared by parent dotfiles too",
		"machine 'laptop' is declared by parent dotfiles too — a machine belongs to one repo",
	)
}

func TestAChildCantDeclareADataSchema(t *testing.T) {
	child := ManifestDraft{Manifest: m.Manifest{Layout: m.RepoLayout{State: "state"}, Data: data(m.E[any]("secret", false))}}
	_, errors := DraftOver(child, parentDraft(), "dotfiles")
	contains(t, strings.Join(errors, "\n"), "a child repo's data schema is its parent's — drop its data {} block")
}

func TestDeclaredNamesAreWhatWarningsCall(t *testing.T) {
	got := DeclaredNames(parentDraft())
	if want := []string{"program 'git'", "program 'htop'", "profile 'base'"}; !slices.Equal(got, want) {
		t.Fatalf("names %v", got)
	}
}
