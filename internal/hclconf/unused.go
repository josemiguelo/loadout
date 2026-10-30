package hclconf

import (
	"fmt"
	"slices"
	"strings"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/model"
)

// UnusedWarnings is what no machine uses, for `loadout compile` to warn
// about: a program no machine installs, a script none runs (or a variant
// none picks), a profile none extends, a repo installer that installs
// nothing in use. A way to install a program that no machine picks is
// reported only when some machine uses that installer for other programs (a
// profile that installs everything via dnf but this one): a true claim about
// an installer nobody uses (a scaffold's ripgrep via apt, a COPR kept for a
// future Fedora machine) is what install_via is for. Declaring something and
// forgetting to use it is otherwise silent. A profile marked spare keeps what
// it uses from being reported, and a spare mark on something that is used is
// reported too, so the marks stay true.
//
// inherited is a child repo's parent's declarations (assemble.DeclaredNames):
// their use is the parent's compile's business. Sorted.
func UnusedWarnings(draft assemble.ManifestDraft, manifest model.Manifest, spares model.Map[string], inherited []string) []string {
	profiles := draft.Profiles

	// Profiles some machine reaches, through extends chains.
	reached := map[string]bool{}
	var reach func(names []string)
	reach = func(names []string) {
		for _, name := range names {
			if reached[name] {
				continue
			}
			reached[name] = true
			if p, ok := profiles.Get(name); ok {
				reach(p.Extends)
			}
		}
	}
	for machine := range draft.Manifest.Machines.Values() {
		reach(machine.Extends)
	}

	// Everything a spare profile (and what it extends) says counts as used.
	var closure func(name string, seen map[string]bool) []model.MachineConfig
	closure = func(name string, seen map[string]bool) []model.MachineConfig {
		if seen[name] {
			return nil
		}
		seen[name] = true
		config, ok := profiles.Get(name)
		if !ok {
			return nil
		}
		out := []model.MachineConfig{config}
		for _, e := range config.Extends {
			out = append(out, closure(e, seen)...)
		}
		return out
	}
	type user struct {
		who    string
		config model.MachineConfig
	}
	var users []user
	for name, config := range manifest.Machines.All() {
		users = append(users, user{"machine '" + name + "'", config})
	}
	for _, name := range profiles.Keys() {
		if !spares.Has("profile '" + name + "'") {
			continue
		}
		for _, config := range closure(name, map[string]bool{}) {
			users = append(users, user{"profile '" + name + "'", config})
		}
	}

	// Programs in use, with the variant each user picks; dependencies too.
	picks := map[string]map[string]bool{}          // program -> variants picked
	usedPrograms := map[string]string{}            // program -> who installs it
	installerUsers := map[string]map[string]bool{} // installer -> who installs through it
	installerOf := func(program, key string) (string, bool) {
		p, ok := manifest.Programs.Get(program)
		if !ok {
			return "", false
		}
		v, ok := p.Install.Get(key)
		if !ok {
			return "", false
		}
		if v.Installer != nil {
			return *v.Installer, true
		}
		return key, true
	}
	addTo := func(m map[string]map[string]bool, key, value string) {
		if m[key] == nil {
			m[key] = map[string]bool{}
		}
		m[key][value] = true
	}
	for _, u := range users {
		seen := map[string]bool{}
		pending := u.config.PM.Keys()
		for len(pending) > 0 {
			program := pending[0]
			pending = pending[1:]
			if seen[program] {
				continue
			}
			seen[program] = true
			if _, ok := usedPrograms[program]; !ok {
				usedPrograms[program] = u.who
			}
			var key *string
			if k, ok := u.config.PM.Get(program); ok {
				key = &k
				addTo(picks, program, k)
				if installer, ok := installerOf(program, k); ok {
					addTo(installerUsers, installer, u.who)
				}
			}
			pending = append(pending, manifest.DependenciesOf(program, key)...)
		}
	}
	usedScripts := map[string]string{}
	scriptPicks := map[string]map[string]bool{}
	for _, u := range users {
		for _, entry := range u.config.Scripts {
			name, _ := model.ScriptEntry(entry)
			if _, ok := usedScripts[name]; !ok {
				usedScripts[name] = u.who
			}
		}
		for script, variant := range u.config.ScriptVariants.All() {
			addTo(scriptPicks, script, variant)
		}
	}

	var warnings []string
	isInherited := func(key string) bool {
		for _, it := range inherited {
			if key == it || strings.HasPrefix(key, it+" ") {
				return true
			}
		}
		return false
	}
	unused := func(key, message string) {
		if !spares.Has(key) && !isInherited(key) {
			warnings = append(warnings, message+` — if it's kept on purpose, mark it spare = "…"`)
		}
	}
	staleSpare := func(key, by string) {
		if spares.Has(key) && !isInherited(key) {
			warnings = append(warnings, key+" is marked spare, but "+by+" uses it")
		}
	}

	for _, name := range profiles.Keys() {
		if reached[name] {
			staleSpare("profile '"+name+"'", "a machine")
		} else {
			unused("profile '"+name+"'", "profile '"+name+"' isn't extended by any machine")
		}
	}
	for name, program := range manifest.Programs.All() {
		who, ok := usedPrograms[name]
		if !ok {
			unused("program '"+name+"'", "program '"+name+"' isn't installed on any machine")
			continue
		}
		staleSpare("program '"+name+"'", who)
		if program.Install.Len() <= 1 {
			continue
		}
		for _, key := range program.Install.Keys() {
			spareKey := "program '" + name + "' via '" + key + "'"
			if picks[name][key] {
				staleSpare(spareKey, "a machine")
				continue
			}
			var others []string
			if installer, ok := installerOf(name, key); ok {
				for who := range installerUsers[installer] {
					others = append(others, who)
				}
			}
			if len(others) == 0 {
				continue
			}
			slices.Sort(others)
			more := ""
			if len(others) > 1 {
				more = fmt.Sprintf(" (and %d more)", len(others)-1)
			}
			unused(spareKey, "program '"+name+"': "+others[0]+more+" installs other programs via '"+key+"', but not "+name)
		}
	}
	for name, script := range manifest.Scripts.All() {
		who, ok := usedScripts[name]
		if !ok {
			unused("script '"+name+"'", "script '"+name+"' isn't run on any machine")
			continue
		}
		staleSpare("script '"+name+"'", who)
		for _, variant := range script.Variants.Keys() {
			spareKey := "script '" + name + "' as '" + variant + "'"
			if scriptPicks[name][variant] {
				staleSpare(spareKey, "a machine")
			} else {
				unused(spareKey, "script '"+name+"': no machine runs it as '"+variant+"'")
			}
		}
	}
	for _, name := range manifest.Installers.Keys() {
		if slices.Contains(manifest.BuiltinInstallers, name) {
			continue
		}
		if installerUsers[name] != nil {
			staleSpare("installer '"+name+"'", "a program a machine installs")
		} else {
			unused("installer '"+name+"'", "installer '"+name+"' installs nothing a machine uses")
		}
	}
	slices.Sort(warnings)
	return warnings
}

// TransitionalWarnings is the transitional scripts every machine that runs
// them reports done, for `loadout compile` to say they can be deleted. done
// is each machine's scripts whose state says done; a machine without a state
// file has done nothing. A script no machine runs is left to UnusedWarnings.
func TransitionalWarnings(manifest model.Manifest, transitional []string, done map[string]map[string]bool) []string {
	names := slices.Sorted(slices.Values(model.Distinct(transitional)))
	var out []string
	for _, name := range names {
		var runners []string
		for machine, config := range manifest.Machines.All() {
			for _, entry := range config.Scripts {
				if n, _ := model.ScriptEntry(entry); n == name {
					runners = append(runners, machine)
					break
				}
			}
		}
		slices.Sort(runners)
		if len(runners) == 0 {
			continue
		}
		all := true
		for _, r := range runners {
			all = all && done[r][name]
		}
		if all {
			out = append(out, "script '"+name+"' is done on every machine that runs it ("+strings.Join(runners, ", ")+"): it's transitional, so delete it")
		}
	}
	return out
}
