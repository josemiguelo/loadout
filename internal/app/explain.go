package app

import (
	"slices"
	"strings"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/model"
)

// What `explain` says about a program, script or config — the fully expanded
// definition as the engine sees it, plus this machine's last observation —
// as data: the CLI prints it, the home screen's inspector shows it.

// ExplainRow is one `label  value` line. Machine is set on the install
// variant this machine uses (its name): the CLI marks it `<- machine`.
type ExplainRow struct {
	Label, Value string
	Machine      string
}

// Explained is one program, script or config.
type Explained struct {
	// Kind is "program", "script" or "config".
	Kind        string
	Name        string
	Description string
	// Folder is where it is declared, from the repo's root ("" = the root);
	// a config's is the configs directory.
	Folder string
	Rows   []ExplainRow
	// Notes are warnings after the rows ("! not installed on m1 …").
	Notes []string
}

// ExplainedName is everything a name explains: a program or a script, and a
// config of the same name (tmux the program, tmux the config).
type ExplainedName struct {
	Name  string
	Items []Explained
}

// NoSuchItemError is a name explain doesn't know.
type NoSuchItemError struct{ Message string }

func (e *NoSuchItemError) Error() string { return e.Message }

// Refusal marks it a refusal.
func (*NoSuchItemError) Refusal() {}

