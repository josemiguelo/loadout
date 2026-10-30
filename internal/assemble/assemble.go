// Package assemble turns what a config repo declares into the Manifest the
// lock holds: built-ins merged, profiles flattened, everything validated.
package assemble

import (
	"io/fs"
	"path"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"github.com/josemiguelo/loadout/internal/model"
)

// ManifestDraft is what a config repo declares, before it becomes a
// model.Manifest: the repo's own installers (built-ins not merged yet), and
// machines and profiles unflattened. The HCL front end fills one; Assemble
// turns it into what the lock holds.
//
// In Manifest, machines and profiles carry their own settings only (their
// Extends unresolved) and a Label for messages (`machine 'm'`, `profile
// 'p'`); every Origin is the declaring file's folder (model.ParentOrigin for
// a parent's declarations). Map order is declaration order: it decides the
// order of errors and of the lock's unsorted maps (a program's variants).
type ManifestDraft struct {
	Manifest model.Manifest
	// Profiles are the declared profiles, keyed by name.
	Profiles model.Map[model.MachineConfig]
	// Requires is the programs each installer requires, built-ins included: a
	// repo adds a requirement to `dnf` without redefining it, so these apply
	// after the built-ins are merged.
	Requires model.Map[[]string]
}

// Assemble turns draft into a validated model.Manifest: the built-in
// installers merged under the repo's, profiles flattened into machines
// (contract 2), everything checked, and `file:` paths checked against repo
// (rooted at the repo root) and parent (the parent's checkout, nil for a repo
// without one). Shared by compile (which writes the lock) and the binary
// (which re-checks files when it reads one), so both say the same thing.
// Its refusal is a *model.ManifestException.
func Assemble(draft ManifestDraft, repo, parent fs.FS) (model.Manifest, error) {
	return assemble(draft, &files{repo, parent})
}

// AssembleWithoutFiles is Assemble without the `file:` checks. TEST-ONLY:
// everything else — built-ins, flattening, validation — behaves exactly as
// in production.
func AssembleWithoutFiles(draft ManifestDraft) (model.Manifest, error) {
	return assemble(draft, nil)
}

type files struct{ repo, parent fs.FS }

func assemble(draft ManifestDraft, repo *files) (model.Manifest, error) {
	var errors []string
	manifest := withBuiltinInstallers(draft.Manifest)
	manifest.Installers = model.MapValues(manifest.Installers, func(name string, installer model.Installer) model.Installer {
		if extra, ok := draft.Requires.Get(name); ok {
			installer.Requires = model.Distinct(append(slices.Clone(installer.Requires), extra...))
		}
		return installer
	})
	for name := range draft.Requires.All() {
		if !manifest.Installers.Has(name) {
			errors = append(errors, "requires on unknown installer '"+name+"'")
		}
	}
	if strings.TrimFunc(manifest.Layout.State, unicode.IsSpace) == "" {
		errors = append(errors, "layout state is missing (a directory)")
	}
	var dirs []string
	if strings.TrimFunc(manifest.Layout.State, unicode.IsSpace) != "" {
		dirs = append(dirs, manifest.Layout.State)
	}
	if manifest.Layout.Configs != nil {
		dirs = append(dirs, *manifest.Layout.Configs)
	}
	for _, dir := range dirs {
		if model.GlobHasWildcard(dir) {
			errors = append(errors, "layout '"+dir+"' is a directory, not a glob")
		}
		if problem := model.GlobProblem(dir); problem != "" {
			errors = append(errors, "layout '"+dir+"' "+problem)
		}
	}
	for name, config := range draft.Profiles.Plus(manifest.Machines).All() {
		label := config.Label
		if label == "" {
			label = name
		}
		errors = append(errors, model.ValidateData(manifest.Data, config.Data, label, "")...)
	}
	var machines model.Map[model.MachineConfig]
	errors = append(errors, flatten(manifest.Machines, draft.Profiles, &machines)...)
	if len(errors) > 0 {
		return model.Manifest{}, invalid(errors)
	}

	flat := manifest
	flat.Machines = model.MapValues(machines, func(_ string, config model.MachineConfig) model.MachineConfig {
		config.Data = model.MergeData(manifest.Data, config.Data)
		return config
	})
	if err := validate(flat); err != nil {
		return model.Manifest{}, err
	}
	if repo != nil {
		if missing := CheckFiles(flat, repo.repo, repo.parent); len(missing) > 0 {
			return model.Manifest{}, invalid(missing)
		}
	}
	return sorted(withFileValues(flat)), nil
}

