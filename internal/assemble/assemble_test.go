package assemble

import (
	"os"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	m "github.com/josemiguelo/loadout/internal/model"
)

// What Assemble makes of a repo's declarations: validation, profile
// flattening (contract 2), data, `file:` paths, the built-ins. Drafts are
// built by hand, as the front end would fill them (and as a lock could hold
// mistakes no front end writes).

var s = m.Ptr[string]

func fsWith(files ...string) fstest.MapFS {
	repo := fstest.MapFS{}
	for _, f := range files {
		repo[f] = &fstest.MapFile{Data: []byte("#!/bin/sh\n")}
	}
	return repo
}

func withState(d ManifestDraft) ManifestDraft {
	if d.Manifest.Layout.State == "" {
		d.Manifest.Layout.State = "state"
	}
	return d
}

func inRepo(t *testing.T, d ManifestDraft, files ...string) m.Manifest {
	t.Helper()
	manifest, err := Assemble(withState(d), fsWith(files...), nil)
	if err != nil {
		t.Fatal(err)
	}
	return manifest
}

func refusal(t *testing.T, d ManifestDraft, files ...string) string {
	t.Helper()
	_, err := Assemble(withState(d), fsWith(files...), nil)
	if err == nil {
		t.Fatal("assembled; wanted a refusal")
	}
	if _, ok := err.(*m.ManifestException); !ok {
		t.Fatalf("%T is not a ManifestException", err)
	}
	return err.Error()
}

// draftRefusal is a draft no front end could write (unknown names, missing
// regexes), as a lock could hold one.
func draftRefusal(t *testing.T, manifest m.Manifest, profiles ...m.Entry[m.MachineConfig]) string {
	t.Helper()
	manifest.Layout = m.RepoLayout{State: "state"}
	_, err := AssembleWithoutFiles(ManifestDraft{Manifest: manifest, Profiles: m.MapOf(profiles...)})
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

func programs(entries ...m.Entry[m.Program]) m.Map[m.Program] { return m.MapOf(entries...) }

func install(entries ...m.Entry[m.InstallVariant]) m.Map[m.InstallVariant] {
	return m.MapOf(entries...)
}

func custom(command string) m.Map[m.InstallVariant] {
	return install(m.E("custom", m.InstallVariant{Command: s(command)}))
}

func via(names ...string) m.Map[m.InstallVariant] {
	var out m.Map[m.InstallVariant]
	for _, n := range names {
		out.Set(n, m.InstallVariant{})
	}
	return out
}

func machine(name string, c m.MachineConfig) m.Entry[m.MachineConfig] {
	c.Label = "machine '" + name + "'"
	return m.E(name, c)
}

func profile(name string, c m.MachineConfig) m.Entry[m.MachineConfig] {
	c.Label = "profile '" + name + "'"
	return m.E(name, c)
}

func pm(pairs ...string) m.Map[string] {
	var out m.Map[string]
	for i := 0; i < len(pairs); i += 2 {
		out.Set(pairs[i], pairs[i+1])
	}
	return out
}

func data(entries ...m.Entry[any]) m.JSONObject { return m.MapOf(entries...) }

// ─── programs and installers ───────────────────────────────────────────

func TestUnknownNamesInADraftAreNamed(t *testing.T) {
	program := m.Program{Install: custom("true")}
	withDep := program
	withDep.DependsOn = []string{"nope"}
	contains(t, draftRefusal(t, m.Manifest{Programs: programs(m.E("a", withDep))}), "programs.a depends-on unknown program 'nope'")
	contains(t, draftRefusal(t, m.Manifest{Programs: programs(m.E("kitty", m.Program{
		Install: install(m.E("copr", m.InstallVariant{Command: s("x"), DependsOn: []string{"dnf-plugins-core"}})),
	}))}), "programs.kitty.install.copr depends-on unknown program 'dnf-plugins-core'")
	contains(t, draftRefusal(t, m.Manifest{Programs: programs(m.E("a", m.Program{
		Install: install(m.E("x", m.InstallVariant{Installer: s("phantom")})),
	}))}), "references unknown installer 'phantom'")
	contains(t, draftRefusal(t, m.Manifest{Machines: m.MapOf(m.E("m", m.MachineConfig{PM: pm("ghost", "dnf")}))}),
		"machine 'm' installs unknown program 'ghost'")
	contains(t, draftRefusal(t, m.Manifest{Machines: m.MapOf(m.E("m", m.MachineConfig{Scripts: []string{"ghost"}}))}),
		"machine 'm' runs unknown script 'ghost'")
	contains(t, draftRefusal(t, m.Manifest{Scripts: m.MapOf(m.E("s", m.ScriptStep{Run: s("true"), After: []string{"programs.ghost"}}))}),
		"scripts.s after references unknown step 'programs.ghost'")
	contains(t, draftRefusal(t, m.Manifest{Installers: m.MapOf(m.E("dnf", m.Installer{Install: s("x {pkg}"), Requires: []string{"ghost"}}))}),
		"installers.dnf requires unknown program 'ghost'")
}

func TestACycleOnlyOneVariantWalksIsStillACycle(t *testing.T) {
	a := m.Program{DependsOn: []string{"b"}, Install: custom("a")}
	b := m.Program{Install: install(
		m.E("custom", m.InstallVariant{Command: s("b")}),
		m.E("other", m.InstallVariant{Command: s("b2"), DependsOn: []string{"a"}}),
	)}
	contains(t, draftRefusal(t, m.Manifest{Programs: programs(m.E("a", a), m.E("b", b))}), "dependency cycle among programs: a -> b -> a")
}

func TestAnInstallersRequirementsCountTowardCyclesButNotItsOwn(t *testing.T) {
	brew := m.Installer{Install: s("brew install {pkg}"), Requires: []string{"setup-brew"}}
	// setup-brew through brew is exempt from brew's own rule...
	_, err := AssembleWithoutFiles(ManifestDraft{Manifest: m.Manifest{
		Layout:     m.RepoLayout{State: "state"},
		Installers: m.MapOf(m.E("brew", brew)),
		Programs:   programs(m.E("setup-brew", m.Program{Install: via("brew")})),
	}})
	if err != nil {
		t.Fatal(err)
	}
	// ...but needing a brew program closes a loop.
	setup := m.Program{DependsOn: []string{"curl"}, Install: custom("x")}
	curl := m.Program{Install: via("brew")}
	contains(t, draftRefusal(t, m.Manifest{Installers: m.MapOf(m.E("brew", brew)), Programs: programs(m.E("setup-brew", setup), m.E("curl", curl))}),
		"dependency cycle among programs")
}

func TestAMachineInstallingThroughAVariantTheProgramLacksIsNamed(t *testing.T) {
	message := refusal(t, ManifestDraft{Manifest: m.Manifest{
		Programs: programs(m.E("git", m.Program{Install: via("dnf")})),
		Machines: m.MapOf(machine("m", m.MachineConfig{PM: pm("git", "brew")})),
	}})
	contains(t, message, "machine 'm' installs 'git' via 'brew', but it can't be installed that way (it can via: dnf)")
}

func TestInstallerDefaultsApplyPkgAndOverrides(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{Manifest: m.Manifest{
		Installers: m.MapOf(m.E("brew-cask", m.Installer{
			Probe: s("brew"), Install: s("brew install --cask {pkg}"), Check: s("brew list --cask --versions {pkg}"), Regex: s("(.*)"),
		})),
		Programs: programs(
			m.E("toolbox", m.Program{Install: install(
				m.E("linux", m.InstallVariant{Command: s("brew tap x/y && brew install --cask toolbox-linux")}),
				m.E("brew-cask", m.InstallVariant{}),
			)}),
			m.E("toolbox-linux-cask", m.Program{Install: install(m.E("brew-cask", m.InstallVariant{Pkg: s("toolbox-linux")}))}),
		),
	}})
	cask := manifest.ResolveInstall("toolbox", "brew-cask")
	if *cask.Command != "brew install --cask toolbox" || cask.Check.Command != "brew list --cask --versions toolbox" || *cask.Probe != "brew" {
		t.Fatalf("cask = %+v", cask)
	}
	if renamed := manifest.ResolveInstall("toolbox-linux-cask", "brew-cask"); *renamed.Command != "brew install --cask toolbox-linux" {
		t.Fatalf("renamed = %s", *renamed.Command)
	}
	// A custom variant has no installer: no probe, no derived check.
	if manifest.ResolveInstall("toolbox", "linux").Probe != nil {
		t.Fatal("custom variant has a probe")
	}
}

