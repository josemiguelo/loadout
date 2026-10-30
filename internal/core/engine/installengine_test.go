package engine

import (
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	ct "github.com/josemiguelo/loadout/internal/core/coretest"
	"github.com/josemiguelo/loadout/internal/core/exec/fakeexec"
	"github.com/josemiguelo/loadout/internal/model"
)

func installs(runner *fakeexec.Runner) *InstallEngine {
	if runner == nil {
		runner = fakeexec.New()
	}
	return NewInstallEngine(runner, NewVersionChecker(runner, repoFrame), repoFrame)
}

func yes(string) bool { return true }
func no(string) bool  { return false }

func states(entries ...model.Entry[cs]) model.Map[cs] { return model.MapOf(entries...) }

func installed(v string) cs { return cs{Status: coremodel.Installed, Version: &v} }

func plan(t *testing.T, m model.Manifest, machine string, requested []string, current model.Map[cs], available func(string) bool) []PlanItem {
	t.Helper()
	return must[[]PlanItem](t)(installs(nil).Plan(m, machine, requested, current, available))
}

func planRefusal(t *testing.T, m model.Manifest, machine string, requested []string, current model.Map[cs], available func(string) bool) string {
	t.Helper()
	_, err := installs(nil).Plan(m, machine, requested, current, available)
	return refused[*ResolutionException](t, err)
}

func programsOf(items []PlanItem) []string {
	var out []string
	for _, item := range items {
		out = append(out, item.ProgramName())
	}
	return out
}

func eq(t *testing.T, want, got any) {
	t.Helper()
	if !reflect.DeepEqual(want, got) {
		t.Errorf("\nwant %#v\n got %#v", want, got)
	}
}

func TestPlanUsesMachineMappingSkipsInstalledAndExpandsDeps(t *testing.T) {
	current := states(model.E("git", installed("2.46.0")), model.E("ripgrep", cs{Status: coremodel.Missing}))
	got := plan(t, ct.Example(t), "laptop", []string{"ripgrep"}, current, yes)
	// ripgrep depends on git: git first (already installed), then ripgrep via laptop's dnf mapping.
	eq(t, []PlanItem{
		InstalledItem{"git", s("2.46.0")},
		InstallItem{Program: "ripgrep", InstallKey: "dnf", Command: "sudo dnf install -y ripgrep", Sudo: true},
	}, got)
}

func TestPlanPicksDifferentKeysPerMachine(t *testing.T) {
	m := ct.Example(t)
	laptop := plan(t, m, "laptop", []string{"git"}, model.Map[cs]{}, yes)
	macbook := plan(t, m, "macbook", []string{"git"}, model.Map[cs]{}, yes)
	eq(t, "sudo dnf install -y git", laptop[0].(InstallItem).Command)
	eq(t, "brew install git", macbook[0].(InstallItem).Command)
}

func TestPlanResolvesCustomScriptKeys(t *testing.T) {
	got := plan(t, ct.Example(t), "laptop", []string{"rustup"}, model.Map[cs]{}, yes)
	eq(t, []PlanItem{InstallItem{Program: "rustup", InstallKey: "script", Command: "curl -sSf https://sh.rustup.rs | sh -s -- -y"}}, got)
}

func TestAVariantsDependenciesOnlyComeWithThatVariant(t *testing.T) {
	// kitty from a COPR needs dnf-plugins-core first; kitty from pacman
	// needs nothing — and must not drag a dnf package into the plan.
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Program("dnf-plugins-core", model.Program{Install: ct.Variants(model.E("dnf", model.InstallVariant{Command: s("dnf install dnf-plugins-core")}))})
		b.Program("kitty", model.Program{Install: ct.Variants(
			model.E("copr", model.InstallVariant{Command: s("dnf copr enable kitty"), DependsOn: []string{"dnf-plugins-core"}}),
			model.E("pacman", model.InstallVariant{Command: s("pacman -S kitty")}),
		)})
		b.Machine("fedora", model.MachineConfig{PM: ct.PM("kitty", "copr", "dnf-plugins-core", "dnf")})
		b.Machine("arch", model.MachineConfig{PM: ct.PM("kitty", "pacman")})
	})
	eq(t, []string{"dnf-plugins-core", "kitty"}, programsOf(plan(t, m, "fedora", []string{"kitty"}, model.Map[cs]{}, yes)))
	eq(t, []string{"kitty"}, programsOf(plan(t, m, "arch", []string{"kitty"}, model.Map[cs]{}, yes)))
}

