// Package coretest builds the core tests' manifests the way a repo's
// declarations do: an assemble.ManifestDraft
// through assemble.AssembleWithoutFiles, so built-ins, flattening and
// validation are the production path (contract 10). TEST-ONLY.
package coretest

import (
	"testing"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/model"
)

// S is a pointer to s, for the model's optional fields.
func S(s string) *string { return &s }

// Draft is what a test declares; every declaration's origin is the root
// unless it says otherwise.
type Draft struct{ d assemble.ManifestDraft }

// Meta names the repo and its floor ("" = none).
func (b *Draft) Meta(name, minToolVersion string) {
	b.d.Manifest.Meta.Name = name
	if minToolVersion != "" {
		b.d.Manifest.Meta.MinToolVersion = &minToolVersion
	}
}

// Layout sets the layout (state "state" when it says none).
func (b *Draft) Layout(layout model.RepoLayout) { b.d.Manifest.Layout = layout }

// DefaultRegex is a front end's version regex when an installer names none:
// the first dotted number in the output.
const DefaultRegex = `([0-9]+\.[0-9][0-9.]*)`

// Installer declares an installer; its regex defaults to DefaultRegex, as a front end's does.
func (b *Draft) Installer(name string, i model.Installer) {
	if i.Regex == nil {
		i.Regex = S(DefaultRegex)
	}
	b.d.Manifest.Installers.Set(name, i)
}

// Requires adds programs to what installer requires (`brew.requires(setup)`).
func (b *Draft) Requires(installer string, programs ...string) {
	b.d.Requires.Set(installer, append(b.d.Requires.Value(installer), programs...))
}

// Program declares a program.
func (b *Draft) Program(name string, p model.Program) { b.d.Manifest.Programs.Set(name, p) }

// Script declares a script.
func (b *Draft) Script(name string, s model.ScriptStep) { b.d.Manifest.Scripts.Set(name, s) }

// Outdated declares a custom `outdated` source.
func (b *Draft) Outdated(name string, o model.OutdatedSource) { b.d.Manifest.Outdated.Set(name, o) }

// Machine declares a machine.
func (b *Draft) Machine(name string, c model.MachineConfig) {
	c.Label = "machine '" + name + "'"
	b.d.Manifest.Machines.Set(name, c)
}

// ManifestOf is the manifest build declares, assembled without the `file:` checks.
func ManifestOf(t testing.TB, build func(b *Draft)) model.Manifest {
	t.Helper()
	b := &Draft{}
	build(b)
	if b.d.Manifest.Layout.State == "" {
		b.d.Manifest.Layout.State = "state"
	}
	manifest, err := assemble.AssembleWithoutFiles(b.d)
	if err != nil {
		t.Fatal(err)
	}
	return manifest
}

// Via is variants through each installer, as it is (`installVia(brew, dnf)`).
func Via(installers ...string) model.Map[model.InstallVariant] {
	var out model.Map[model.InstallVariant]
	for _, i := range installers {
		out.Set(i, model.InstallVariant{})
	}
	return out
}

// Variants is the variants given, in order.
func Variants(entries ...model.Entry[model.InstallVariant]) model.Map[model.InstallVariant] {
	return model.MapOf(entries...)
}

// Custom is one variant named key running command (`custom(key) { command = … }`).
func Custom(key, command string) model.Map[model.InstallVariant] {
	return Variants(model.E(key, model.InstallVariant{Command: &command}))
}

// PM is a machine's mapping from program, key pairs.
func PM(pairs ...string) model.Map[string] {
	var out model.Map[string]
	for i := 0; i+1 < len(pairs); i += 2 {
		out.Set(pairs[i], pairs[i+1])
	}
	return out
}

// Version is a program's version check (`version(command, regex)`).
func Version(command, regex string) *model.VersionCheck {
	return &model.VersionCheck{Command: command, Regex: &regex}
}

// Example is the shared fixture (EXAMPLE_MANIFEST): three installers of its
// own (replacing the built-ins of their names, so commands stay short), git
// and ripgrep through them, rustup by its own command, a dotfiles script no
// machine runs, and two machines.
func Example(t testing.TB) model.Manifest {
	return ManifestOf(t, func(b *Draft) {
		b.Meta("example machines", "0.1.0")
		b.Layout(model.RepoLayout{State: "state"})
		b.Installer("brew", model.Installer{Probe: S("brew"), Install: S("brew install {pkg}")})
		b.Installer("dnf", model.Installer{Probe: S("dnf"), Install: S("sudo dnf install -y {pkg}")})
		b.Installer("apt", model.Installer{Probe: S("apt-get"), Install: S("sudo apt-get install -y {pkg}")})
		b.Program("git", model.Program{
			Description: "version control",
			Install:     Via("brew", "dnf", "apt"),
			Version:     Version("git --version", "git version ([0-9.]+)"),
		})
		b.Program("ripgrep", model.Program{
			Description: "fast grep",
			Tags:        []string{"cli"},
			DependsOn:   []string{"git"},
			Install:     Via("brew", "dnf"),
			Version:     Version("rg --version", "ripgrep ([0-9][0-9a-zA-Z.-]*)"),
		})
		b.Program("rustup", model.Program{
			Description: "rust toolchain manager",
			Version:     Version("rustup --version", "rustup ([0-9.]+)"),
			Install:     Custom("script", "curl -sSf https://sh.rustup.rs | sh -s -- -y"),
		})
		b.Script("dotfiles", model.ScriptStep{
			Description: "clone and link dotfiles",
			File:        S("scripts/dotfiles.sh"),
			Check:       S("test -d $HOME/.dotfiles"),
			After:       []string{"programs.git"},
		})
		b.Machine("laptop", model.MachineConfig{PM: PM("git", "dnf", "ripgrep", "dnf", "rustup", "script")})
		b.Machine("macbook", model.MachineConfig{PM: PM("git", "brew", "ripgrep", "brew", "rustup", "script")})
	})
}