func TestAVariantCheckWithoutRegexKeepsItsInstallersRegex(t *testing.T) {
	dnf := m.Installer{Install: s("sudo dnf install -y {pkg}"), Check: s("rpm -q {pkg}"), Regex: s("([0-9.]+)"), Probe: s("dnf")}
	manifest, err := AssembleWithoutFiles(ManifestDraft{Manifest: m.Manifest{
		Layout:     m.RepoLayout{State: "state"},
		Installers: m.MapOf(m.E("dnf", dnf)),
		Programs:   programs(m.E("zlib-devel", m.Program{Install: install(m.E("dnf", m.InstallVariant{Check: s("rpm -q --whatprovides zlib-devel")}))})),
	}})
	if err != nil {
		t.Fatal(err)
	}
	r := manifest.ResolveInstall("zlib-devel", "dnf")
	if *r.Command != "sudo dnf install -y zlib-devel" || r.Check.Command != "rpm -q --whatprovides zlib-devel" ||
		*r.Check.Regex != "([0-9.]+)" || *r.Probe != "dnf" {
		t.Fatalf("resolved = %+v", r)
	}
}

func TestChecksNeedARegexUnlessTheyAreYesNo(t *testing.T) {
	contains(t, draftRefusal(t, m.Manifest{Installers: m.MapOf(m.E("bad", m.Installer{Install: s("x {pkg}"), Check: s("q {pkg}")}))}),
		"installers.bad has a check but no regex")
	contains(t, draftRefusal(t, m.Manifest{Programs: programs(m.E("a", m.Program{Install: install(m.E("manual", m.InstallVariant{Command: s("x"), Check: s("q")}))}))}),
		"programs.a.install.manual has a check but no regex")
	contains(t, draftRefusal(t, m.Manifest{Programs: programs(m.E("a", m.Program{Install: install(m.E("manual", m.InstallVariant{
		Command: s("x"), Check: s("q"), Present: true, Regex: s("(.*)"),
	}))}))}), "programs.a.install.manual is a yes/no check and also sets a regex")
	// The yes/no form: no regex, no version.
	manifest := inRepo(t, ManifestDraft{Manifest: m.Manifest{Programs: programs(m.E("a", m.Program{Install: install(m.E("custom", m.InstallVariant{
		Command: s("x"), Check: s("test -f /etc/a"), Present: true,
	}))}))}})
	if c := manifest.ResolveInstall("a", "custom").Check; c == nil || c.Regex != nil {
		t.Fatalf("check = %+v", c)
	}
}

func TestAVariantWithNoCommandIsRefused(t *testing.T) {
	contains(t, refusal(t, ManifestDraft{Manifest: m.Manifest{Programs: programs(m.E("a", m.Program{Install: via("custom")}))}}),
		"programs.a.install.custom resolves to no install command")
}

