// Package cli is loadout's commands (cobra; one file per subcommand) and
// their presentation: Style (palette -> ANSI), echoRows (tables and
// boxes), spinning, help laid out as loadout 3's (Clikt's), and the converge
// pipeline. The services they share with the home screen live in
// internal/app.
package cli

import (
	"fmt"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/core/platform"
	"github.com/josemiguelo/loadout/internal/version"
	"github.com/spf13/cobra"
)

// rootOf is the root command of the running invocation (for usage lines).
var rootOf *cobra.Command

// appCtx is the shared services, built by the root command before any
// subcommand runs.
var appCtx *app.AppContext

// envOr is environment variable name, or fallback when it's unset or empty.
func envOr(name, fallback string) string {
	if v, ok := platform.EnvVar(name); ok && v != "" {
		return v
	}
	return fallback
}

// NewRoot is the `loadout` command with every subcommand.
func NewRoot() *cobra.Command {
	var (
		showVersion bool
		repo        string
		machine     string
		verbose     bool
	)
	cobra.EnableCommandSorting = false
	root := &cobra.Command{
		Use:           "loadout",
		SilenceErrors: true,
		SilenceUsage:  true,
		// The home screen is the bare invocation; every subcommand still runs
		// normally, and a pipe still gets help.
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				return noSuchSubcommand(cmd, args[0])
			}
			return nil
		},
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			// The palette is settled before anything runs, as Clikt's theme
			// was: the background query (TTY only) never lands while a child
			// process or the home screen owns the terminal.
			Style.init()
			if showVersion {
				echo("loadout version " + version.Version)
				return exitWith(0)
			}
			appCtx = app.New(repo, machine, verbose)
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if !platform.IsStdoutTty() || app.NewScreen == nil {
				printHelp(cmd)
				return nil
			}
			return home(appCtx)
		},
	}
	rootOf = root
	specOf(root).help = "Set up a machine from a shared config repo and track installed program versions. v" + version.Version
	root.CompletionOptions.DisableDefaultCmd = true
	// No `help` subcommand: Clikt had none, so `loadout help` is no such subcommand.
	root.SetHelpCommand(&cobra.Command{Use: "no-help-command", Hidden: true})
	root.SetHelpFunc(func(cmd *cobra.Command, _ []string) { printHelp(cmd) })
	root.SetFlagErrorFunc(flagError)
	root.DisableSuggestions = true

	// Persistent so they also parse after the subcommand; help lists them on
	// the root only, as Clikt did.
	pf := root.PersistentFlags()
	pf.SortFlags = false
	boolFlag(root, pf, &showVersion, "version", "V", "Show the version and exit")
	stringFlag(root, pf, &repo, "repo", "", envOr("LOADOUT_REPO", "."),
		"Path to the config repo (default: $LOADOUT_REPO, then the current directory)")
	stringFlag(root, pf, &machine, "machine", "", envOr("LOADOUT_MACHINE", ""),
		"Machine name for state tracking (default: hostname)")
	boolFlag(root, pf, &verbose, "verbose", "v", "Verbose output")
	helpFlag(root)

	for _, sub := range []*cobra.Command{
		newStatusCmd(),
		newExplainCmd(),
		newInstallersCmd(),
		newSetupCmd(),
		newInstallCmd(),
		newOutdatedCmd(),
		newRunCmd(),
		newApplyCmd(),
		newDiffCmd(),
		newSyncCmd(),
		newUpgradeCmd(),
		newSelfUpgradeCmd(),
		newInitCmd(),
		newCompileCmd(),
	} {
		sub.Flags().SortFlags = false
		helpFlag(sub)
		root.AddCommand(sub)
	}
	return root
}

func printHelp(cmd *cobra.Command) {
	outMu.Lock()
	defer outMu.Unlock()
	fmt.Fprint(stdout, renderHelp(cmd))
}

// subcommand is a subcommand named name with help (commandHelp's) and its
// positional arguments, running run with the shared AppContext.
func subcommand(name, help string, args []argSpec, run func(cmd *cobra.Command, args []string) error) *cobra.Command {
	cmd := &cobra.Command{
		Use:  name,
		RunE: run,
	}
	specOf(cmd).help = help
	specOf(cmd).args = args
	optional := len(args) > 0 && args[len(args)-1].multiple
	if !optional {
		cmd.Args = argsAtMost(len(args))
	}
	return cmd
}

// Execute parses args and runs the command they name. The error is for
// main to report: a *UsageError (its Render on stderr, exit 1), an
// *ExitError (its code, nothing printed), an *exec.InterruptedByUser (130),
// or anything else (`error: <message>`, exit 1).
func Execute(args []string) error {
	root := NewRoot()
	root.SetArgs(args)
	root.SetOut(stdout)
	root.SetErr(stderr)
	return root.Execute()
}