func sudoOf(items []PlanItem) map[string]bool {
	out := map[string]bool{}
	for _, item := range Installs(items) {
		out[item.Program] = item.Sudo
	}
	return out
}

func TestSudoDeclarationsReachThePlan(t *testing.T) {
	// `sudo` on an installer marks its installs; a variant's replaces it.
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("omarchy-pkg", model.Installer{Install: s("omarchy pkg add {pkg}"), Sudo: true})
		b.Program("zsh", model.Program{Install: ct.Via("omarchy-pkg")})
		b.Program("plain", model.Program{Install: ct.Custom("custom", "true")})
		b.Machine("m", model.MachineConfig{PM: ct.PM("zsh", "omarchy-pkg", "plain", "custom")})
	})
	eq(t, map[string]bool{"zsh": true, "plain": false}, sudoOf(plan(t, m, "m", []string{"zsh", "plain"}, model.Map[cs]{}, yes)))
}

func oneTool(t *testing.T, command string) model.Manifest {
	return ct.ManifestOf(t, func(b *ct.Draft) {
		b.Program("tool", model.Program{Install: ct.Custom("script", command)})
		b.Machine("m", model.MachineConfig{PM: ct.PM("tool", "script")})
	})
}

func TestFileInstallValuesRunAsRepoScripts(t *testing.T) {
	got := plan(t, oneTool(t, "file:scripts/install-tool.sh"), "m", nil, model.Map[cs]{}, yes)
	eq(t, []PlanItem{InstallItem{Program: "tool", InstallKey: "script", Command: "sh 'scripts/install-tool.sh'"}}, got)
}

func TestFileInstallValuesPassArgumentsThrough(t *testing.T) {
	got := plan(t, oneTool(t, "file:scripts/tool.sh install --verbose"), "m", nil, model.Map[cs]{}, yes)
	eq(t, []PlanItem{InstallItem{Program: "tool", InstallKey: "script", Command: "sh 'scripts/tool.sh' install --verbose"}}, got)
}

func TestAProgramsPathComesFirstOnTheInstallCommandsPath(t *testing.T) {
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Program("tool", model.Program{Path: []string{"$HOME/.local/bin"}, Install: ct.Custom("custom", "file:install.sh")})
		b.Machine("m", model.MachineConfig{PM: ct.PM("tool", "custom")})
	})
	item := plan(t, m, "m", nil, model.Map[cs]{}, yes)[0].(InstallItem)
	eq(t, `PATH="$HOME/.local/bin:$PATH"; export PATH; sh 'install.sh'`, item.Command)
}

func TestAnInstallersRequirementIsPlannedFirst(t *testing.T) {
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Program("setup-brew", model.Program{Install: ct.Custom("custom", "setup")})
		b.Installer("brew", model.Installer{Install: s("brew install {pkg}")})
		b.Requires("brew", "setup-brew")
		b.Program("jq", model.Program{Install: ct.Via("brew")})
		b.Machine("m", model.MachineConfig{PM: ct.PM("setup-brew", "custom", "jq", "brew")})
		b.Machine("bare", model.MachineConfig{PM: ct.PM("jq", "brew")})
	})
	eq(t, []string{"setup-brew", "jq"}, programsOf(plan(t, m, "m", []string{"jq"}, model.Map[cs]{}, yes)))

	// The requirement is a dependency: a machine that doesn't install it can't install jq.
	contains(t, planRefusal(t, m, "bare", nil, model.Map[cs]{}, yes), "'setup-brew' is required as a dependency")
}

func TestTiesBreakByName(t *testing.T) {
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Program("zeta", model.Program{Install: ct.Custom("custom", "z")})
		b.Program("alpha", model.Program{Install: ct.Custom("custom", "a")})
		b.Machine("m", model.MachineConfig{PM: ct.PM("zeta", "custom", "alpha", "custom")})
	})
	eq(t, []string{"alpha", "zeta"}, programsOf(plan(t, m, "m", []string{"zeta", "alpha"}, model.Map[cs]{}, yes)))
}