func coprInstaller() m.Installer {
	return m.Installer{Params: []string{"copr"}, Install: s("dnf copr enable {copr} && dnf install {pkg}")}
}

func TestInstallerParamsSubstituteIntoEveryPattern(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{Manifest: m.Manifest{
		Installers: m.MapOf(m.E("copr", m.Installer{
			Params: []string{"copr"}, Install: s("sudo dnf copr enable -y {copr} && sudo dnf install -y {pkg}"),
			Check: s("rpm -q {pkg} && echo {copr}"), Regex: s("(.*)"),
		})),
		Programs: programs(m.E("kitty", m.Program{Install: install(m.E("copr", m.InstallVariant{With: pm("copr", "solopasha/kitty")}))})),
	}})
	r := manifest.ResolveInstall("kitty", "copr")
	if *r.Command != "sudo dnf copr enable -y solopasha/kitty && sudo dnf install -y kitty" || r.Check.Command != "rpm -q kitty && echo solopasha/kitty" {
		t.Fatalf("resolved = %s / %s", *r.Command, r.Check.Command)
	}
}

func TestAMissingOrUndeclaredParamIsAnError(t *testing.T) {
	withCopr := func(v m.InstallVariant) ManifestDraft {
		return ManifestDraft{Manifest: m.Manifest{
			Installers: m.MapOf(m.E("copr", coprInstaller())),
			Programs:   programs(m.E("kitty", m.Program{Install: install(m.E("copr", v))})),
		}}
	}
	contains(t, refusal(t, withCopr(m.InstallVariant{})), "needs a value for 'copr'")
	contains(t, refusal(t, withCopr(m.InstallVariant{With: pm("copr", "x", "extra", "y")})),
		"sets 'extra', which installer 'copr' does not declare in params")
	contains(t, refusal(t, ManifestDraft{Manifest: m.Manifest{Programs: programs(m.E("kitty", m.Program{Install: install(m.E("custom", m.InstallVariant{
		Command: s("x"), With: pm("copr", "y"),
	}))}))}}), "sets 'copr' but resolves to no installer")
	contains(t, refusal(t, ManifestDraft{Manifest: m.Manifest{Installers: m.MapOf(m.E("bad", m.Installer{Params: []string{"pkg"}, Install: s("x {pkg}")}))}}),
		"installers.bad declares param 'pkg', which is always available")
}

func TestInstallOrderPutsDependenciesFirst(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{Manifest: m.Manifest{Programs: programs(
		m.E("git", m.Program{Install: via("dnf")}),
		m.E("ripgrep", m.Program{DependsOn: []string{"git"}, Install: via("dnf")}),
		m.E("rustup", m.Program{Install: custom("x")}),
	)}})
	if got := InstallOrder(manifest, []string{"ripgrep"}, m.Map[string]{}); !slices.Equal(got, []string{"git", "ripgrep"}) {
		t.Fatalf("got %v", got)
	}
	if got := InstallOrder(manifest, nil, m.Map[string]{}); !slices.Equal(got, []string{"git", "ripgrep", "rustup"}) {
		t.Fatalf("got %v", got)
	}
}

func TestInstallOrderFollowsTheMappedVariantAndItsInstaller(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{
		Manifest: m.Manifest{Programs: programs(
			m.E("setup-brew", m.Program{Install: custom("x")}),
			m.E("dnf-plugins-core", m.Program{Install: via("dnf")}),
			m.E("kitty", m.Program{Install: install(
				m.E("brew", m.InstallVariant{}),
				m.E("copr", m.InstallVariant{Command: s("x"), DependsOn: []string{"dnf-plugins-core"}}),
			)}),
		)},
		Requires: m.MapOf(m.E("brew", []string{"setup-brew"})),
	})
	if got := InstallOrder(manifest, []string{"kitty"}, pm("kitty", "brew")); !slices.Equal(got, []string{"setup-brew", "kitty"}) {
		t.Fatalf("brew: %v", got)
	}
	if got := InstallOrder(manifest, []string{"kitty"}, pm("kitty", "copr")); !slices.Equal(got, []string{"dnf-plugins-core", "kitty"}) {
		t.Fatalf("copr: %v", got)
	}
}

// ─── scripts ───────────────────────────────────────────────────────────

func TestScriptModesDefaultToBothSurfaces(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{Manifest: m.Manifest{Scripts: m.MapOf(
		m.E("bootstrap", m.ScriptStep{Run: s("true"), Modes: []string{"setup"}}),
		m.E("tidy", m.ScriptStep{Run: s("true"), Modes: []string{"maintain"}}),
		m.E("everyday", m.ScriptStep{Run: s("true")}),
	)}})
	sc := manifest.Scripts
	if !sc.Value("bootstrap").RunsIn("setup") || sc.Value("bootstrap").RunsIn("maintain") || sc.Value("tidy").RunsIn("setup") ||
		!sc.Value("everyday").RunsIn("setup") || !sc.Value("everyday").RunsIn("maintain") {
		t.Fatal("modes")
	}
	contains(t, draftRefusal(t, m.Manifest{Scripts: m.MapOf(m.E("s", m.ScriptStep{Run: s("x"), Modes: []string{"bogus"}}))}), "unknown mode 'bogus'")
	contains(t, draftRefusal(t, m.Manifest{Scripts: m.MapOf(m.E("s", m.ScriptStep{Run: s("x"), Modes: []string{}}))}), "empty modes list")
}