// Explain explains names (none: every program and script). Configs are asked
// about (chezmoi) only for names given. An unknown name stops it with a
// *NoSuchItemError, returning what came before it.
func (a *AppContext) Explain(names []string) ([]ExplainedName, error) {
	manifest, err := a.LoadManifest()
	if err != nil {
		return nil, err
	}
	layout, err := a.Layout()
	if err != nil {
		return nil, err
	}
	system := a.DetectSystem()
	store, err := a.StateStore()
	if err != nil {
		return nil, err
	}
	observed := store.Read(system.Machine)
	machine, declared := manifest.Machines.Get(system.Machine)
	mapping := machine.PM
	parentName := "null"
	if layout.Parent != nil {
		parentName = layout.Parent.Name
	}
	statePath := layout.State + "/" + system.Machine + ".json"

	targets := names
	if len(targets) == 0 {
		targets = append(manifest.Programs.Keys(), manifest.Scripts.Keys()...)
	}
	var units []engine.ConfigUnit
	var askErr error
	if len(names) > 0 {
		units, askErr = func() ([]engine.ConfigUnit, error) {
			configs, err := a.Configs()
			if err != nil || configs == nil {
				return nil, err
			}
			return configs.Units()
		}()
		if askErr != nil {
			units = nil
		}
	}
	unitNamed := func(name string) (engine.ConfigUnit, bool) {
		for _, u := range units {
			if u.Name == name {
				return u, true
			}
		}
		return engine.ConfigUnit{}, false
	}
	fromParent := func(origin string) (string, bool) {
		if !model.IsParentOrigin(origin) {
			return "", false
		}
		folder := model.OriginFolder(origin)
		if folder == "" {
			folder = "its root"
		}
		return "parent " + parentName + " (" + folder + ")", true
	}

	var out []ExplainedName
	for _, name := range targets {
		program, isProgram := manifest.Programs.Get(name)
		script, isScript := manifest.Scripts.Get(name)
		unit, isUnit := unitNamed(name)
		if !isProgram && !isScript && !isUnit {
			kinds := "program or script"
			if a.HasConfigs() {
				kinds = "program, script or config"
			}
			why := ""
			if askErr != nil {
				why = " (configs not checked: " + askErr.Error() + ")"
			}
			return out, &NoSuchItemError{"no " + kinds + " named '" + name + "'" + why}
		}
		named := ExplainedName{Name: name}
		switch {
		case isProgram:
			item := Explained{Kind: "program", Name: name, Description: program.Description, Folder: model.OriginFolder(program.Origin)}
			rows := []ExplainRow{}
			add := func(label, value string) { rows = append(rows, ExplainRow{Label: label, Value: value}) }
			if from, ok := fromParent(program.Origin); ok {
				add("from", from)
			}
			if program.Version != nil {
				add("version", DescribeCheck(*program.Version))
			} else {
				add("version", "(none — status will always be 'unknown')")
			}
			if len(program.DependsOn) > 0 {
				add("depends-on", strings.Join(program.DependsOn, ", "))
			}
			if len(program.Path) > 0 {
				add("path", strings.Join(program.Path, ":")+"  (first on PATH for its commands)")
			}
			if len(program.Tags) > 0 {
				add("tags", strings.Join(program.Tags, ", "))
			}
			if program.Install.IsEmpty() {
				add("install", "(none — not installable anywhere)")
			}
			mappedKey, isMapped := mapping.Get(name)
			for key, variant := range program.Install.All() {
				resolved := manifest.ResolveInstall(name, key)
				installer := ""
				if variant.Installer != nil {
					installer = *variant.Installer
				} else if manifest.Installers.Has(key) {
					installer = key
				}
				// Where the mechanics came from: loadout's library or this repo.
				via := ""
				if installer != "" {
					origin := "repo"
					switch {
					case slices.Contains(manifest.BuiltinInstallers, installer):
						origin = "built-in"
					case model.IsParentOrigin(manifest.Installers.Value(installer).Origin):
						origin = "parent " + parentName
					}
					via = "  [installer: " + installer + " (" + origin + ")]"
				}
				command := "null"
				if resolved.Command != nil {
					command = *resolved.Command
				}
				r := ExplainRow{Label: "install." + key, Value: command + via}
				if isMapped && key == mappedKey {
					r.Machine = system.Machine
				}
				rows = append(rows, r)
				if resolved.Check != nil && !resolved.Check.Equal(program.Version) {
					add("check."+key, DescribeCheck(*resolved.Check))
				}
				if resolved.Probe != nil {
					add("probe."+key, *resolved.Probe)
				}
				if resolved.Sudo {
					add("sudo."+key, "yes — a run that installs it asks for the password first")
				}
				if len(variant.DependsOn) > 0 {
					add("depends-on."+key, strings.Join(variant.DependsOn, ", "))
				}
				if len(variant.Provides) > 0 {
					var provides []string
					for _, p := range variant.Provides {
						if p.At != nil {
							provides = append(provides, p.Binary+" (in "+*p.At+")")
						} else {
							provides = append(provides, p.Binary)
						}
					}
					add("provides."+key, strings.Join(provides, ", "))
				}
			}
			if !isMapped {
				item.Notes = append(item.Notes, "! not installed on "+system.Machine+" (install it in machine '"+system.Machine+"' or a profile it extends)")
			}
			if observed != nil {
				if p, ok := observed.Programs.Get(name); ok {
					version := ""
					if p.Version != nil {
						version = " " + *p.Version
					}
					add("observed", string(p.Status)+version+"  ("+statePath+")")
				}
			}
			item.Rows = rows
			named.Items = append(named.Items, item)
		case isScript:
			item := Explained{Kind: "script", Name: name, Description: script.Description, Folder: model.OriginFolder(script.Origin)}
			rows := []ExplainRow{}
			add := func(label, value string) { rows = append(rows, ExplainRow{Label: label, Value: value}) }
			if from, ok := fromParent(script.Origin); ok {
				add("from", from)
			}
			if script.File != nil {
				add("file", *script.File)
			}
			if script.Run != nil {
				add("run", *script.Run)
			}
			if script.Check != nil {
				add("check", *script.Check)
			}
			if !script.Variants.IsEmpty() {
				add("variants", strings.Join(script.Variants.Keys(), ", "))
			}
			if len(script.After) > 0 {
				add("after", strings.Join(script.After, ", "))
			}
			if modes := script.ModeList(); !slices.Equal(modes, []string{"setup", "maintain"}) {
				add("modes", strings.Join(modes, ", "))
			}
			if script.Sudo {
				add("sudo", "yes — a run that runs it asks for the password first")
			}
			args, enabled := machine.ScriptArgs().Get(name)
			switch {
			case !declared || !enabled:
				add("enabled", "no — run it in machine '"+system.Machine+"' or a profile it extends")
			case args == "":
				add("enabled", "yes ("+system.Machine+")")
			default:
				add("enabled", "yes ("+system.Machine+", args: "+args+")")
			}
			if observed != nil {
				if s, ok := observed.Scripts.Get(name); ok {
					add("observed", string(s.Status)+"  ("+statePath+")")
				}
			}
			item.Rows = rows
			named.Items = append(named.Items, item)
		}
		if isUnit {
			configsDir := "null"
			if layout.Configs != nil {
				configsDir = *layout.Configs
			}
			item := Explained{Kind: "config", Name: name, Folder: configsDir + "/"}
			for i, target := range unit.Targets {
				label := ""
				if i == 0 {
					label = "targets"
				}
				item.Rows = append(item.Rows, ExplainRow{Label: label, Value: target})
			}
			if observed != nil {
				if c, ok := observed.Configs.Get(name); ok {
					status := string(c.Status)
					if c.Status == coremodel.ConfigDrifted {
						status = "drifted: " + strings.Join(c.Files, ", ")
					}
					item.Rows = append(item.Rows, ExplainRow{Label: "observed", Value: status + "  (" + statePath + ")"})
				}
			}
			named.Items = append(named.Items, item)
		}
		out = append(out, named)
	}
	return out, nil
}

// DescribeCheck is a check as explain shows it: its command and what reads
// the version, or that it only says yes or no.
func DescribeCheck(check model.VersionCheck) string {
	if check.Regex != nil {
		return check.Command + "  =~ /" + *check.Regex + "/"
	}
	return check.Command + "  (yes/no)"
}