// CheckFiles is the problems with every `file:` path the manifest names,
// against repo (and parent, for a parent's declarations; nil skips them):
// each is relative to its declaring file's directory and must exist without
// leaving the repo.
func CheckFiles(manifest model.Manifest, repo, parent fs.FS) []string {
	var problems []string
	requirePath := func(file, origin, label string) {
		// A parent's declaration resolves in the parent's checkout.
		root := repo
		where := "the repo"
		if model.IsParentOrigin(origin) {
			if parent == nil {
				return
			}
			root = parent
			where = "the parent's"
		}
		folder := model.OriginFolder(origin)
		if folder == "" {
			where += " root"
		} else {
			where = origin + "/"
		}
		joined := file
		if folder != "" {
			joined = folder + "/" + file
		}
		relative := normalized(joined)
		switch {
		case path.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, "../"):
			problems = append(problems, label+": file '"+file+"' leaves the repo (paths are relative to "+where+")")
		case !exists(root, relative):
			problems = append(problems, label+": file '"+file+"' not found (relative to "+where+")")
		}
	}
	requireFile := func(command *string, origin, label string) {
		if command == nil || !strings.HasPrefix(*command, model.InstallFilePrefix) {
			return
		}
		// Anything after the first space is arguments, not path.
		p, _, _ := strings.Cut(strings.TrimPrefix(*command, model.InstallFilePrefix), " ")
		requirePath(p, origin, label)
	}
	for name, script := range manifest.Scripts.All() {
		steps := []struct {
			label string
			step  model.ScriptStep
		}{{"", script}}
		for key, v := range script.Variants.All() {
			steps = append(steps, struct {
				label string
				step  model.ScriptStep
			}{"." + key, v})
		}
		for _, s := range steps {
			if s.step.File != nil {
				requirePath(*s.step.File, s.step.Origin, "scripts."+name+s.label)
			}
			requireFile(s.step.Check, s.step.Origin, "scripts."+name+s.label+".check")
		}
	}
	for name, source := range manifest.Outdated.All() {
		requireFile(source.Command, source.Origin, "outdated."+name)
		requireFile(source.Upgrade, source.Origin, "outdated."+name+".upgrade")
	}
	for name, program := range manifest.Programs.All() {
		if program.Version != nil {
			requireFile(&program.Version.Command, program.Version.Origin, "programs."+name+".version")
		}
		if own := program.Outdated; own != nil {
			requireFile(&own.Command, program.Origin, "programs."+name+".outdated")
			requireFile(own.Upgrade, program.Origin, "programs."+name+".outdated upgrade")
		}
		for key := range program.Install.All() {
			resolved := manifest.ResolveInstall(name, key)
			at := "programs." + name + ".install." + key
			requireFile(resolved.Command, resolved.CommandOrigin, at)
			// The version fallback is already checked once above.
			if c := resolved.Check; c != nil && !c.Equal(program.Version) {
				requireFile(&c.Command, c.Origin, at+" check")
			}
			if o := resolved.Outdated; o != nil {
				requireFile(&o.Command, o.Origin, at+" outdated")
			}
			if b := resolved.OutdatedAll; b != nil {
				requireFile(&b.Command, b.Origin, at+" outdated-all")
			}
			if u := resolved.UpgradeWith; u != nil {
				requireFile(&u.Command, u.Origin, at+" upgrade")
			}
		}
		for key, variant := range program.Install.All() {
			for param, value := range variant.With.All() {
				label := "programs." + name + ".install." + key + ".with." + param
				switch {
				case strings.HasPrefix(value, model.InstallFilePrefix):
					requirePath(strings.TrimPrefix(value, model.InstallFilePrefix), program.Origin, label)
				// In a lock it's already a repo path (see withFileValues).
				case strings.HasPrefix(value, repoPath):
					requirePath(strings.TrimPrefix(value, repoPath), "", label)
				case strings.HasPrefix(value, parentPath):
					requirePath(strings.TrimPrefix(value, parentPath), model.ParentOrigin(""), label)
				}
			}
		}
	}
	return problems
}