func TestAScriptHasExactlyOneOfAFileOrACommand(t *testing.T) {
	scripts := func(step m.ScriptStep) ManifestDraft {
		return ManifestDraft{Manifest: m.Manifest{Scripts: m.MapOf(m.E("s", step))}}
	}
	contains(t, refusal(t, scripts(m.ScriptStep{File: s("s.sh"), Run: s("true")}), "s.sh"), "scripts.s must define exactly one of a file or an inline command")
	contains(t, refusal(t, scripts(m.ScriptStep{})), "scripts.s must define exactly one of a file or an inline command")
	contains(t, refusal(t, scripts(m.ScriptStep{Run: s("true"), Variants: m.MapOf(m.E("a", m.ScriptStep{File: s("a.sh")}))}), "a.sh"),
		"scripts.s has variants, so its file or command belongs in each variant")
}

func TestArgumentsNeedAFileScript(t *testing.T) {
	contains(t, refusal(t, ManifestDraft{Manifest: m.Manifest{
		Scripts:  m.MapOf(m.E("inline", m.ScriptStep{Run: s("echo hi")})),
		Machines: m.MapOf(machine("m", m.MachineConfig{Scripts: []string{"inline x"}})),
	}}), "machine 'm' passes arguments to script 'inline', which is an inline command")
}

func TestAMachinePicksAVariantTheScriptHas(t *testing.T) {
	contains(t, draftRefusal(t, m.Manifest{
		Scripts:  m.MapOf(m.E("k", m.ScriptStep{Run: s("x")})),
		Machines: m.MapOf(m.E("m", m.MachineConfig{Scripts: []string{"k"}, ScriptVariants: pm("k", "zzz")})),
	}), "machine 'm' runs 'k' as 'zzz', which it doesn't have (has: none)")
	contains(t, draftRefusal(t, m.Manifest{
		Scripts: m.MapOf(m.E("k", m.ScriptStep{Variants: m.MapOf(
			m.E("one", m.ScriptStep{Run: s("1")}), m.E("arch", m.ScriptStep{Run: s("2")}),
		)})),
		Machines: m.MapOf(m.E("m", m.MachineConfig{Scripts: []string{"k"}})),
	}), "machine 'm' runs 'k' without saying which variant (has: arch, one)")
}

func TestRunningAScriptTwiceIsAnError(t *testing.T) {
	contains(t, draftRefusal(t, m.Manifest{
		Scripts:  m.MapOf(m.E("s", m.ScriptStep{File: s("s.sh")})),
		Machines: m.MapOf(m.E("m", m.MachineConfig{Scripts: []string{"s a", "s b"}})),
	}), "machine 'm' runs script 's' more than once")
}

func TestScriptOrderPutsAfterFirst(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{Manifest: m.Manifest{
		Programs: programs(m.E("git", m.Program{Install: via("dnf")})),
		Scripts: m.MapOf(
			m.E("a", m.ScriptStep{Run: s("x"), After: []string{"scripts.c", "programs.git"}}),
			m.E("b", m.ScriptStep{Run: s("x")}),
			m.E("c", m.ScriptStep{Run: s("x")}),
		),
	}})
	if got := ScriptOrder(manifest, nil); !slices.Equal(got, []string{"c", "a", "b"}) {
		t.Fatalf("got %v", got)
	}
	contains(t, draftRefusal(t, m.Manifest{Scripts: m.MapOf(
		m.E("a", m.ScriptStep{Run: s("x"), After: []string{"scripts.b"}}),
		m.E("b", m.ScriptStep{Variants: m.MapOf(m.E("v", m.ScriptStep{Run: s("x"), After: []string{"scripts.a"}}))}),
	)}), "ordering cycle among scripts: a -> b -> a")
}

// ─── machines and profiles (contract 2) ────────────────────────────────

func TestProfilesFlattenIntoMachinesAndAreDropped(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{
		Manifest: m.Manifest{
			Programs: programs(m.E("git", m.Program{Install: via("dnf", "brew")}), m.E("kitty", m.Program{Install: via("dnf")})),
			Scripts:  m.MapOf(m.E("dotfiles", m.ScriptStep{File: s("dotfiles.sh")}), m.E("setup-ssh", m.ScriptStep{File: s("ssh.sh")})),
			Machines: m.MapOf(machine("laptop", m.MachineConfig{Extends: []string{"linux"}, PM: pm("git", "brew"), Scripts: []string{"setup-ssh laptopkey"}})),
		},
		Profiles: m.MapOf(
			profile("base", m.MachineConfig{PM: pm("git", "dnf", "kitty", "dnf"), Scripts: []string{"dotfiles", "setup-ssh basekey"}}),
			profile("linux", m.MachineConfig{Extends: []string{"base"}}),
		),
	}, "dotfiles.sh", "ssh.sh")
	if got := manifest.Machines.Keys(); !slices.Equal(got, []string{"laptop"}) {
		t.Fatalf("machines %v", got)
	}
	laptop := manifest.Machines.Value("laptop")
	// Mappings merge per program, the machine wins; chains flatten through.
	if got := m.JSONString(m.MapValues(laptop.PM, func(_ string, v string) any { return v })); got != `{"git":"brew","kitty":"dnf"}` {
		t.Fatalf("pm %s", got)
	}
	// Scripts union; a machine's entry replaces the profile's by name (args too).
	args := laptop.ScriptArgs()
	if args.Len() != 2 || args.Value("dotfiles") != "" || args.Value("setup-ssh") != "laptopkey" {
		t.Fatalf("args %v %v", args.Keys(), laptop.Scripts)
	}
	if !slices.Equal(laptop.Extends, []string{"linux"}) || laptop.Label != "" {
		t.Fatalf("extends %v label %q", laptop.Extends, laptop.Label)
	}
}

