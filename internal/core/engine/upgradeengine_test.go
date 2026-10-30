package engine

import (
	"testing"

	ct "github.com/josemiguelo/loadout/internal/core/coretest"
	"github.com/josemiguelo/loadout/internal/model"
)

func upgradeManifest(t *testing.T) model.Manifest {
	return ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("pm", model.Installer{Install: s("install {pkg}"), Upgrade: s("pm upgrade -y"), Check: s("pm show {pkg}"), Regex: s("([0-9.]+)")})
		b.Installer("rolling", model.Installer{Install: s("roll {pkg}"), Upgrade: s("roll -Syu"), Check: s("roll -Q {pkg}"), Regex: s("([0-9.]+)")})
		b.Installer("manual", model.Installer{Install: s("by hand {pkg}"), Check: s("true"), Regex: s("([0-9.]+)")})
		b.Program("alpha", model.Program{Install: ct.Via("pm")})
		b.Program("bravo", model.Program{Install: ct.Via("pm")})
		b.Program("charlie", model.Program{Install: ct.Via("rolling")})
		b.Program("delta", model.Program{Install: ct.Via("manual")})
		b.Machine("m1", model.MachineConfig{PM: ct.PM("alpha", "pm", "bravo", "pm", "charlie", "rolling", "delta", "manual")})
		b.Machine("m2", model.MachineConfig{PM: ct.PM("delta", "manual")})
	})
}

func upgradeRefusal(t *testing.T, m model.Manifest, machine string, installers ...string) string {
	t.Helper()
	_, err := PlanUpgrade(m, machine, installers)
	return refused[*UpgradeException](t, err)
}

func TestAnUpgradeIsAlwaysTheWholeMechanism(t *testing.T) {
	// Two programs from one installer, one command — and the command is the
	// mechanism's own sweep, not a package list.
	plan := must[[]UpgradeStep](t)(PlanUpgrade(upgradeManifest(t), "m1", []string{"pm"}))
	eq(t, 1, len(plan))
	eq(t, "pm upgrade -y", plan[0].Command)
	eq(t, []string{"alpha", "bravo"}, plan[0].Covers)
}

func TestAProvidedToolsFolderLeadsAndOnePlainCommandFromTwoFilesRunsOnce(t *testing.T) {
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("brewish", model.Installer{Probe: s("brewish"), Install: s("brewish install {pkg}"), Upgrade: s("brewish upgrade"), Check: s("brewish list {pkg}")})
		b.Installer("brewish-tap", model.Installer{
			Probe: s("brewish"), Install: s("brewish install tap/{pkg}"), Upgrade: s("brewish upgrade"),
			Check: s("brewish list {pkg}"), Origin: "programs/brewish",
		})
		b.Program("setup-brewish", model.Program{Install: ct.Variants(model.E("custom", model.InstallVariant{
			Command: s("install-brewish"), Provides: []model.Provides{{Binary: "brewish", At: s("/opt/brewish/bin")}},
		}))})
		b.Program("alpha", model.Program{Install: ct.Via("brewish")})
		b.Program("bravo", model.Program{Install: ct.Via("brewish-tap")})
		b.Machine("m", model.MachineConfig{PM: ct.PM("setup-brewish", "custom", "alpha", "brewish", "bravo", "brewish-tap")})
	}).ForMachine("m")
	plan := must[[]UpgradeStep](t)(PlanUpgrade(m, "m", []string{"brewish", "brewish-tap"}))
	eq(t, 1, len(plan))
	eq(t, []string{"brewish", "brewish-tap"}, plan[0].Installers)
	eq(t, `PATH="/opt/brewish/bin:$PATH"; export PATH; brewish upgrade`, plan[0].Command)
	eq(t, "brewish", plan[0].Label())
}

func TestNamingAProgramPointsAtItsMechanism(t *testing.T) {
	contains(t, upgradeRefusal(t, upgradeManifest(t), "m1", "alpha"), "upgrades are whole-mechanism")
}

func TestAMechanismThisMachineDoesNotUseIsRefused(t *testing.T) {
	// The safety property: `upgrade` can only run mechanisms this machine's
	// mapping actually installs through. Without it a repo that maps
	// nothing to brew could still run the real `brew upgrade`.
	contains(t, upgradeRefusal(t, upgradeManifest(t), "m2", "pm"), "not used by machine 'm2'")
}

func TestAnInstallerWithNoUpgradeCommandIsAnError(t *testing.T) {
	contains(t, upgradeRefusal(t, upgradeManifest(t), "m1", "manual"), "declares no upgrade command")
}

func TestOnlyMechanismsThisMachineActuallyUsesAreOffered(t *testing.T) {
	available := UpgradableInstallers(upgradeManifest(t), "m1")
	eq(t, []string{"pm", "rolling"}, available.Keys()) // manual declares no upgrade
	eq(t, []string{"alpha", "bravo"}, available.Value("pm"))
}

func TestACustomSourceUpgradesItsItemsOneAtATime(t *testing.T) {
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Outdated("pins", model.OutdatedSource{Command: s("list-pins"), Upgrade: s("repin {item}")})
	})
	plan := must[[]UpgradeStep](t)(PlanSourceItems(m, "pins", []string{"golang", "nodejs"}))
	var commands []string
	var covers [][]string
	for _, step := range plan {
		commands = append(commands, step.Command)
		covers = append(covers, step.Covers)
	}
	eq(t, []string{"repin golang", "repin nodejs"}, commands)
	eq(t, [][]string{{"golang"}, {"nodejs"}}, covers)
	eq(t, "pins: golang", plan[0].Label())
}

func TestSudoDeclarationsPlanAsUsual(t *testing.T) {
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("omarchy-pkg", model.Installer{
			Install: s("omarchy pkg add {pkg}"), Upgrade: s("omarchy update -y"),
			Check: s("pacman -Q {pkg}"), Regex: s("([0-9.]+)"), Sudo: true,
		})
		b.Program("zsh", model.Program{Install: ct.Via("omarchy-pkg")})
		b.Machine("m", model.MachineConfig{PM: ct.PM("zsh", "omarchy-pkg")})
		b.Outdated("pins", model.OutdatedSource{Command: s("list-pins"), Upgrade: s("repin {item}"), Sudo: true})
		b.Outdated("plain", model.OutdatedSource{Command: s("list"), Upgrade: s("bump {item}")})
	})
	step := must[[]UpgradeStep](t)(PlanUpgrade(m, "m", []string{"omarchy-pkg"}))[0]
	eq(t, "omarchy update -y", step.Command)
	eq(t, true, step.Sudo)
	pins := must[[]UpgradeStep](t)(PlanSourceItems(m, "pins", []string{"golang"}))
	eq(t, "repin golang", pins[0].Command)
	eq(t, true, pins[0].Sudo)
}

func TestASourceWithNoUpgradeCommandIsRefused(t *testing.T) {
	m := ct.ManifestOf(t, func(b *ct.Draft) { b.Outdated("pins", model.OutdatedSource{Command: s("list-pins")}) })
	_, err := PlanSourceItems(m, "pins", []string{"golang"})
	contains(t, refused[*UpgradeException](t, err), "declares no upgrade command")
}