func TestEmptyRequestPlansEverything(t *testing.T) {
	got := programsOf(plan(t, ct.Example(t), "laptop", nil, model.Map[cs]{}, yes))
	slices.Sort(got)
	eq(t, []string{"git", "ripgrep", "rustup"}, got)
}

func TestFailsWhenMachineIsNotDeclared(t *testing.T) {
	contains(t, planRefusal(t, ct.Example(t), "unknown-box", nil, model.Map[cs]{}, yes), "machine 'unknown-box' is not declared in the repo")
}

func TestConvergeSkipsUnmappedPrograms(t *testing.T) {
	partial := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Program("a", model.Program{Install: ct.Variants(model.E("dnf", model.InstallVariant{Command: s("sudo dnf install -y a")}))})
		b.Program("b", model.Program{Install: ct.Variants(model.E("dnf", model.InstallVariant{Command: s("sudo dnf install -y b")}))})
		b.Machine("m", model.MachineConfig{PM: ct.PM("a", "dnf")})
	})
	// b is not part of m's loadout: converge plans only a, no error.
	eq(t, []string{"a"}, programsOf(plan(t, partial, "m", nil, model.Map[cs]{}, yes)))
	// ...but explicitly requesting it is an error.
	contains(t, planRefusal(t, partial, "m", []string{"b"}, model.Map[cs]{}, yes), "program 'b' isn't installed on machine 'm'")
}

func TestUnmappedDependencyOfMappedProgramFails(t *testing.T) {
	partial := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Program("base", model.Program{Install: ct.Variants(model.E("dnf", model.InstallVariant{Command: s("sudo dnf install -y base")}))})
		b.Program("tool", model.Program{
			DependsOn: []string{"base"},
			Install:   ct.Variants(model.E("dnf", model.InstallVariant{Command: s("sudo dnf install -y tool")})),
		})
		b.Machine("m", model.MachineConfig{PM: ct.PM("tool", "dnf")})
	})
	contains(t, planRefusal(t, partial, "m", nil, model.Map[cs]{}, yes), "required as a dependency", "'base'")
}

func TestFailsWhenMappedPmIsNotInstalled(t *testing.T) {
	contains(t, planRefusal(t, ct.Example(t), "laptop", []string{"ripgrep"}, model.Map[cs]{}, no),
		"required binary 'dnf'", "not installed on machine 'laptop'")
}

func TestProbeProvidedByAnEarlierProgramInThePlan(t *testing.T) {
	pkg := model.Installer{Probe: s("pkg"), Install: s("pkg add {pkg}"), Check: s("pkg info {pkg}")}
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("pkg", pkg)
		b.Installer("flat", model.Installer{Probe: s("flat"), Install: s("flat install {pkg}"), Check: s("flat info {pkg}")})
		b.Program("flat-runtime", model.Program{Install: ct.Variants(model.E("pkg", model.InstallVariant{Provides: []model.Provides{{Binary: "flat"}}}))})
		b.Requires("flat", "flat-runtime")
		b.Program("app", model.Program{Install: ct.Via("flat")})
		b.Machine("m", model.MachineConfig{PM: ct.PM("flat-runtime", "pkg", "app", "flat")})
	})
	onlyPkg := func(b string) bool { return b == "pkg" }

	// flat is missing, but flat-runtime installs it first.
	eq(t, []string{"flat-runtime", "app"}, programsOf(plan(t, m, "m", []string{"app"}, model.Map[cs]{}, onlyPkg)))

	// Already installed and still no binary: nothing in the plan provides it.
	contains(t, planRefusal(t, m, "m", []string{"app"}, states(model.E("flat-runtime", installed("1.0"))), onlyPkg),
		"required binary 'flat' (needed to install app) is not installed")

	// A provider later in the plan doesn't count, and the error says how to order it.
	m2 := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("pkg", pkg)
		b.Program("first", model.Program{Install: ct.Variants(model.E("pkg", model.InstallVariant{Probe: s("flat")}))})
		b.Program("flat-runtime", model.Program{
			DependsOn: []string{"first"},
			Install:   ct.Variants(model.E("pkg", model.InstallVariant{Provides: []model.Provides{{Binary: "flat"}}})),
		})
		b.Machine("m", model.MachineConfig{PM: ct.PM("first", "pkg", "flat-runtime", "pkg")})
	})
	contains(t, planRefusal(t, m2, "m", nil, model.Map[cs]{}, onlyPkg),
		"comes from 'flat-runtime', which would install after them", "needed to install first)")
}