func TestSiblingProfilesMustAgreeAndTheMachineOverridesThem(t *testing.T) {
	agree := inRepo(t, ManifestDraft{
		Manifest: m.Manifest{
			Programs: programs(m.E("git", m.Program{Install: via("dnf", "brew")})),
			Scripts:  m.MapOf(m.E("ssh", m.ScriptStep{File: s("ssh.sh")})),
			Machines: m.MapOf(machine("m", m.MachineConfig{Extends: []string{"a", "b"}, PM: pm("git", "brew")})),
		},
		Profiles: m.MapOf(
			profile("a", m.MachineConfig{PM: pm("git", "dnf"), Scripts: []string{"ssh one"}}),
			profile("b", m.MachineConfig{PM: pm("git", "dnf"), Scripts: []string{"ssh one"}}),
		),
	}, "ssh.sh")
	if mc := agree.Machines.Value("m"); mc.PM.Value("git") != "brew" || mc.ScriptArgs().Value("ssh") != "one" || len(mc.Scripts) != 1 {
		t.Fatalf("agree %+v", mc)
	}

	disagree := refusal(t, ManifestDraft{
		Manifest: m.Manifest{
			Data:     data(m.E[any]("omarchy", false)),
			Programs: programs(m.E("git", m.Program{Install: via("dnf", "brew")})),
			Scripts: m.MapOf(
				m.E("ssh", m.ScriptStep{File: s("ssh.sh")}),
				m.E("keyboard", m.ScriptStep{Variants: m.MapOf(m.E("one", m.ScriptStep{File: s("k1.sh")}), m.E("two", m.ScriptStep{File: s("k2.sh")}))}),
			),
			Machines: m.MapOf(machine("m", m.MachineConfig{Extends: []string{"a", "b"}})),
		},
		Profiles: m.MapOf(
			profile("a", m.MachineConfig{PM: pm("git", "dnf"), Scripts: []string{"ssh one", "keyboard"}, ScriptVariants: pm("keyboard", "one"), Data: data(m.E[any]("omarchy", true))}),
			profile("b", m.MachineConfig{PM: pm("git", "brew"), Scripts: []string{"ssh two", "keyboard"}, ScriptVariants: pm("keyboard", "two"), Data: data(m.E[any]("omarchy", false))}),
		),
	}, "ssh.sh", "k1.sh", "k2.sh")
	contains(t, disagree,
		"machine 'm': profiles 'a' and 'b' map 'git' differently ('dnf' vs 'brew')",
		"machine 'm': profiles 'a' and 'b' run 'ssh' with different arguments",
		"machine 'm': profiles 'a' and 'b' run 'keyboard' as different variants ('one' vs 'two')",
		"machine 'm': profiles 'a' and 'b' set data key 'omarchy' differently",
	)
}

func TestProfileCyclesAndUnknownProfilesAreNamed(t *testing.T) {
	contains(t, draftRefusal(t, m.Manifest{},
		profile("p", m.MachineConfig{Extends: []string{"q"}}),
		profile("q", m.MachineConfig{Extends: []string{"p"}}),
	), "profile cycle: p -> q -> p")
	contains(t, draftRefusal(t, m.Manifest{Machines: m.MapOf(machine("m", m.MachineConfig{Extends: []string{"laptop"}}))}),
		"machine 'm': extends unknown profile 'laptop'")
}

func flags() m.JSONObject {
	return data(
		m.E[any]("omarchy", false),
		m.E[any]("tags", []any{"a"}),
		m.E[any]("kitty", data(m.E[any]("opacity", m.KotlinDouble(0.85)), m.E[any]("font", "mono"))),
	)
}

func TestDataMergesDefaultsProfilesAndMachine(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{
		Manifest: m.Manifest{
			Data: flags(),
			Machines: m.MapOf(
				machine("m", m.MachineConfig{Extends: []string{"omarchy"}, Data: data(
					m.E[any]("kitty", data(m.E[any]("opacity", m.KotlinDouble(0.9)))),
					m.E[any]("tags", []any{"b"}),
				)}),
				machine("bare", m.MachineConfig{}),
			),
		},
		Profiles: m.MapOf(profile("omarchy", m.MachineConfig{Data: data(
			m.E[any]("omarchy", true),
			m.E[any]("kitty", data(m.E[any]("font", "fira"))),
		)})),
	})
	// Defaults under profile under machine; tables merge key by key, lists replace.
	var lines []string
	for _, l := range m.DataLines(manifest.Machines.Value("m").Data, "") {
		lines = append(lines, l.Key+"="+l.Value)
	}
	if want := []string{`kitty.font="fira"`, "kitty.opacity=0.9", "omarchy=true", `tags=["b"]`}; !slices.Equal(lines, want) {
		t.Fatalf("lines %v", lines)
	}
	// Every machine carries every declared key.
	if !m.JSONEqual(manifest.Data, manifest.Machines.Value("bare").Data) {
		t.Fatal("bare machine lacks the defaults")
	}
	if v := manifest.Data.Value("omarchy"); v != false {
		t.Fatalf("omarchy = %v", v)
	}
}

func TestUndeclaredOrMistypedDataIsAnError(t *testing.T) {
	defaults := data(m.E[any]("work", false))
	contains(t, draftRefusal(t, m.Manifest{Data: defaults, Machines: m.MapOf(machine("m", m.MachineConfig{Data: data(m.E[any]("wrok", true))}))}),
		"machine 'm': data key 'wrok' is not declared in the data schema")
	contains(t, draftRefusal(t, m.Manifest{Data: defaults, Machines: m.MapOf(machine("m", m.MachineConfig{Data: data(m.E[any]("work", "yes"))}))}),
		"machine 'm': data key 'work' is a string, but the data schema declares a boolean")
}

// ─── files and origins (contracts 4, 5) ────────────────────────────────