// normalized is p cleaned as okio's normalized() does: "" stays "".
func normalized(p string) string {
	if p == "" {
		return ""
	}
	return path.Clean(p)
}

// exists says whether p (repo-relative, normalized) is there; a symlink
// counts, even a dangling one.
func exists(root fs.FS, p string) bool {
	if p == "" {
		p = "."
	}
	_, err := fs.Lstat(root, p)
	return err == nil
}

// InstallOrder is programs in dependency order (dependencies before
// dependents), each program's edges being those of the variant mapping
// picks for it (model.Manifest.DependenciesOf). Ties break by name. names
// nil means every program. Assumes validation passed, i.e. the graph is
// acyclic.
func InstallOrder(manifest model.Manifest, names []string, mapping model.Map[string]) []string {
	if names == nil {
		names = manifest.Programs.Keys()
	}
	var result []string
	seen := map[string]bool{}
	var visit func(string)
	visit = func(name string) {
		if seen[name] || !manifest.Programs.Has(name) {
			return
		}
		seen[name] = true
		var key *string
		if k, ok := mapping.Get(name); ok {
			key = &k
		}
		deps := manifest.DependenciesOf(name, key)
		slices.Sort(deps)
		for _, d := range deps {
			visit(d)
		}
		result = append(result, name)
	}
	ordered := slices.Clone(names)
	slices.Sort(ordered)
	for _, n := range ordered {
		visit(n)
	}
	return result
}

// ScriptOrder is scripts ordered so that a script listed in another's
// `after` runs first, ties by name. names nil means every script. Only
// script-to-script edges affect this order; `programs.*` references are
// satisfied by installs always running before scripts.
func ScriptOrder(manifest model.Manifest, names []string) []string {
	if names == nil {
		names = manifest.Scripts.Keys()
	}
	var result []string
	seen := map[string]bool{}
	var visit func(string)
	visit = func(name string) {
		if seen[name] || !manifest.Scripts.Has(name) {
			return
		}
		seen[name] = true
		var after []string
		for _, ref := range manifest.Scripts.Value(name).After {
			if s, ok := strings.CutPrefix(ref, "scripts."); ok {
				after = append(after, s)
			}
		}
		slices.Sort(after)
		for _, a := range after {
			visit(a)
		}
		result = append(result, name)
	}
	ordered := slices.Clone(names)
	slices.Sort(ordered)
	for _, n := range ordered {
		visit(n)
	}
	return result
}

// repoPath is how a `file:` `with` value reads once assembled: a path under the repo.
const repoPath = "$LOADOUT_REPO/"

// parentPath is a parent's file in a child's lock: under `LOADOUT_PARENT`,
// which every command of a child repo sees, so it resolves whichever repo's
// installer (a built-in's runs in the child) the value is substituted into.
const parentPath = "$LOADOUT_PARENT/"

// Invalid is the refusal listing errors: "Invalid manifest:" and one
// indented line each.
func Invalid(errors []string) *model.ManifestException { return invalid(errors) }

func invalid(errors []string) *model.ManifestException {
	var b strings.Builder
	b.WriteString("Invalid manifest:")
	for _, e := range errors {
		b.WriteString("\n  - ")
		b.WriteString(e)
	}
	return model.NewManifestException(b.String())
}

// withBuiltinInstallers merges loadout's shipped installers UNDER the
// manifest's own: a repo definition of the same name replaces the built-in,
// and what survived is recorded for `explain`/`installers`. The one place
// this happens.
func withBuiltinInstallers(manifest model.Manifest) model.Manifest {
	builtins := model.InstallerLibrary()
	var survived []string
	for name := range builtins.All() {
		if !manifest.Installers.Has(name) {
			survived = append(survived, name)
		}
	}
	manifest.Installers = builtins.Plus(manifest.Installers)
	manifest.BuiltinInstallers = survived
	return manifest
}

