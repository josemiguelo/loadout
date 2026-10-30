package cli

import (
	"slices"
	"strings"

	"github.com/spf13/cobra"
)

// newInstallersCmd is what `install_via = [dnf]` actually means. Installers
// ship with loadout and are merged under the repo's own, so this is where
// you see which definition won. To own a built-in, declare an installer of
// the same name.
func newInstallersCmd() *cobra.Command {
	return subcommand("installers", commandHelp(
		"Show the install mechanisms available to this repo: loadout's built-ins plus your own.",
		"[name]     print one installer's full definition",
	), []argSpec{{name: "name", help: "Installer to describe", optional: true}}, runInstallers)
}

func runInstallers(cmd *cobra.Command, args []string) error {
	manifest, err := appCtx.LoadManifest()
	if err != nil {
		return err
	}
	// Style AFTER padding — escape codes would break the column width.
	source := func(key string, width int) string {
		if slices.Contains(manifest.BuiltinInstallers, key) {
			return Style.Dim(padEnd("built-in", width))
		}
		return Style.Machine(padEnd("repo", width))
	}

	if len(args) == 1 {
		single := args[0]
		installer, ok := manifest.Installers.Get(single)
		if !ok {
			return usageErr("Unknown installer '" + single + "' (see: loadout installers)")
		}
		echo(Style.Header("installer ") + Style.Bold(single) + "  " + source(single, 0))
		var rows []row
		add := func(label string, value *string) {
			if value != nil {
				rows = append(rows, row{label, *value})
			}
		}
		add("probe", installer.Probe)
		if len(installer.Params) > 0 {
			rows = append(rows, row{"params", strings.Join(installer.Params, ", ")})
		}
		add("install", installer.Install)
		add("upgrade", installer.Upgrade)
		if installer.Sudo {
			rows = append(rows, row{"sudo", "yes — a run that installs or upgrades through it asks for the password first"})
		}
		add("check", installer.Check)
		add("regex", installer.Regex)
		add("outdated", installer.Outdated)
		add("outdated-all", installer.OutdatedAll)
		if len(installer.Requires) > 0 {
			rows = append(rows, row{"requires", strings.Join(installer.Requires, ", ")})
		}
		echoLabelled(rows)
		return nil
	}

	names := sortedKeys(manifest.Installers)
	if len(names) == 0 {
		echo("No installers.")
		return nil
	}
	nameWidth := 9
	for _, n := range names {
		nameWidth = max(nameWidth, runeLen(n))
	}
	nameWidth += 2
	echo(Style.Header("  " + padEnd("INSTALLER", nameWidth) + "SOURCE    INSTALL"))
	for _, key := range names {
		install := "(no install command)"
		if i := manifest.Installers.Value(key).Install; i != nil {
			install = *i
		}
		echo("  " + padEnd(key, nameWidth) + source(key, 10) + Style.Dim(install))
	}
	echo("")
	echo(Style.Dim("  A repo installer of the same name replaces the built-in."))
	return nil
}