// managedBy is a script managed by a repo script, as the front end writes one.
func managedBy(script, origin string) m.ScriptStep {
	return m.ScriptStep{File: s(script), Check: s("file:" + script + ` check "$@"`), Origin: origin}
}

func TestPathsAreRelativeToTheDeclaringDirectoryAndStayInTheRepo(t *testing.T) {
	tmux := ManifestDraft{Manifest: m.Manifest{Scripts: m.MapOf(m.E("tmux-plugins", managedBy("plugins.sh", "configs/tmux")))}}
	contains(t, refusal(t, tmux, "plugins.sh"), "scripts.tmux-plugins: file 'plugins.sh' not found (relative to configs/tmux/)")
	if got := inRepo(t, tmux, "configs/tmux/plugins.sh").Scripts.Value("tmux-plugins").Origin; got != "configs/tmux" {
		t.Fatalf("origin %s", got)
	}
	escaping := ManifestDraft{Manifest: m.Manifest{Scripts: m.MapOf(m.E("x", m.ScriptStep{File: s("../../../outside.sh"), Origin: "a/b"}))}}
	contains(t, refusal(t, escaping), "file '../../../outside.sh' leaves the repo")
	// `..` that stays inside the repo reaches a shared helper.
	helper := ManifestDraft{Manifest: m.Manifest{Scripts: m.MapOf(m.E("x", m.ScriptStep{File: s("../lib/helper.sh"), Origin: "a/b"}))}}
	if got := *inRepo(t, helper, "a/lib/helper.sh").Scripts.Value("x").File; got != "../lib/helper.sh" {
		t.Fatalf("file %s", got)
	}
}

func TestEveryFileCommandIsChecked(t *testing.T) {
	message := refusal(t, ManifestDraft{Manifest: m.Manifest{
		Programs: programs(m.E("tool", m.Program{Install: install(m.E("script", m.InstallVariant{
			Command: s("file:scripts/tool.sh install --verbose"), Check: s("file:scripts/tool-check.sh"), Regex: s("(.*)"),
		}))})),
		Scripts:  m.MapOf(m.E("setup", m.ScriptStep{Run: s("true"), Check: s("file:scripts/setup.sh check")})),
		Outdated: m.MapOf(m.E("pins", m.OutdatedSource{Command: s("file:pins.sh"), Upgrade: s("file:pins.sh bump {item}")})),
	}})
	// The path is named alone, never its arguments.
	contains(t, message,
		"programs.tool.install.script: file 'scripts/tool.sh' not found",
		"programs.tool.install.script check: file 'scripts/tool-check.sh' not found",
		"scripts.setup.check: file 'scripts/setup.sh' not found",
		"outdated.pins: file 'pins.sh' not found",
		"outdated.pins.upgrade: file 'pins.sh' not found",
	)
}

func TestAnInstallRunsWhereItsCommandWasWritten(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{Manifest: m.Manifest{
		Installers: m.MapOf(m.E("pm", m.Installer{Install: s("pm add {pkg}"), Check: s("pm query {pkg}"), Regex: s("(.*)"), Origin: "programs/installers"})),
		Programs: programs(
			m.E("jq", m.Program{Install: via("pm"), Origin: "programs/cli"}),
			m.E("odd", m.Program{Install: install(m.E("pm", m.InstallVariant{Command: s("make install")})), Origin: "programs/cli"}),
		),
	}})
	jq := manifest.ResolveInstall("jq", "pm")
	odd := manifest.ResolveInstall("odd", "pm")
	if jq.CommandOrigin != "programs/installers" || jq.Check.Origin != "programs/installers" ||
		odd.CommandOrigin != "programs/cli" || odd.Check.Origin != "programs/installers" {
		t.Fatalf("jq %s %s odd %s %s", jq.CommandOrigin, jq.Check.Origin, odd.CommandOrigin, odd.Check.Origin)
	}
}

func dnfRepo(repofile, origin string) m.Program {
	return m.Program{Install: install(m.E("dnf-repo", m.InstallVariant{With: pm("repofile", repofile)})), Origin: origin}
}

func TestAFileWithValueIsAPathNextToItsProgram(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{Manifest: m.Manifest{Programs: programs(
		m.E("code", dnfRepo("file:repos/code.repo", "programs/apps")),
		m.E("teams", dnfRepo("https://example.com/teams.repo", "programs/apps")),
	)}}, "programs/apps/repos/code.repo")
	contains(t, *manifest.ResolveInstall("code", "dnf-repo").Command, "--from-repofile=$LOADOUT_REPO/programs/apps/repos/code.repo")
	// Unmarked values (a URL) pass through as written.
	contains(t, *manifest.ResolveInstall("teams", "dnf-repo").Command, "--from-repofile=https://example.com/teams.repo")
	contains(t, refusal(t, ManifestDraft{Manifest: m.Manifest{Programs: programs(m.E("code", dnfRepo("file:repos/code.repo", "programs/apps")))}}),
		"programs.code.install.dnf-repo.with.repofile: file 'repos/code.repo' not found (relative to programs/apps/)")
	// A lock's value is a repo path, checked again on load.
	if problems := CheckFiles(manifest, fsWith(), nil); len(problems) != 1 ||
		problems[0] != "programs.code.install.dnf-repo.with.repofile: file 'programs/apps/repos/code.repo' not found (relative to the repo root)" {
		t.Fatalf("problems %v", problems)
	}
}

// ─── a child repo's parent (contract 18) ───────────────────────────────