// withFileValues makes a `with` value marked `file:` — a path relative to
// the program's file, like every other path — "$LOADOUT_REPO/<path>", since
// it's substituted into an installer pattern that runs elsewhere.
func withFileValues(manifest model.Manifest) model.Manifest {
	manifest.Programs = model.MapValues(manifest.Programs, func(_ string, program model.Program) model.Program {
		program.Install = model.MapValues(program.Install, func(_ string, variant model.InstallVariant) model.InstallVariant {
			variant.With = model.MapValues(variant.With, func(_ string, value string) string {
				file, ok := strings.CutPrefix(value, model.InstallFilePrefix)
				if !ok {
					return value
				}
				folder := model.OriginFolder(program.Origin)
				joined := file
				if folder != "" {
					joined = folder + "/" + file
				}
				if model.IsParentOrigin(program.Origin) {
					return parentPath + normalized(joined)
				}
				return repoPath + normalized(joined)
			})
			return variant
		})
		return program
	})
	return manifest
}

// sorted puts every map in name order, so the lock reads (and diffs) the
// same however it was declared; and makes it exactly what a read of the
// lock gives back (labels are for messages, and don't travel).
func sorted(manifest model.Manifest) model.Manifest {
	manifest.Installers = manifest.Installers.Sorted()
	manifest.Programs = manifest.Programs.Sorted()
	manifest.Scripts = manifest.Scripts.Sorted()
	manifest.Machines = model.MapValues(manifest.Machines.Sorted(), func(_ string, machine model.MachineConfig) model.MachineConfig {
		machine.PM = machine.PM.Sorted()
		machine.ScriptVariants = machine.ScriptVariants.Sorted()
		machine.Label = ""
		return machine
	})
	manifest.Outdated = manifest.Outdated.Sorted()
	manifest.BuiltinInstallers = slices.Clone(manifest.BuiltinInstallers)
	slices.Sort(manifest.BuiltinInstallers)
	return manifest
}

type pick struct{ value, profile string }

// flatten resolves `extends` lists into out: every machine becomes its
// flattened self, downstream nothing knows profiles existed. A machine's
// profiles are combined first — two of them setting a program's variant, a
// script's arguments or variant, or a data key differently is an error, so
// their order never changes the result — then the machine itself overrides
// them (PM per key, scripts by name, data table by table, lists replace).
// Profiles are validated through the machines extending them, and each one
// alone too. Returns errors.
func flatten(machineConfigs, profiles model.Map[model.MachineConfig], out *model.Map[model.MachineConfig]) []string {
	var errors []string
	flatProfiles := map[string]model.MachineConfig{}

	var flat func(config model.MachineConfig, seen []string) model.MachineConfig
	flat = func(config model.MachineConfig, seen []string) model.MachineConfig {
		type parent struct {
			name   string
			config model.MachineConfig
		}
		var parents []parent
		for _, name := range config.Extends {
			profile, ok := profiles.Get(name)
			switch {
			case !ok:
				errors = append(errors, config.Label+": extends unknown profile '"+name+"'")
			case slices.Contains(seen, name):
				errors = append(errors, "profile cycle: "+strings.Join(append(slices.Clone(seen), name), " -> "))
			default:
				p, cached := flatProfiles[name]
				if !cached {
					p = flat(profile, append(slices.Clone(seen), name))
					flatProfiles[name] = p
				}
				parents = append(parents, parent{name, p})
			}
		}
		var pm, scripts, variants model.Map[pick] // program -> (variant, profile), script -> (entry, profile), script -> (variant, profile)
		data := model.JSONObject{}
		for index, p := range parents {
			for program, variant := range p.config.PM.All() {
				previous, ok := pm.Get(program)
				switch {
				case !ok:
					pm.Set(program, pick{variant, p.name})
				case previous.value != variant:
					errors = append(errors, config.Label+": profiles '"+previous.profile+"' and '"+p.name+"' map '"+
						program+"' differently ('"+previous.value+"' vs '"+variant+"')")
				}
			}
			for _, entry := range p.config.Scripts {
				script, args := model.ScriptEntry(entry)
				previous, ok := scripts.Get(script)
				if !ok {
					scripts.Set(script, pick{entry, p.name})
				} else if _, previousArgs := model.ScriptEntry(previous.value); previousArgs != args {
					errors = append(errors, config.Label+": profiles '"+previous.profile+"' and '"+p.name+"' run '"+
						script+"' with different arguments")
				}
			}
			for script, variant := range p.config.ScriptVariants.All() {
				previous, ok := variants.Get(script)
				switch {
				case !ok:
					variants.Set(script, pick{variant, p.name})
				case previous.value != variant:
					errors = append(errors, config.Label+": profiles '"+previous.profile+"' and '"+p.name+"' run '"+
						script+"' as different variants ('"+previous.value+"' vs '"+variant+"')")
				}
			}
			for _, earlier := range parents[:index] {
				for _, key := range model.DataConflicts(earlier.config.Data, p.config.Data, "") {
					errors = append(errors, config.Label+": profiles '"+earlier.name+"' and '"+p.name+"' set data key '"+
						key+"' differently")
				}
			}
			data = model.MergeData(data, p.config.Data)
		}
		own := config.ScriptArgs()
		result := config
		result.PM = model.MapValues(pm, func(_ string, v pick) string { return v.value }).Plus(config.PM)
		result.Scripts = nil
		for entry := range scripts.Values() {
			if name, _ := model.ScriptEntry(entry.value); !own.Has(name) {
				result.Scripts = append(result.Scripts, entry.value)
			}
		}
		result.Scripts = append(result.Scripts, config.Scripts...)
		var inherited model.Map[string]
		for script, v := range variants.All() {
			if !own.Has(script) {
				inherited.Set(script, v.value)
			}
		}
		result.ScriptVariants = inherited.Plus(config.ScriptVariants)
		result.Data = model.MergeData(data, config.Data)
		return result
	}

	for name, profile := range profiles.All() {
		if _, ok := flatProfiles[name]; !ok {
			flatProfiles[name] = flat(profile, []string{name})
		}
	}
	for name, machine := range machineConfigs.All() {
		out.Set(name, flat(machine, nil))
	}
	return errors
}