func TestAProvidedToolOffPathIsFoundWhereItLandsAndRunsFromThere(t *testing.T) {
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("pkg", model.Installer{Probe: s("pkg"), Install: s("pkg add {pkg}"), Check: s("pkg info {pkg}")})
		b.Installer("brewish", model.Installer{Probe: s("brewish"), Install: s("brewish install {pkg}"), Check: s("brewish list {pkg}")})
		b.Program("setup-brewish", model.Program{Install: ct.Variants(
			model.E("linux", model.InstallVariant{Command: s("install-brewish"), Provides: []model.Provides{{Binary: "brewish", At: s("/opt/brewish/bin")}}}),
			model.E("macos", model.InstallVariant{Command: s("install-brewish"), Provides: []model.Provides{{Binary: "brewish", At: s("/opt/other/bin")}}}),
		)})
		b.Requires("brewish", "setup-brewish")
		b.Program("tool", model.Program{Install: ct.Via("brewish")})
		b.Machine("m", model.MachineConfig{PM: ct.PM("setup-brewish", "linux", "tool", "brewish")})
	}).ForMachine("m")

	// Only the mapped variant's folder counts.
	eq(t, map[string][]string{"brewish": {"/opt/brewish/bin"}}, m.ToolPaths)

	// Installed already, off PATH: found where it lands, and the install runs with it first on PATH.
	current := states(model.E("setup-brewish", cs{Status: coremodel.Installed}))
	step := Installs(plan(t, m, "m", []string{"tool"}, current, func(b string) bool { return b == "/opt/brewish/bin/brewish" }))
	eq(t, 1, len(step))
	eq(t, `PATH="/opt/brewish/bin:$PATH"; export PATH; brewish install tool`, step[0].Command)

	// The check goes through it from there too.
	eq(t, []string{"/opt/brewish/bin"}, m.CheckFor("tool", s("brewish")).Path)
	eq(t, []string{"/opt/brewish/bin"}, m.ToolPathOf("brewish"))
}

func TestPmCheckSkippedForInstalledProgramsAndCustomKeys(t *testing.T) {
	// Everything installed -> no Install items -> pm availability never consulted.
	current := states(model.E("git", installed("2.46.0")), model.E("ripgrep", installed("14.1.0")), model.E("rustup", installed("1.27.1")))
	got := plan(t, ct.Example(t), "laptop", nil, current, func(string) bool { t.Fatal("must not probe"); return false })
	if len(Installs(got)) != 0 {
		t.Errorf("%v", got)
	}
	// Custom keys (script) are never probed either.
	scriptOnly := plan(t, ct.Example(t), "laptop", []string{"rustup"}, model.Map[cs]{}, no)
	eq(t, []string{"rustup"}, programsOf(installsOnly(scriptOnly)))
}

// installsOnly is items' installs as PlanItems.
func installsOnly(items []PlanItem) []PlanItem {
	var out []PlanItem
	for _, i := range Installs(items) {
		out = append(out, i)
	}
	return out
}

func TestInstallerMechanicsResolveByMappedKey(t *testing.T) {
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("brew-cask", model.Installer{
			Probe: s("brew"), Install: s("brew install --cask {pkg}"),
			Check: s("brew list --cask --versions {pkg}"), Regex: s("([0-9.]+)"),
		})
		b.Program("toolbox", model.Program{Install: ct.Variants(model.E("brew-cask", model.InstallVariant{Pkg: s("toolbox-linux")}))})
		b.Machine("m", model.MachineConfig{PM: ct.PM("toolbox", "brew-cask")})
	})
	// Probe: the variant inherits its installer's probe binary.
	var probed []string
	plan(t, m, "m", nil, model.Map[cs]{}, func(b string) bool { probed = append(probed, b); return true })
	eq(t, []string{"brew"}, probed)

	// Probe failure names the binary.
	contains(t, planRefusal(t, m, "m", nil, model.Map[cs]{}, no), "required binary 'brew'")

	// Post-install re-check uses the mapped key's check, not the default.
	runner := fakeexec.New().
		OnCommand("brew install --cask toolbox-linux").
		OnCommand("brew list --cask --versions toolbox-linux", fakeexec.Stdout("toolbox-linux 3.5.0"))
	p := must[[]PlanItem](t)(installs(runner).Plan(m, "m", nil, model.Map[cs]{}, yes))
	outcomes := must[[]InstallOutcome](t)(installs(runner).Execute(m, p, nil, nil))
	if len(outcomes) != 1 || !outcomes[0].Success() || versionOf(outcomes[0].StateAfter) != "3.5.0" {
		t.Errorf("%+v", outcomes)
	}
}