func inChild(d ManifestDraft, files ...string) (m.Manifest, error) {
	repo, parent := fstest.MapFS{}, fstest.MapFS{}
	for _, f := range files {
		if p, ok := strings.CutPrefix(f, "parent:"); ok {
			parent[p] = &fstest.MapFile{Data: []byte("#!/bin/sh\n")}
		} else {
			repo[f] = &fstest.MapFile{Data: []byte("#!/bin/sh\n")}
		}
	}
	return Assemble(withState(d), repo, parent)
}

func TestAParentsFilesResolveInItsCheckout(t *testing.T) {
	d := ManifestDraft{Manifest: m.Manifest{Scripts: m.MapOf(
		m.E("helper", managedBy("helper.sh", "parent:maintenance/lib")),
		m.E("mine", managedBy("mine.sh", "scripts")),
	)}}
	manifest, err := inChild(d, "parent:maintenance/lib/helper.sh", "scripts/mine.sh")
	if err != nil {
		t.Fatal(err)
	}
	if got := manifest.Scripts.Value("helper").Origin; got != "parent:maintenance/lib" {
		t.Fatalf("origin %s", got)
	}
	// The same file in the child's root is not the parent's.
	_, err = inChild(d, "maintenance/lib/helper.sh", "scripts/mine.sh")
	if err == nil {
		t.Fatal("assembled")
	}
	contains(t, err.Error(), "scripts.helper: file 'helper.sh' not found (relative to parent:maintenance/lib/)")
}

func TestAParentsFileWithValueIsUnderLoadoutParent(t *testing.T) {
	d := ManifestDraft{Manifest: m.Manifest{Programs: programs(m.E("code", dnfRepo("file:repos/code.repo", "parent:programs/apps")))}}
	manifest, err := inChild(d, "parent:programs/apps/repos/code.repo")
	if err != nil {
		t.Fatal(err)
	}
	// The built-in dnf-repo runs in the child: the path can't lean on LOADOUT_REPO.
	contains(t, *manifest.ResolveInstall("code", "dnf-repo").Command, "--from-repofile=$LOADOUT_PARENT/programs/apps/repos/code.repo")
	_, err = inChild(d, "programs/apps/repos/code.repo")
	if err == nil {
		t.Fatal("assembled")
	}
	contains(t, err.Error(), "programs.code.install.dnf-repo.with.repofile: file 'repos/code.repo' not found (relative to parent:programs/apps/)")
}

func TestALockWithoutAParentSaysNothingOfOne(t *testing.T) {
	lock := m.Lock{ToolVersion: "1.0.0", Sources: "x", Manifest: inRepo(t, ManifestDraft{})}
	text := m.EncodeLock(lock)
	if strings.Contains(text, "parent") {
		t.Fatalf("parent in\n%s", text)
	}
	parent := m.ParentLayout{Name: "dotfiles", Path: "~/.local/share/chezmoi", State: "state", Configs: s("configs"), Sources: []string{"loadout.kt"}, Hash: "abc"}
	lock.Manifest.Layout.Parent = &parent
	decoded, err := m.DecodeLock(m.EncodeLock(lock), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	got := decoded.Manifest.Layout.Parent
	if got == nil || got.Name != parent.Name || got.Path != parent.Path || got.State != parent.State || *got.Configs != "configs" ||
		!slices.Equal(got.Sources, parent.Sources) || got.Hash != "abc" {
		t.Fatalf("parent %+v", got)
	}
}

func TestTheLockRoundTrips(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{Manifest: m.Manifest{
		Programs: programs(m.E("jq", m.Program{Install: via("brew")})),
		Machines: m.MapOf(machine("m", m.MachineConfig{PM: pm("jq", "brew")})),
	}})
	text := m.EncodeLock(m.Lock{ToolVersion: "3.0.0", Sources: "abc", Manifest: manifest})
	decoded, err := m.DecodeLock(text, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if again := m.EncodeLock(decoded); again != text {
		t.Fatalf("round trip:\n%s\nvs\n%s", again, text)
	}
}

// ─── built-ins (contract 13) ───────────────────────────────────────────

func TestBuiltInsResolveWithoutBeingDeclared(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{Manifest: m.Manifest{Programs: programs(m.E("ripgrep", m.Program{Install: via("dnf")}))}})
	r := manifest.ResolveInstall("ripgrep", "dnf")
	if *r.Command != "sudo dnf install -y ripgrep" || r.Check.Command != "rpm -q ripgrep" || *r.Probe != "dnf" {
		t.Fatalf("resolved %+v", r)
	}
	if !slices.Contains(manifest.BuiltinInstallers, "dnf") {
		t.Fatal("dnf not built in")
	}
	if !slices.IsSorted(manifest.BuiltinInstallers) || !slices.IsSorted(manifest.Installers.Keys()) {
		t.Fatal("not sorted")
	}
}

func TestARepoInstallerReplacesTheBuiltInOfTheSameName(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{Manifest: m.Manifest{
		Installers: m.MapOf(m.E("dnf", m.Installer{Probe: s("dnf"), Install: s("sudo dnf5 install -y {pkg}")})),
		Programs:   programs(m.E("ripgrep", m.Program{Install: via("dnf")})),
	}})
	if got := *manifest.ResolveInstall("ripgrep", "dnf").Command; got != "sudo dnf5 install -y ripgrep" {
		t.Fatalf("command %s", got)
	}
	// Replaced outright, not merged: the built-in's oracle is gone with it.
	if slices.Contains(manifest.BuiltinInstallers, "dnf") || manifest.Installers.Value("dnf").OutdatedAll != nil ||
		!slices.Contains(manifest.BuiltinInstallers, "brew") {
		t.Fatal("dnf still built in")
	}
}