var dottedVersion = regexp.MustCompile(`^\d+(\.\d+)*$`)

func validate(manifest model.Manifest) error {
	var errors []string
	add := func(e string) { errors = append(errors, e) }

	if v := manifest.Meta.MinToolVersion; v != nil && !dottedVersion.MatchString(*v) {
		add("meta min-tool-version '" + *v + "' is not a dotted version number (e.g. \"0.2.0\")")
	}

	for name, installer := range manifest.Installers.All() {
		if installer.Check != nil && installer.Regex == nil {
			add("installers." + name + " has a check but no regex")
		}
		if installer.Outdated != nil && installer.Regex == nil {
			add("installers." + name + " has an outdated command but no regex")
		}
		if installer.OutdatedAll != nil && installer.Regex == nil {
			add("installers." + name + " has an outdated-all command but no regex")
		}
		if slices.Contains(installer.Params, "pkg") {
			add("installers." + name + " declares param 'pkg', which is always available")
		}
		for _, required := range installer.Requires {
			if !manifest.Programs.Has(required) {
				add("installers." + name + " requires unknown program '" + required + "'")
			}
		}
	}

	for name, source := range manifest.Outdated.All() {
		if source.Command == nil || isBlank(*source.Command) {
			add("outdated." + name + " needs a command (prints '<item> <current> <candidate>' lines)")
		}
	}

	for name, program := range manifest.Programs.All() {
		if own := program.Outdated; own != nil {
			if isBlank(own.Command) {
				add("programs." + name + ".outdated needs a command (prints the newest version)")
			}
			if program.Version == nil || program.Version.Regex == nil {
				add("programs." + name + ".outdated needs a version with a regex: the newest version is " +
					"read with the program's version regex")
			}
		}
		for _, dep := range program.DependsOn {
			if !manifest.Programs.Has(dep) {
				add("programs." + name + " depends-on unknown program '" + dep + "'")
			}
		}
		for key, variant := range program.Install.All() {
			at := "programs." + name + ".install." + key
			for _, provided := range variant.Provides {
				if isBlank(provided.Binary) || strings.IndexFunc(provided.Binary, func(r rune) bool { return unicode.IsSpace(r) || r == '/' }) >= 0 {
					add(at + " provides '" + provided.Binary + "': name a binary, not a path " +
						"(where it lands goes in `at`)")
				}
				if provided.At != nil && (isBlank(*provided.At) || strings.Contains(*provided.At, ":")) {
					add(at + " provides '" + provided.Binary + "' at '" + *provided.At + "': " +
						"one folder, no ':'")
				}
			}
			for _, dep := range variant.DependsOn {
				if !manifest.Programs.Has(dep) {
					add(at + " depends-on unknown program '" + dep + "'")
				}
			}
			if variant.Installer != nil && !manifest.Installers.Has(*variant.Installer) {
				add(at + " references unknown installer '" + *variant.Installer + "'")
				continue
			}
			installerName := key
			if variant.Installer != nil {
				installerName = *variant.Installer
			}
			installer, hasInstaller := manifest.Installers.Get(installerName)
			if variant.Command == nil && (!hasInstaller || installer.Install == nil) {
				add(at + " resolves to no install command " +
					"(set a command, or use an installer with an install pattern)")
			}
			check := variant.Check
			if check == nil && hasInstaller {
				check = installer.Check
			}
			regex := variant.Regex
			if regex == nil && hasInstaller {
				regex = installer.Regex
			}
			if variant.Present && variant.Regex != nil {
				add(at + " is a yes/no check and also sets a regex")
			}
			if variant.Present && check == nil {
				add(at + " is a yes/no check with no check command")
			}
			if !variant.Present && variant.Check != nil && regex == nil {
				add(at + " has a check but no regex " +
					"(give it one, or make it a yes/no check)")
			}
			if variant.Outdated != nil && regex == nil {
				add(at + " has an outdated command but no regex")
			}
			// Params are a contract between installer and variant: every
			// declared one must be supplied, and nothing else may be.
			var params []string
			if hasInstaller {
				params = installer.Params
			}
			for _, missing := range params {
				if !variant.With.Has(missing) {
					add(at + " needs a value for '" + missing + "'")
				}
			}
			for extra := range variant.With.All() {
				if slices.Contains(params, extra) {
					continue
				}
				if !hasInstaller {
					add(at + " sets '" + extra + "' but resolves to no installer")
				} else {
					add(at + " sets '" + extra + "', which installer '" + installerName + "' does not declare in params")
				}
			}
		}
	}

	for name, script := range manifest.Scripts.All() {
		type way struct {
			label string
			step  model.ScriptStep
		}
		ways := []way{{"scripts." + name, script}}
		if !script.Variants.IsEmpty() {
			if script.File != nil || script.Run != nil {
				add("scripts." + name + " has variants, so its file or command belongs in each variant")
			}
			ways = nil
			for key, variant := range script.Variants.All() {
				ways = append(ways, way{"scripts." + name + "." + key, variant})
			}
		}
		for _, w := range ways {
			if (w.step.File == nil) == (w.step.Run == nil) {
				add(w.label + " must define exactly one of a file or an inline command")
			}
			for _, ref := range w.step.After {
				valid := false
				if p, ok := strings.CutPrefix(ref, "programs."); ok {
					valid = manifest.Programs.Has(p)
				} else if s, ok := strings.CutPrefix(ref, "scripts."); ok {
					valid = manifest.Scripts.Has(s)
				}
				if !valid {
					add(w.label + " after references unknown step '" + ref + "'")
				}
			}
		}
		modes := script.ModeList()
		if len(modes) == 0 {
			add("scripts." + name + " has an empty modes list (it could never run; omit modes for both surfaces)")
		}
		for _, mode := range modes {
			if mode != "setup" && mode != "maintain" {
				add("scripts." + name + " has unknown mode '" + mode + "' (valid: setup, maintain)")
			}
		}
	}

	for machine, config := range manifest.Machines.All() {
		label := config.Label
		if label == "" {
			label = "machine '" + machine + "'"
		}
		counts := map[string]int{}
		var order []string
		for _, entry := range config.Scripts {
			n, _ := model.ScriptEntry(entry)
			if counts[n] == 0 {
				order = append(order, n)
			}
			counts[n]++
		}
		for _, n := range order {
			if counts[n] > 1 {
				add(label + " runs script '" + n + "' more than once")
			}
		}
		for scriptName, args := range config.ScriptArgs().All() {
			script, ok := manifest.Scripts.Get(scriptName)
			variant, hasVariant := config.ScriptVariants.Get(scriptName)
			switch {
			case !ok:
				add(label + " runs unknown script '" + scriptName + "'")
			case !script.Variants.IsEmpty() && !hasVariant:
				add(label + " runs '" + scriptName + "' without saying which variant (has: " + sortedKeys(script.Variants) + ")")
			case hasVariant && !script.Variants.Has(variant):
				has := sortedKeys(script.Variants)
				if has == "" {
					has = "none"
				}
				add(label + " runs '" + scriptName + "' as '" + variant + "', which it doesn't have (has: " + has + ")")
			case args != "" && stepFor(script, variant, hasVariant).File == nil:
				add(label + " passes arguments to script '" + scriptName + "', " +
					"which is an inline command — arguments require a file script")
			}
		}
		for programName, installKey := range config.PM.All() {
			program, ok := manifest.Programs.Get(programName)
			if !ok {
				add(label + " installs unknown program '" + programName + "'")
			} else if !program.Install.Has(installKey) {
				add(label + " installs '" + programName + "' via '" + installKey + "', but it can't be installed " +
					"that way (it can via: " + sortedKeys(program.Install) + ")")
			}
		}
	}

	// Every variant's edges count, its installer's requirements too: a
	// cycle that only one machine's mapping would walk is still a cycle.
	programEdges := model.MapValues(manifest.Programs, func(name string, program model.Program) []string {
		var edges []string
		for _, key := range program.Install.Keys() {
			edges = append(edges, manifest.DependenciesOf(name, &key)...)
		}
		edges = append(edges, manifest.DependenciesOf(name, nil)...)
		return model.Distinct(edges)
	})
	if cycle := findCycle(programEdges); cycle != nil {
		add("dependency cycle among programs: " + strings.Join(cycle, " -> "))
	}
	scriptEdges := model.MapValues(manifest.Scripts, func(_ string, s model.ScriptStep) []string {
		refs := slices.Clone(s.After)
		for v := range s.Variants.Values() {
			refs = append(refs, v.After...)
		}
		var edges []string
		for _, ref := range refs {
			if n, ok := strings.CutPrefix(ref, "scripts."); ok {
				edges = append(edges, n)
			}
		}
		return model.Distinct(edges)
	})
	if cycle := findCycle(scriptEdges); cycle != nil {
		add("ordering cycle among scripts: " + strings.Join(cycle, " -> "))
	}

	if len(errors) > 0 {
		return invalid(errors)
	}
	return nil
}