func TestExecuteRunsInstallsAndRechecksVersions(t *testing.T) {
	runner := fakeexec.New().
		OnCommand("sudo dnf install -y ripgrep").
		OnCommand("rg --version", fakeexec.Stdout("ripgrep 14.1.0"))
	m := ct.Example(t)
	p := must[[]PlanItem](t)(installs(runner).Plan(m, "laptop", []string{"ripgrep"}, model.Map[cs]{}, yes))
	outcomes := must[[]InstallOutcome](t)(installs(runner).Execute(m, p, nil, nil))

	if len(outcomes) != 2 || outcomes[0].Program != "git" || outcomes[1].Program != "ripgrep" {
		t.Fatalf("%+v", outcomes)
	}
	// git (ripgrep's dependency) fails (unregistered command), so ripgrep isn't tried.
	if outcomes[0].Success() {
		t.Error("git succeeded")
	}
	eq(t, "git", outcomes[1].SkippedFor)

	// With git already there, ripgrep installs and is checked again.
	p = must[[]PlanItem](t)(installs(runner).Plan(m, "laptop", []string{"ripgrep"}, states(model.E("git", installed("2.46.0"))), yes))
	outcomes = must[[]InstallOutcome](t)(installs(runner).Execute(m, p, nil, nil))
	if len(outcomes) != 1 || !outcomes[0].Success() || versionOf(outcomes[0].StateAfter) != "14.1.0" {
		t.Errorf("ripgrep: %+v", outcomes)
	}
}

func TestExecuteSkipsWhatAFailedInstallWasNeededFor(t *testing.T) {
	// a fails; b needs a, c needs b (so c is skipped for b, which never ran);
	// d needs nothing and still installs.
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Program("a", model.Program{Install: ct.Custom("custom", "install-a")})
		b.Program("b", model.Program{DependsOn: []string{"a"}, Install: ct.Custom("custom", "install-b")})
		b.Program("c", model.Program{DependsOn: []string{"b"}, Install: ct.Custom("custom", "install-c")})
		b.Program("d", model.Program{Install: ct.Custom("custom", "install-d")})
		b.Machine("m", model.MachineConfig{PM: ct.PM("a", "custom", "b", "custom", "c", "custom", "d", "custom")})
	})
	runner := fakeexec.New().
		OnCommand("install-a", fakeexec.Exit(1)).
		OnCommand("install-b").OnCommand("install-c").OnCommand("install-d")
	p := must[[]PlanItem](t)(installs(runner).Plan(m, "m", nil, model.Map[cs]{}, yes))
	skips := map[string]string{}
	outcomes := must[[]InstallOutcome](t)(installs(runner).Execute(m, p, nil, func(item InstallItem, dep string) { skips[item.Program] = dep }))

	got := map[string]string{}
	for _, o := range outcomes {
		switch {
		case o.SkippedFor != "":
			got[o.Program] = "skipped for " + o.SkippedFor
		case o.Success():
			got[o.Program] = "installed"
		default:
			got[o.Program] = "failed"
		}
	}
	eq(t, map[string]string{"a": "failed", "b": "skipped for a", "c": "skipped for b", "d": "installed"}, got)
	eq(t, map[string]string{"b": "a", "c": "b"}, skips)
	for _, line := range runner.Executed() {
		if strings.Contains(line, "install-b") || strings.Contains(line, "install-c") {
			t.Errorf("ran %q", line)
		}
	}
	if !slices.ContainsFunc(runner.Executed(), func(line string) bool { return strings.Contains(line, "install-d") }) {
		t.Errorf("install-d didn't run: %q", runner.Executed())
	}
}
