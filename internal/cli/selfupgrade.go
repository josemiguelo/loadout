package cli

import (
	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/version"
	"github.com/spf13/cobra"
)

func newSelfUpgradeCmd() *cobra.Command {
	return subcommand("self-upgrade", commandHelp(
		"Replace the loadout binary with the latest release. Needs no config repo, so it works even under a min-tool-version refusal (`upgrade` is for programs).",
	), nil, func(cmd *cobra.Command, args []string) error {
		latest := app.LatestRelease(appCtx.Runner, false)
		if latest != "" && version.AtLeast(version.Version, latest) {
			echo("already on the latest release (v" + version.Version + ")")
			return nil
		}
		target := "the latest release"
		if latest != "" {
			target = "v" + latest
		}
		echo("current: v" + version.Version + " — installing " + target + "…")
		code, err := appCtx.Runner.Inherit(exec.Line(version.InstallCommand, ""))
		if err != nil {
			return err
		}
		if code != 0 {
			return exitWith(code)
		}
		return nil
	})
}
