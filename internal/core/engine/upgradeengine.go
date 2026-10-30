package engine

import (
	"slices"
	"strings"

	"github.com/josemiguelo/loadout/internal/model"
)

// UpgradeStep is one upgrade command and every mechanism it covers. dnf,
// dnf-repo and dnf-copr all run `dnf upgrade -y`: that's ONE transaction,
// not three.
type UpgradeStep struct {
	Installers []string
	Command    string
	// Covers is the machine's programs these mechanisms install — what you'll see move.
	Covers []string
	// Sweep is true for a whole-mechanism sweep; false for one custom-source item.
	Sweep bool
	// Tool is the tool the sweep's mechanisms all drive (their shared probe), when they do.
	Tool *string
	// Origin is where Command runs: its declaring file's repo-relative directory.
	Origin string
	// Program is true for a program's own upgrade (Covers is that program alone), not an installer's or a source's.
	Program bool
	// Sudo says Command needs sudo's password: it runs sudo, or its installer or source says so.
	Sudo bool
}

// Label is what to call this step on screen: a sweep is the TOOL it drives
// when its mechanisms share one — a user knows "dnf", not that the manifest
// splits it into dnf/dnf-repo/dnf-copr — else the mechanisms; a per-item
// step is the source AND the item, since "pins" alone doesn't say which pin
// failed.
func (s UpgradeStep) Label() string {
	switch {
	case !s.Sweep && s.Installers[0] == s.Covers[0]:
		return s.Covers[0]
	case !s.Sweep:
		return s.Installers[0] + ": " + s.Covers[0]
	case s.Tool != nil:
		return *s.Tool
	}
	return strings.Join(s.Installers, ", ")
}

// Moving installed programs to newer versions is the one verb that does
// that. Converging installs what's MISSING and never touches a version
// that's already there (contract 15); this is the separate, explicit ask.
//
// Upgrades are always WHOLE-MECHANISM: `dnf upgrade -y`, not `dnf upgrade
// -y code`. Partial upgrades are unsupported on Arch, discouraged on
// Fedora, and pointless everywhere else — the package manager resolves its
// own transaction, so asking for one package moves whatever that implies
// anyway. Picking a program in the UI means "upgrade the mechanism it came
// from".
//
// A planner only: it decides WHAT runs and refuses
// what mustn't. `loadout upgrade` runs the steps on the terminal (sudo may
// prompt there); the home screen plans with it too, to describe each step
// and refuse before handing off. Verification is not here either:
// re-observe everything the way `status` does and diff the versions.

// UpgradableInstallers is the installers this machine's mapping uses that
// can upgrade themselves, each with its programs, sorted.
func UpgradableInstallers(manifest model.Manifest, machine string) model.Map[[]string] {
	config, _ := manifest.Machines.Get(machine)
	var byInstaller model.Map[[]string]
	for program, key := range config.PM.All() {
		mechanism := manifest.ResolveInstall(program, key).UpgradeWith
		if mechanism == nil {
			continue
		}
		byInstaller.Set(mechanism.Installer, append(byInstaller.Value(mechanism.Installer), program))
	}
	return model.MapValues(byInstaller, func(_ string, programs []string) []string {
		return slices.Sorted(slices.Values(programs))
	})
}

func cannotUpgrade(errors ...string) *UpgradeException {
	return &UpgradeException{"cannot upgrade:\n" + bullets(errors)}
}

// PlanSourceItems is one step per item of a custom `outdated.<name>`
// source. Unlike a package mechanism, these update one at a time: each row
// is a pin in a file or a clone of its own, so nothing is shared and one
// failure doesn't take the rest with it.
func PlanSourceItems(manifest model.Manifest, source string, items []string) ([]UpgradeStep, error) {
	declared, ok := manifest.Outdated.Get(source)
	if !ok || declared.Upgrade == nil {
		return nil, cannotUpgrade("outdated source '" + source + "' declares no upgrade command")
	}
	var steps []UpgradeStep
	for _, item := range items {
		command := strings.ReplaceAll(model.ExpandFilePrefix(*declared.Upgrade), "{item}", item)
		steps = append(steps, UpgradeStep{
			Installers: []string{source},
			Command:    command,
			Covers:     []string{item},
			Origin:     declared.Origin,
			Sudo:       declared.Sudo || CommandNeedsSudo(command),
		})
	}
	return steps, nil
}

