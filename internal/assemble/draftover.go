package assemble

import (
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/version"
)

// DraftOver is a child repo's draft (contract 18): child's declarations over
// parent's. The parent's installers, programs,
// scripts, outdated sources, profiles and data schema join the child's; its
// machines don't, and nor do its meta and layout. A name both repos declare
// is an error naming the parent, as is a child data schema. The repo floor
// is the higher of the two.
//
// The errors come back for the caller to report as one refusal, after its
// own front-end errors and the parent's (each prefixed "parent <name>: "),
// repeats dropped; the draft is meaningful only when there are none.
func DraftOver(child, parent ManifestDraft, parentName string) (ManifestDraft, []string) {
	label := "parent " + parentName
	var errors []string
	if !child.Manifest.Data.IsEmpty() {
		errors = append(errors, "a child repo's data schema is its parent's — drop its data {} block")
	}
	clash := func(kind string, mine, theirs []string) {
		have := map[string]bool{}
		for _, n := range theirs {
			have[n] = true
		}
		for _, n := range mine {
			if have[n] {
				errors = append(errors, kind+" '"+n+"' is declared by "+label+" too")
			}
		}
	}
	c, p := child.Manifest, parent.Manifest
	clash("installer", c.Installers.Keys(), p.Installers.Keys())
	clash("program", c.Programs.Keys(), p.Programs.Keys())
	clash("script", c.Scripts.Keys(), p.Scripts.Keys())
	clash("outdated source", c.Outdated.Keys(), p.Outdated.Keys())
	clash("profile", child.Profiles.Keys(), parent.Profiles.Keys())
	for _, name := range c.Machines.Keys() {
		if p.Machines.Has(name) {
			errors = append(errors, "machine '"+name+"' is declared by "+label+" too — a machine belongs to one repo")
		}
	}

	floor := c.Meta.MinToolVersion
	if theirs := p.Meta.MinToolVersion; theirs != nil && (floor == nil || !version.AtLeast(*floor, *theirs)) {
		floor = theirs
	}
	out := child
	out.Manifest.Meta.MinToolVersion = floor
	out.Manifest.Installers = p.Installers.Plus(c.Installers)
	out.Manifest.Programs = p.Programs.Plus(c.Programs)
	out.Manifest.Scripts = p.Scripts.Plus(c.Scripts)
	out.Manifest.Outdated = p.Outdated.Plus(c.Outdated)
	out.Manifest.Data = p.Data
	out.Profiles = parent.Profiles.Plus(child.Profiles)
	var requires model.Map[[]string]
	for _, name := range parent.Requires.Plus(child.Requires).Keys() {
		requires.Set(name, model.Distinct(append(append([]string{}, parent.Requires.Value(name)...), child.Requires.Value(name)...)))
	}
	out.Requires = requires
	return out, errors
}

// DeclaredNames is what draft declares, as warnings name it ("program 'x'"):
// a child's compile doesn't warn about its parent's.
func DeclaredNames(draft ManifestDraft) []string {
	var names []string
	add := func(kind string, keys []string) {
		for _, k := range keys {
			names = append(names, kind+" '"+k+"'")
		}
	}
	add("installer", draft.Manifest.Installers.Keys())
	add("program", draft.Manifest.Programs.Keys())
	add("script", draft.Manifest.Scripts.Keys())
	add("profile", draft.Profiles.Keys())
	return names
}