func TestARequirementOnABuiltInKeepsItBuiltIn(t *testing.T) {
	manifest := inRepo(t, ManifestDraft{
		Manifest: m.Manifest{Programs: programs(
			m.E("setup-dnf", m.Program{Install: install(m.E("dnf", m.InstallVariant{Command: s("file:setup-dnf.sh install"), Check: s("file:setup-dnf.sh check"), Present: true}))}),
			m.E("curl", m.Program{Install: via("dnf")}),
		)},
		Requires: m.MapOf(m.E("dnf", []string{"setup-dnf"})),
	}, "setup-dnf.sh")
	if got := manifest.Installers.Value("dnf").Requires; !slices.Equal(got, []string{"setup-dnf"}) {
		t.Fatalf("requires %v", got)
	}
	if !slices.Contains(manifest.BuiltinInstallers, "dnf") {
		t.Fatal("dnf no longer built in")
	}
	contains(t, refusal(t, ManifestDraft{Requires: m.MapOf(m.E("ghost", []string{"x"}))}), "requires on unknown installer 'ghost'")
}

func TestTheShippedLibraryIsUsable(t *testing.T) {
	installers := m.InstallerLibrary()
	for _, name := range []string{"dnf", "apt", "pacman", "omarchy", "omarchy-aur", "brew", "brew-cask", "flatpak"} {
		if !installers.Has(name) {
			t.Errorf("no %s", name)
		}
	}
	for name, i := range installers.All() {
		if i.Probe == nil {
			t.Errorf("%s has no probe", name)
		}
		if i.Install == nil || !strings.Contains(*i.Install, "{pkg}") {
			t.Errorf("%s install ignores {pkg}", name)
		}
		if i.Check == nil || !strings.Contains(*i.Check, "{pkg}") {
			t.Errorf("%s check ignores {pkg}", name)
		}
		// A batch oracle always wins over the per-pkg one: both would ship dead config.
		if i.Outdated != nil {
			t.Errorf("%s declares an unreachable per-pkg oracle", name)
		}
	}
	want := []string{"dnf", "brew", "brew-cask", "flatpak", "dnf-repo", "dnf-copr", "pacman", "omarchy", "omarchy-aur", "apt"}
	if got := m.InstallerLibraryNames(); !slices.Equal(got, want) {
		t.Fatalf("names %v", got)
	}
}

func TestTheShippedMechanismsShareTheirSweeps(t *testing.T) {
	// `upgrade` dedupes steps by command: the dnf mechanisms must spell
	// theirs identically, and refresh (the oracle reads a local cache).
	installers := m.InstallerLibrary()
	for _, name := range []string{"dnf", "dnf-repo", "dnf-copr"} {
		if got := *installers.Value(name).Upgrade; got != "sudo dnf upgrade --refresh -y" {
			t.Errorf("%s upgrade %s", name, got)
		}
	}
	// Omarchy's update upgrades repo and AUR packages alike, never a bare pacman -Syu.
	for _, name := range []string{"omarchy", "omarchy-aur"} {
		i := installers.Value(name)
		if *i.Upgrade != "omarchy update -y" || *i.Probe != "omarchy" {
			t.Errorf("%s %+v", name, i)
		}
	}
	if *installers.Value("omarchy").Install != "omarchy pkg add {pkg}" || *installers.Value("omarchy-aur").Install != "omarchy pkg aur add {pkg}" {
		t.Error("omarchy installs")
	}
}

func TestMetaVersionIsADottedNumber(t *testing.T) {
	contains(t, refusal(t, ManifestDraft{Manifest: m.Manifest{Meta: m.Meta{Name: "x", MinToolVersion: s("soon")}}}),
		"meta min-tool-version 'soon' is not a dotted version number")
	_, err := Assemble(ManifestDraft{}, fsWith(), nil)
	if err == nil || !strings.Contains(err.Error(), "layout state is missing") {
		t.Fatalf("err %v", err)
	}
	contains(t, refusal(t, ManifestDraft{Manifest: m.Manifest{Layout: m.RepoLayout{State: "st*te", Configs: s("../c")}}}),
		"layout 'st*te' is a directory, not a glob", "layout '../c' leaves the repo (..)")
}

func TestTheRefusalListsEveryError(t *testing.T) {
	message := draftRefusal(t, m.Manifest{Programs: programs(m.E("a", m.Program{DependsOn: []string{"x", "y"}, Install: custom("true")}))})
	if want := "Invalid manifest:\n  - programs.a depends-on unknown program 'x'\n  - programs.a depends-on unknown program 'y'"; message != want {
		t.Fatalf("message %q", message)
	}
}

func TestTheRealLockReassemblesToItself(t *testing.T) {
	text, err := os.ReadFile("testdata/loadout.lock.json")
	if err != nil {
		t.Fatal(err)
	}
	lock, err := m.DecodeLock(string(text), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	// The lock as a draft: built-ins taken out again, their requirements kept.
	d := ManifestDraft{Manifest: lock.Manifest}
	for _, name := range lock.Manifest.BuiltinInstallers {
		if req := lock.Manifest.Installers.Value(name).Requires; len(req) > 0 {
			d.Requires.Set(name, req)
		}
		d.Manifest.Installers = d.Manifest.Installers.Clone()
		d.Manifest.Installers.Delete(name)
	}
	d.Manifest.BuiltinInstallers = nil
	// Machines are flat already: what they extend adds nothing.
	for config := range lock.Manifest.Machines.Values() {
		for _, name := range config.Extends {
			d.Profiles.Set(name, m.MachineConfig{Label: "profile '" + name + "'"})
		}
	}
	manifest, err := AssembleWithoutFiles(d)
	if err != nil {
		t.Fatal(err)
	}
	lock.Manifest = manifest
	if got := m.EncodeLock(lock); got != string(text) {
		t.Fatal("reassembled lock differs")
	}
}