// PlanProgramUpgrades is one step per program that declares its own
// `upgrade` (its `outdated` block), run once for that program alone, like
// one custom-source item. A program this machine doesn't map is refused, as
// an installer is.
func PlanProgramUpgrades(manifest model.Manifest, machine string, programs []string) ([]UpgradeStep, error) {
	config, _ := manifest.Machines.Get(machine)
	var steps []UpgradeStep
	for _, name := range model.Distinct(programs) {
		program, _ := manifest.Programs.Get(name)
		if program.Outdated == nil || program.Outdated.Upgrade == nil {
			return nil, cannotUpgrade("'" + name + "' declares no upgrade command")
		}
		command := *program.Outdated.Upgrade
		if !config.PM.Has(name) {
			return nil, cannotUpgrade("'" + name + "' is not used by machine '" + machine + "'")
		}
		steps = append(steps, UpgradeStep{
			Installers: []string{name},
			Command:    model.ExpandFilePrefix(command),
			Covers:     []string{name},
			Origin:     program.Origin,
			Program:    true,
			Sudo:       CommandNeedsSudo(command),
		})
	}
	return steps, nil
}

// PlanUpgrade is one step per named installer;
// unknown or non-upgrading ones are errors.
func PlanUpgrade(manifest model.Manifest, machine string, installers []string) ([]UpgradeStep, error) {
	available := UpgradableInstallers(manifest, machine)
	type located struct{ command, origin string }
	var errors []string
	var order []located
	mechanisms := map[located][]string{}
	for _, name := range model.Distinct(installers) {
		installer, declared := manifest.Installers.Get(name)
		if !available.Has(name) || installer.Upgrade == nil {
			switch {
			case declared && installer.Upgrade != nil:
				// Refusing this is the safety property: loadout only upgrades
				// mechanisms THIS machine's loadout uses, so a repo that maps
				// nothing to brew can never run it.
				errors = append(errors, "installer '"+name+"' is not used by machine '"+machine+"' — nothing here installs through it")
			case declared:
				errors = append(errors, "installer '"+name+"' declares no upgrade command")
			case manifest.Programs.Has(name):
				errors = append(errors, "'"+name+"' is a program — upgrades are whole-mechanism, so name its "+
					"installer instead (see `loadout explain "+name+"`)")
			default:
				errors = append(errors, "unknown installer '"+name+"'")
			}
			continue
		}
		command := *installer.Upgrade
		// Only a repo script depends on where it runs: the same plain
		// command from two files is still one transaction.
		origin := ""
		if model.ExpandFilePrefix(command) != command {
			origin = installer.Origin
		}
		at := located{model.ShellLine(command, manifest.ToolPathOf(name)), origin}
		if _, seen := mechanisms[at]; !seen {
			order = append(order, at)
		}
		mechanisms[at] = append(mechanisms[at], name)
	}
	if len(errors) > 0 {
		return nil, cannotUpgrade(errors...)
	}
	// Same command (from the same directory, for a repo script) = same
	// transaction: run it once, name every mechanism it covers.
	var steps []UpgradeStep
	for _, at := range order {
		names := mechanisms[at]
		var covers, probes []string
		sudo := CommandNeedsSudo(at.command)
		for _, n := range names {
			covers = append(covers, available.Value(n)...)
			installer := manifest.Installers.Value(n)
			probes = append(probes, deref(installer.Probe)+"\x00"+boolKey(installer.Probe != nil))
			sudo = sudo || installer.Sudo
		}
		covers = model.Distinct(covers)
		slices.Sort(covers)
		var tool *string
		if probes = model.Distinct(probes); len(probes) == 1 {
			if p := manifest.Installers.Value(names[0]).Probe; p != nil {
				tool = p
			}
		}
		steps = append(steps, UpgradeStep{
			Installers: names,
			Command:    at.command,
			Covers:     covers,
			Sweep:      true,
			Tool:       tool,
			Origin:     at.origin,
			Sudo:       sudo,
		})
	}
	return steps, nil
}

func boolKey(b bool) string {
	if b {
		return "1"
	}
	return "0"
}
