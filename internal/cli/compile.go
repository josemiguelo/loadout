package cli

import (
	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/tsmanifest"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/spf13/cobra"
)

// newCompileCmd runs the repo's TypeScript manifests (loadout.ts, with the
// bun loadout brings) into loadout.lock.json, the one thing every other
// command reads.
func newCompileCmd() *cobra.Command {
	return subcommand("compile", commandHelp(
		"Compile the repo's TypeScript manifests (loadout.ts) into "+model.LockFileName+".",
	), nil, func(cmd *cobra.Command, args []string) error { return compileRepo(appCtx) })
}

// compileRepo compiles a's repo, saying what it wrote and warned; a failed
// compile is a refusal naming every mistake (one `error: ` line each).
// `sync` runs it too, for a child whose parent's manifests changed.
func compileRepo(a *app.AppContext) error {
	warnings, err := spinning("compiling manifests…", func() ([]string, error) { return tsmanifest.Compile(a.RepoRoot, a.Runner) })
	if err != nil {
		return err
	}
	echo(" " + Style.Ok("✔") + "  wrote " + model.LockFileName)
	// What the manifests declare but no machine uses.
	for _, w := range warnings {
		echo(" " + Style.Warn("!") + "  " + w)
	}
	return nil
}
