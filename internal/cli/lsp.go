package cli

import (
	"os"

	"github.com/spf13/cobra"

	"github.com/josemiguelo/loadout/internal/lsp"
)

// newLspCmd is the language server an editor starts for the manifests:
// hidden, since nobody runs it by hand. It owns stdin and stdout (the
// protocol) and logs to stderr (the editor's LSP log).
func newLspCmd() *cobra.Command {
	cmd := subcommand("lsp", "Serve the manifests to an editor over the Language Server Protocol.", nil,
		func(cmd *cobra.Command, args []string) error {
			if code := lsp.Serve(os.Stdin, os.Stdout, os.Stderr); code != 0 {
				return exitWith(code)
			}
			return nil
		})
	cmd.Hidden = true
	return cmd
}