func stepFor(script model.ScriptStep, variant string, hasVariant bool) model.ScriptStep {
	if hasVariant {
		return script.Variant(variant)
	}
	return script
}

func isBlank(s string) bool { return strings.TrimFunc(s, unicode.IsSpace) == "" }

func sortedKeys[V any](m model.Map[V]) string {
	keys := m.Keys()
	slices.Sort(keys)
	return strings.Join(keys, ", ")
}

// findCycle is one cycle as a list of node names, or nil if the graph is acyclic.
func findCycle(edges model.Map[[]string]) []string {
	visiting := map[string]bool{}
	done := map[string]bool{}
	var stack []string

	var visit func(string) []string
	visit = func(node string) []string {
		if done[node] {
			return nil
		}
		if visiting[node] {
			i := slices.Index(stack, node)
			return append(slices.Clone(stack[i:]), node)
		}
		visiting[node] = true
		stack = append(stack, node)
		for _, next := range edges.Value(node) {
			if edges.Has(next) {
				if cycle := visit(next); cycle != nil {
					return cycle
				}
			}
		}
		stack = stack[:len(stack)-1]
		delete(visiting, node)
		done[node] = true
		return nil
	}

	keys := edges.Keys()
	slices.Sort(keys)
	for _, node := range keys {
		if cycle := visit(node); cycle != nil {
			return cycle
		}
	}
	return nil
}
