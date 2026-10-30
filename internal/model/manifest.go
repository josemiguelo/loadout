// Package model is a config repo, resolved: what a manifest compiles to,
// what loadout.lock.json holds, and what every engine reads.
package model

import (
	"fmt"
	"path"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// Manifest is a config repo, resolved. Machines are already flattened
// (profiles merged in, then dropped) and carry their whole data.
type Manifest struct {
	Meta   Meta
	Layout RepoLayout
	// Installers are the install mechanisms (`dnf`, `brew-cask`, ...) defined
	// once per repo. Probe, install/check patterns, and regex are properties
	// of the mechanism; programs reference installers instead of restating them.
	Installers Map[Installer]
	Programs   Map[Program]
	Scripts    Map[ScriptStep]
	// Machines is every machine, keyed by hostname.
	Machines Map[MachineConfig]
	// Outdated holds the custom `loadout outdated` oracles beyond the
	// installer ones — entries whose command prints one `<item> <current>
	// <candidate>` line per outdated item (nothing when current). The entry
	// name becomes the row's source tag. The built-in self-version row is
	// conceptually the first of these, hardcoded.
	Outdated Map[OutdatedSource]
	// BuiltinInstallers says which of Installers came from InstallerLibrary
	// rather than the repo — provenance for `explain`/`installers`, never
	// behavior.
	BuiltinInstallers []string
	// Data is every per-machine data key with its default.
	Data JSONObject
	// ToolPaths is where each binary the machine in view provides lands, for
	// the binaries whose variant says `at` (ForMachine; empty before it). Put
	// first on PATH for every command that goes through that binary. Never
	// written to the lock.
	ToolPaths map[string][]string
}

// ResolveInstall is everything the key variant of program programName
// resolves to. Assumes the manifest validated (program and key exist).
func (m Manifest) ResolveInstall(programName, key string) ResolvedInstall {
	program, ok := m.Programs.Get(programName)
	if !ok {
		panic(fmt.Sprintf("no program %q", programName))
	}
	variant, ok := program.Install.Get(key)
	if !ok {
		panic(fmt.Sprintf("program %q has no variant %q", programName, key))
	}
	// An explicit `installer` reference wins; otherwise a variant whose key
	// names an installer uses it.
	var installer *Installer
	lookup := key
	if variant.Installer != nil {
		lookup = *variant.Installer
	}
	if i, ok := m.Installers.Get(lookup); ok {
		installer = &i
	}
	pkg := programName
	if variant.Pkg != nil {
		pkg = *variant.Pkg
	}
	// {pkg} plus whatever the installer declared as params — validated at
	// compile, so an unsubstituted placeholder can't reach a shell here.
	values := MapOf(E("pkg", pkg)).Plus(variant.With)
	sub := func(s string) string {
		for k, v := range values.All() {
			s = strings.ReplaceAll(s, "{"+k+"}", v)
		}
		return s
	}
	field := func(own *string, of func(*Installer) *string) *string {
		if own != nil {
			return own
		}
		if installer != nil {
			return of(installer)
		}
		return nil
	}
	checkCommand := field(variant.Check, func(i *Installer) *string { return i.Check })
	// A yes/no check records no version, so it needs no regex.
	var regex *string
	if !variant.Present {
		regex = field(variant.Regex, func(i *Installer) *string { return i.Regex })
	}
	// Outdated precedence: explicit per-variant oracle, else the program's
	// own check (read with its version regex), else the installer's batch
	// oracle (one command for all its packages), else the installer's
	// per-package pattern.
	explicitOutdated := variant.Outdated
	if explicitOutdated == nil && program.Outdated != nil {
		explicitOutdated = &program.Outdated.Command
	}
	outdatedRegex := regex
	if variant.Outdated == nil && program.Outdated != nil {
		outdatedRegex = nil
		if program.Version != nil {
			outdatedRegex = program.Version.Regex
		}
	}
	var batch, outdatedCommand *string
	if explicitOutdated == nil && installer != nil {
		batch = installer.OutdatedAll
	}
	outdatedCommand = explicitOutdated
	if outdatedCommand == nil && batch == nil && installer != nil {
		outdatedCommand = installer.Outdated
	}
	installerName := variant.Installer
	if installerName == nil && m.Installers.Has(key) {
		installerName = &key
	}
	probe := field(variant.Probe, func(i *Installer) *string { return i.Probe })
	// Through a provided tool, its folder comes first: on a fresh machine it
	// isn't on PATH yet (Homebrew).
	var probePath []string
	if probe != nil {
		probePath = m.ToolPaths[*probe]
	}
	reach := concat(probePath, program.Path)
	// Each command runs where the file that wrote it lives: a variant's own
	// override in the program's directory, a pattern in its installer's.
	installerOrigin := ""
	if installer != nil {
		installerOrigin = installer.Origin
	}
	originOf := func(override *string) string {
		if override != nil {
			return program.Origin
		}
		return installerOrigin
	}

	resolved := ResolvedInstall{
		CommandOrigin: originOf(variant.Command),
		Probe:         probe,
		Path:          reach,
	}
	switch {
	case variant.Sudo != nil:
		resolved.Sudo = *variant.Sudo
	case installer != nil:
		resolved.Sudo = installer.Sudo
	}
	if c := field(variant.Command, func(i *Installer) *string { return i.Install }); c != nil {
		resolved.Command = Ptr(sub(*c))
	}
	// A check through the mechanism carries its probe; the program's own
	// `version` fallback is the program itself and carries none.
	if checkCommand != nil && (regex != nil || variant.Present) {
		resolved.Check = &VersionCheck{
			Command: sub(*checkCommand), Regex: regex, Probe: probe,
			Origin: originOf(variant.Check), Path: slices.Clone(reach),
		}
	} else {
		resolved.Check = program.Version
	}
	if outdatedCommand != nil && outdatedRegex != nil {
		resolved.Outdated = &VersionCheck{
			Command: sub(*outdatedCommand), Regex: outdatedRegex,
			Origin: originOf(explicitOutdated), Path: slices.Clone(reach),
		}
	}
	if batch != nil && regex != nil && installerName != nil {
		resolved.OutdatedAll = &BatchOracle{
			Installer: *installerName, Command: *batch, Pkg: pkg, Regex: *regex,
			Origin: installerOrigin, Path: slices.Clone(probePath),
		}
	}
	if installer != nil && installer.Upgrade != nil && installerName != nil {
		resolved.UpgradeWith = &UpgradeMechanism{Installer: *installerName, Command: *installer.Upgrade, Origin: installerOrigin}
	}
	return resolved
}

// CheckFor is the version check to observe programName with when mapped to
// key (nil = unmapped).
func (m Manifest) CheckFor(programName string, key *string) *VersionCheck {
	if key == nil {
		if p, ok := m.Programs.Get(programName); ok {
			return p.Version
		}
		return nil
	}
	return m.ResolveInstall(programName, *key).Check
}

// DependenciesOf is what programName needs installed first on a machine
// mapping it to key: the program's own `depends-on`, that variant's (a COPR
// needs dnf-plugins-core; the same program from pacman needs nothing), and
// what the variant's installer requires of everything it installs (brew
// needs setup-brew), except the program itself. A nil key (no machine in
// view) gives the program's alone.
func (m Manifest) DependenciesOf(programName string, key *string) []string {
	program, ok := m.Programs.Get(programName)
	if !ok {
		return nil
	}
	var variantDeps, required []string
	if key != nil {
		if variant, ok := program.Install.Get(*key); ok {
			variantDeps = variant.DependsOn
			name := *key
			if variant.Installer != nil {
				name = *variant.Installer
			}
			if installer, ok := m.Installers.Get(name); ok {
				for _, r := range installer.Requires {
					if r != programName {
						required = append(required, r)
					}
				}
			}
		}
	}
	return distinct(concat(program.DependsOn, variantDeps, required))
}

// ForMachine is this manifest as machine sees it: each script it runs as a
// variant becomes that variant, so engines read Scripts[name] and never ask
// which variant a machine picked.
func (m Manifest) ForMachine(machine string) Manifest {
	config, ok := m.Machines.Get(machine)
	if !ok {
		return m
	}
	out := m
	if !config.ScriptVariants.IsEmpty() {
		out.Scripts = MapValues(m.Scripts, func(name string, step ScriptStep) ScriptStep {
			if pick, ok := config.ScriptVariants.Get(name); ok {
				return step.Variant(pick)
			}
			return step
		})
	}
	paths := map[string][]string{}
	for name, key := range config.PM.All() {
		program, ok := m.Programs.Get(name)
		if !ok {
			continue
		}
		variant, ok := program.Install.Get(key)
		if !ok {
			continue
		}
		for _, p := range variant.Provides {
			if p.At != nil && !slices.Contains(paths[p.Binary], *p.At) {
				paths[p.Binary] = append(paths[p.Binary], *p.At)
			}
		}
	}
	out.ToolPaths = paths
	return out
}

// ToolPathOf is the folders put first on PATH for installer's own commands
// (its upgrade), from ToolPaths.
func (m Manifest) ToolPathOf(installer string) []string {
	i, ok := m.Installers.Get(installer)
	if !ok || i.Probe == nil {
		return nil
	}
	return m.ToolPaths[*i.Probe]
}

// ResolvedInstall is a program's install variant with all installer defaults applied.
type ResolvedInstall struct {
	// Command is the shell command to install (nil only in invalid manifests — validation rejects it).
	Command *string
	// CommandOrigin is where Command runs: the declaring file's repo-relative directory.
	CommandOrigin string
	// Check is the version check for this variant, falling back to the program's `version`.
	Check *VersionCheck
	// Probe is the binary that must exist before installing, or nil for no probe.
	Probe *string
	// Outdated is the command reporting the version available from the
	// remote source (its output should be just the candidate version; the
	// shared regex extracts it), or nil when this variant has no update oracle.
	Outdated *VersionCheck
	// OutdatedAll is the installer's batch oracle covering this variant, when it has one.
	OutdatedAll *BatchOracle
	// UpgradeWith is how this variant upgrades in place, when its mechanism can.
	UpgradeWith *UpgradeMechanism
	// Sudo says Command needs sudo's password without saying `sudo` itself (see Installer.Sudo).
	Sudo bool
	// Path is the directories put first on PATH for Command (see Program.Path).
	Path []string
}

// UpgradeMechanism is how a variant's mechanism upgrades: all of it, in one command.
type UpgradeMechanism struct {
	Installer string
	Command   string
	// Origin is the installer file's repo-relative directory, where Command runs.
	Origin string
}

// BatchOracle is one installer-wide `outdated-all` command: it prints a
// `<pkg> <candidate>` line per outdated package, so `loadout outdated` asks
// each remote once instead of once per program. Regex extracts the version
// from the candidate token, program by program.
type BatchOracle struct {
	Installer string
	Command   string
	Pkg       string
	Regex     string
	// Origin is the installer file's repo-relative directory, where Command runs.
	Origin string
	// Path is put first on PATH for Command: where its tool lands (Manifest.ToolPaths).
	Path []string
}

// Installer is an install mechanism.
type Installer struct {
	// Probe is the binary that must exist (`command -v`) before installing via this mechanism.
	Probe *string
	// Params are the named values this mechanism needs per program, beyond
	// the package id: `params = ["copr"]` makes `{copr}` substitutable in
	// every pattern below, and every variant using this installer must supply
	// it in its `with` table. Declared, never inferred — an undeclared `with`
	// key and a missing declared one are both errors. "pkg" is reserved.
	Params []string
	// Install is the install command pattern; `{pkg}` is replaced with the package id.
	Install *string
	// Check is the version check command pattern; `{pkg}` is replaced with the package id.
	Check *string
	// Regex extracts the version from Check's output (capture group 1).
	Regex *string
	// Outdated is the pattern printing the version available from the remote
	// source for `{pkg}` (nothing when up to date); Regex extracts it. Powers
	// `loadout outdated`.
	Outdated *string
	// OutdatedAll is the batch form of Outdated (`outdated-all`): ONE command
	// printing a `<pkg> <candidate>` line per outdated package this installer
	// manages. When present it replaces the per-package outdated pattern.
	OutdatedAll *string
	// Upgrade upgrades EVERYTHING this mechanism manages, in one command —
	// there is no per-package form on purpose (contract 15): partial upgrades
	// are unsupported on Arch, discouraged on Fedora, and a package manager
	// resolves its own transaction anyway. Converge never runs this;
	// `loadout upgrade` is the explicit verb.
	Upgrade *string
	// Sudo says Install and Upgrade need sudo's password but don't say
	// `sudo` themselves: they call it from inside (`omarchy pkg add`, a
	// `file:` script). A run whose plan holds a step that needs sudo (this,
	// or a command that visibly runs it) asks for the password once, before
	// the first step, and keeps sudo's credentials fresh until it ends.
	// Declared, never guessed: nothing reads a script to find sudo in it.
	// Same for `sudo` on install variants, scripts and `outdated` sources.
	Sudo bool
	// Requires is the programs every program installed through this
	// installer depends on (setup-brew before any brew install). A required
	// program installed through this same installer is exempt from its own rule.
	Requires []string
	// Origin is the repo-relative directory of the declaring file ("" = repo
	// root): paths resolve and commands run there.
	Origin string
}

// InstallVariant is one entry of a program's install table, keyed by its
// installer's name or, for a command of its own, by a name the program
// picks. Every field is optional: the installer supplies defaults, and `pkg`
// defaults to the program name — so the empty variant means "the standard
// package".
type InstallVariant struct {
	// Installer provides defaults; defaults to the variant key when that names one.
	Installer *string
	// Pkg is the package id within the installer's namespace; defaults to the program name.
	Pkg *string
	// Command is the full install command, replacing the installer's pattern. `file:` prefix allowed.
	Command *string
	// Check is the version check command, replacing the installer's pattern.
	Check *string
	// Regex is the version regex, replacing the installer's.
	Regex *string
	// Present says the check only says yes or no: exit 0 = installed, no version recorded.
	Present bool
	// Probe is the probe binary, replacing the installer's.
	Probe *string
	// Outdated is the remote-candidate command, replacing the installer's (see Installer.Outdated).
	Outdated *string
	// With holds values for the installer's Params; each becomes `{name}` in the resolved commands.
	With Map[string]
	// Sudo replaces the installer's Installer.Sudo for this variant's install command.
	Sudo *bool
	// DependsOn is the programs THIS variant needs first (`depends-on`), on
	// top of the program's own — for prerequisites of one mechanism only,
	// which would otherwise drag e.g. a dnf package onto a pacman machine.
	DependsOn []string
	// Provides is the binaries this variant puts on the machine (`flatpak`,
	// `brew`), so a plan that installs it may install, after it, what goes
	// through them: their probe needn't be there before the run.
	Provides []Provides
}

// Provides is a binary a variant provides, and the folder it lands in when
// that isn't on PATH yet.
type Provides struct {
	Binary string
	At     *string
}

// MachineConfig is a machine as the engines see it: its profiles merged in
// (contract 2), one program mapping and one script list, and its whole data.
type MachineConfig struct {
	// Extends is the profiles this machine was built on, in order; kept for `explain`.
	Extends []string
	// PM says which entry of each program's `install` table this machine
	// uses, keyed by program name. Every program a machine installs must be mapped.
	PM Map[string]
	// Scripts this machine runs: entries are `"name"` or `"name args..."`
	// (first word = script name, rest = arguments passed as positional
	// parameters to `file` scripts and their checks). Scripts run and are
	// observed only on machines that opt in.
	Scripts []string
	// ScriptVariants is the variant this machine runs (`script-variants`),
	// for each of its scripts that has variants.
	ScriptVariants Map[string]
	// Data is the machine's whole data: defaults, profiles, its own.
	Data JSONObject
	// Label is what declared it (`machine 'x'`, `profile 'y'`), for
	// messages. Never written to the lock.
	Label string
}

// ScriptArgs is Scripts parsed into script name -> argument string (see ScriptEntry).
func (c MachineConfig) ScriptArgs() Map[string] {
	var out Map[string]
	for _, entry := range c.Scripts {
		name, args := ScriptEntry(entry)
		out.Set(name, args)
	}
	return out
}

var whitespace = regexp.MustCompile(`[ \t\n\x0B\f\r]+`)

// ScriptEntry is one `scripts` entry as (name, arguments): words split on
// any whitespace and the arguments re-joined with single spaces. The
// arguments are pasted into a shell command line, where a newline would end
// the command.
func ScriptEntry(entry string) (name, args string) {
	words := whitespace.Split(strings.TrimFunc(entry, unicode.IsSpace), -1)
	return words[0], strings.Join(words[1:], " ")
}

// Meta is the repo's name and the loadout it needs.
type Meta struct {
	Name string
	// MinToolVersion is the oldest loadout that may read the lock (`min-tool-version`).
	MinToolVersion *string
}

// RepoLayout is where the repo keeps what loadout writes and reads besides
// the manifests. Paths are relative to the repo root.
type RepoLayout struct {
	// State is the state directory: one `<machine>.json` per machine. Required.
	State string
	// Configs is the chezmoi source root, when the repo holds dotfiles.
	Configs *string
	// Sources is the globs of the manifest sources, in compile order. The
	// lock's hash covers the files they match, so an edit the lock hasn't
	// seen is refused.
	Sources []string
	// Parent is the repo this one builds on, for a child repo (contract 18); nil for any other.
	Parent *ParentLayout
}

// ParentLayout is a child repo's parent, as its lock records it: the public
// repo whose programs, scripts, installers, profiles and data schema the
// child's manifests use by name. Its declarations in the child's lock carry
// parent origins (OriginParent) and run in Path.
type ParentLayout struct {
	// Name is what messages call it: "parent dotfiles".
	Name string
	// Path is its checkout, as written: `~/…`, absolute, or relative to the child's root.
	Path string
	// State is its state directory, read (never written) for the fleet view.
	State string
	// Configs is its chezmoi source, applied beside the child's.
	Configs *string
	// Sources is its manifest globs, from its own lock.
	Sources []string
	// Hash is the sha256 of the files Sources match (SourcesHash): a change
	// is refused until the child recompiles.
	Hash string
}

// Root is Path as a directory: `~/…` under home, an absolute path as
// written, anything else under childRoot. An empty home means HOME is unset.
func (p ParentLayout) Root(home, childRoot string) (string, error) {
	switch {
	case p.Path == "~" || strings.HasPrefix(p.Path, "~/"):
		if home == "" {
			return "", NewManifestException(fmt.Sprintf("HOME is unset: can't place parent %s at %s", p.Name, p.Path))
		}
		return path.Clean(strings.TrimRight(home, "/") + strings.TrimPrefix(p.Path, "~")), nil
	case strings.HasPrefix(p.Path, "/"):
		return path.Clean(p.Path), nil
	default:
		return path.Clean(path.Join(childRoot, p.Path)), nil
	}
}

// A declaration's origin, as the lock records it: the repo-relative folder
// of the file that wrote it, where its commands run and its `file:` paths
// resolve. In a child repo's lock, a declaration of its parent's is that
// folder in the parent, prefixed OriginParent.
const OriginParent = "parent:"

// IsParentOrigin says whether origin is the parent's (Origin.isParent).
func IsParentOrigin(origin string) bool { return strings.HasPrefix(origin, OriginParent) }

// OriginFolder is the folder, relative to its repo's root (Origin.folder).
func OriginFolder(origin string) string { return strings.TrimPrefix(origin, OriginParent) }

// ParentOrigin is folder as a parent's origin (Origin.ofParent).
func ParentOrigin(folder string) string { return OriginParent + folder }

// InstallFilePrefix starts commands (install variant `command`s, installer
// patterns, oracles and any check command) that name a script file relative
// to the declaring file's directory — where the command also runs —
// validated at compile to exist inside the repo, instead of an inline
// command. Tokens after the first space are arguments, so the path itself
// can't contain spaces.
const InstallFilePrefix = "file:"

// ExpandFilePrefix expands a `file:path args…` command to `sh 'path' args…`;
// others pass through.
func ExpandFilePrefix(command string) string {
	spec, ok := strings.CutPrefix(command, InstallFilePrefix)
	if !ok {
		return command
	}
	p, args, _ := strings.Cut(spec, " ")
	if args != "" {
		return "sh '" + p + "' " + args
	}
	return "sh '" + p + "'"
}

// ShellLine is the shell line for command: `file:` expanded, and path put
// first on PATH. The directories are expanded by the shell, so `$HOME` works.
func ShellLine(command string, path []string) string {
	line := ExpandFilePrefix(command)
	if len(path) == 0 {
		return line
	}
	return `PATH="` + strings.Join(path, ":") + `:$PATH"; export PATH; ` + line
}

// Program is one program: its install variants and how to observe it.
type Program struct {
	Description string
	Tags        []string
	// DependsOn is `depends-on`.
	DependsOn []string
	// Version is the variant-independent version check; the fallback when a variant resolves no check.
	Version *VersionCheck
	// Install is the install variants, keyed by installer name (`dnf`) or,
	// for a command of the program's own, by the name it gives it (`linux`).
	// Each machine's mapping picks which key to use.
	Install Map[InstallVariant]
	// Outdated is this program's own remote check, for programs no
	// installer's oracle covers (a binary that updates itself). Its candidate
	// is read with the program's Version regex, and ProgramOutdated.Upgrade
	// moves this one program on its own.
	Outdated *ProgramOutdated
	// Path is the directories put first on PATH for this program's commands,
	// for a tool that lands somewhere a fresh shell doesn't look yet
	// (`$HOME/.local/bin`).
	Path []string
	// Origin is the repo-relative directory of the declaring file ("" = repo
	// root): paths resolve and commands run there.
	Origin string
}

// ProgramOutdated is a program's own `outdated` block: Command prints the
// newest version, Upgrade updates it.
type ProgramOutdated struct {
	// Command prints the newest version available (nothing when up to date); the program's version regex reads it.
	Command string
	// Upgrade updates this program alone. Runs once per upgrade; `{item}` is not substituted.
	Upgrade *string
}

// VersionCheck is a command that reports a version (or, without a regex, only yes or no).
type VersionCheck struct {
	Command string
	// Regex extracts the version (capture group 1); nil for a yes/no check, which records none.
	Regex *string
	// Probe is the tool this check asks through (the installer's probe), when
	// the check isn't the program's own binary. Set by ResolveInstall, never
	// declared or written: it's what lets "brew: command not found" mean
	// "couldn't ask" instead of "not installed".
	Probe *string
	// Origin is the repo-relative directory of the declaring file ("" = repo
	// root): paths resolve and commands run there.
	Origin string
	// Path is the directories put first on PATH (see Program.Path).
	Path []string
}

// Equal is value equality.
func (v *VersionCheck) Equal(o *VersionCheck) bool {
	if v == nil || o == nil {
		return v == o
	}
	return v.Command == o.Command && eqPtr(v.Regex, o.Regex) && eqPtr(v.Probe, o.Probe) &&
		v.Origin == o.Origin && slices.Equal(v.Path, o.Path)
}

func eqPtr[T comparable](a, b *T) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

var defaultModes = []string{"setup", "maintain"}

// DefaultModes is a script's modes when it doesn't say: both surfaces.
func DefaultModes() []string { return slices.Clone(defaultModes) }

// ScriptStep is one idempotent setup step.
type ScriptStep struct {
	Description string
	// File is the script file to execute, relative to the declaring file's directory. Exactly one of File/Run.
	File *string
	// Run is the inline shell command to execute. Exactly one of File/Run.
	Run *string
	// Check is a shell command; exit 0 means the step is already done and is skipped.
	Check *string
	// After holds ordering constraints: entries like "programs.git" or "scripts.dotfiles".
	After []string
	// Modes is the execution surfaces this script participates in: "setup"
	// (setup-new-machine's converge) and/or "maintain" (the home screen's
	// scripts picker). Nil means the default, both (DefaultModes); an empty
	// non-nil list is an empty list, which validation refuses. Governs
	// execution only — `status` observes every opted-in script regardless,
	// and `run <name>` is the explicit escape hatch.
	Modes []string
	// Sudo says the script needs sudo's password without saying `sudo`; see Installer.Sudo.
	Sudo bool
	// Variants is the ways to do this one step, keyed by name; a machine
	// running the script picks one. Each holds its own File/Run, Check and
	// After; the step's own description, modes and sudo apply to all of them.
	Variants Map[ScriptStep]
	// Origin is the repo-relative directory of the declaring file ("" = repo
	// root): paths resolve and commands run there.
	Origin string
}

// ModeList is Modes with the default applied.
func (s ScriptStep) ModeList() []string {
	if s.Modes == nil {
		return DefaultModes()
	}
	return s.Modes
}

// RunsIn says whether the step runs on the mode surface.
func (s ScriptStep) RunsIn(mode string) bool { return slices.Contains(s.ModeList(), mode) }

// Variant is the step as variant name does it. Assumes the variant exists.
func (s ScriptStep) Variant(name string) ScriptStep {
	chosen, ok := s.Variants.Get(name)
	if !ok {
		panic(fmt.Sprintf("script has no variant %q", name))
	}
	out := s
	out.File = chosen.File
	out.Run = chosen.Run
	if chosen.Check != nil {
		out.Check = chosen.Check
	}
	out.After = distinct(concat(s.After, chosen.After))
	out.Sudo = s.Sudo || chosen.Sudo
	out.Variants = Map[ScriptStep]{}
	out.Origin = chosen.Origin
	return out
}

// OutdatedSource is one custom `outdated` oracle; see Manifest.Outdated.
type OutdatedSource struct {
	// Command prints `<item> <current> <candidate>` lines. `file:` allowed.
	Command *string
	// Upgrade is how to update ONE of this source's items: `{item}` is the
	// row name, and the command runs once per row you pick. Per-item on
	// purpose — a pin in a file and a plugin clone are independent, unlike a
	// package manager's transaction (contract 15). Without this, the source's
	// rows are read-only. `file:` allowed.
	Upgrade *string
	// Sudo says Upgrade needs sudo's password without saying `sudo`; see Installer.Sudo.
	Sudo bool
	// Origin is the repo-relative directory of the declaring file ("" = repo
	// root): paths resolve and commands run there.
	Origin string
}
