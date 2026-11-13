package cli

import (
	"bytes"
	"embed"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"text/template"

	"github.com/josemiguelo/loadout/internal/core/git"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/tsmanifest"
	"github.com/spf13/cobra"
)

// The scaffolds `init` writes, one folder per kind of repo: init (programs/
// and maintenance/), init-configs (everything in loadouts/, chezmoi's
// source, each tool's manifest where its files land), child and
// child-configs (contract 18: a parent block, no example that could clash).
// File names and contents are text/templates over scaffoldVars. Every
// scaffold gets the SDKs too (tsmanifest.SDKFile, ScriptSDKFile), so the
// editor has the manifests' and scripts' types before the first compile.
//
//go:embed all:scaffold
var scaffolds embed.FS

// scaffoldVars is what a scaffold's templates fill in.
type scaffoldVars struct {
	Hostname   string
	ParentName string
	ParentPath string
	// ParentImport is the parent's checkout from the child's root, for
	// tsconfig.json's "parent/*" alias.
	ParentImport string
}

// jsString is s escaped for the inside of a double-quoted TypeScript (and
// JSON) string literal.
func jsString(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "\t", `\t`).Replace(s)
}

// scaffoldFile is one file of a scaffold, rendered: its path in the repo and its content.
type scaffoldFile struct {
	path    string
	content []byte
}

// renderScaffold is the files of scaffold kind for vars, and the SDK. Paths
// take the values as they are; contents take them escaped, since every
// value lands inside a string.
func renderScaffold(kind string, vars scaffoldVars) ([]scaffoldFile, error) {
	escaped := scaffoldVars{jsString(vars.Hostname), jsString(vars.ParentName), jsString(vars.ParentPath), jsString(vars.ParentImport)}
	base := "scaffold/" + kind
	var files []scaffoldFile
	err := fs.WalkDir(scaffolds, base, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := fill(strings.TrimPrefix(p, base+"/"), vars)
		if err != nil {
			return err
		}
		raw, err := scaffolds.ReadFile(p)
		if err != nil {
			return err
		}
		content, err := fill(string(raw), escaped)
		if err != nil {
			return err
		}
		files = append(files, scaffoldFile{rel, []byte(content)})
		return nil
	})
	return append(files,
		scaffoldFile{tsmanifest.SDKFile, []byte(tsmanifest.SDK)},
		scaffoldFile{tsmanifest.ScriptSDKFile, []byte(tsmanifest.ScriptSDK)}), err
}

func fill(text string, vars scaffoldVars) (string, error) {
	t, err := template.New("").Option("missingkey=error").Parse(text)
	if err != nil {
		return "", err
	}
	var b bytes.Buffer
	if err := t.Execute(&b, vars); err != nil {
		return "", err
	}
	return b.String(), nil
}

func newInitCmd() *cobra.Command {
	var configs bool
	var parent, parentName string
	cmd := subcommand("init", commandHelp(
		"Scaffold a new config repo (TypeScript manifests, machines/state/) and git init it.",
		"[path]     where to scaffold (default: current directory)",
		"--configs  hold your dotfiles too: chezmoi's source in loadouts/, each tool's manifest where its files land",
		"--parent   a child repo of the compiled repo at this path: uses its declarations by name",
		"--name     what the child calls its parent (default: parent)",
	), []argSpec{{name: "path", help: "Where to create the repo", optional: true}},
		func(cmd *cobra.Command, args []string) error {
			root := "."
			if len(args) == 1 {
				root = args[0]
			}
			if cmd.Flags().Changed("parent") {
				return initChild(root, parent, parentName, configs)
			}
			return initRepo(root, configs)
		})
	boolFlag(cmd, cmd.Flags(), &configs, "configs", "", "Hold dotfiles too (chezmoi's source in loadouts/, each tool's manifest where its files land)")
	stringFlag(cmd, cmd.Flags(), &parent, "parent", "", "", "Scaffold a child repo of the compiled repo at this path")
	stringFlag(cmd, cmd.Flags(), &parentName, "name", "", "parent", "What the child calls its parent")
	return cmd
}

// writeScaffold refuses to overwrite anything a scaffold would write (the
// lock included), then writes it.
func writeScaffold(root string, files []scaffoldFile) error {
	existing := []string{tsmanifest.EntryFile, model.LockFileName}
	for _, f := range files {
		if path.Base(f.path) != ".gitkeep" && !contains(existing, f.path) {
			existing = append(existing, f.path)
		}
	}
	for _, name := range existing {
		if _, err := os.Stat(filepath.Join(root, name)); err == nil {
			echo("error: " + filepath.Join(root, name) + " already exists; refusing to overwrite.")
			return exitWith(1)
		}
	}
	for _, f := range files {
		target := filepath.Join(root, filepath.FromSlash(f.path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, f.content, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func initRepo(root string, configs bool) error {
	a := appCtx
	kind := "init"
	if configs {
		kind = "init-configs"
	}
	files, err := renderScaffold(kind, scaffoldVars{Hostname: a.DetectSystem().Machine})
	if err != nil {
		return err
	}
	if err := writeScaffold(root, files); err != nil {
		return err
	}
	example := "programs/cli.loadout.ts"
	parts := []string{"loadout.ts", "programs/", "maintenance/"}
	if configs {
		example = "loadouts/private_dot_config/.ripgrep.loadout.ts"
		parts = []string{"loadout.ts", "loadouts/ (chezmoi's source)"}
	}
	parts = append(parts, "machines/ (machines.loadout.ts, data.ts, state/)", "tsconfig.json")
	echo("Created " + root + ": " + strings.Join(parts, ", "))

	repo := git.New(a.Runner, root)
	isRepo, err := repo.IsRepo()
	if err != nil {
		return err
	}
	if isRepo {
		echo("Already inside a git repository; skipping git init.")
	} else {
		if err := repo.Init(); err != nil {
			return err
		}
		echo("Initialized git repository.")
	}

	echo("")
	echo(Style.Header("Next steps:"))
	echo("  1. Open " + root + " in your editor (bun install there gives it bun's types) and add")
	echo("     programs and scripts (*.loadout.ts files, beside " + example + ")")
	if configs {
		echo("     (a tool's file sits where its files land; what lands outside your home")
		echo("     in loadouts/.etc/<concern>/, like loadouts/.etc/dnf/)")
	}
	echo("  2. Say what this machine installs in machines/machines.loadout.ts")
	echo("  3. loadout --repo " + root + " compile   # writes " + model.LockFileName)
	if configs {
		echo("     (and loadouts/.chezmoidata/loadout.json + .chezmoitemplates/loadout/machine:")
		echo("     templates read this machine's data with includeTemplate \"loadout/machine\" . | fromJson)")
	}
	echo("  4. loadout --repo " + root + " status")
	echo("  5. Commit (the lock too), add a remote and push, then clone it on your other machines")
	return nil
}

// initChild scaffolds a child repo of the compiled repo at parentPath: its
// repo block names the parent, its machine uses the parent's names as they
// are, and it has no example program that could clash.
func initChild(root, parentPath, parentName string, configs bool) error {
	a := appCtx
	parentRoot := parentPath
	if !filepath.IsAbs(parentPath) {
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		parentRoot = filepath.Join(cwd, parentPath)
	}
	if _, err := os.Stat(filepath.Join(parentRoot, model.LockFileName)); err != nil {
		echo("error: parent " + parentPath + " has no " + model.LockFileName + " — compile it first")
		return exitWith(1)
	}
	kind := "child"
	if configs {
		kind = "child-configs"
	}
	hostname := a.DetectSystem().Machine
	childRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	parentImport, err := filepath.Rel(childRoot, parentRoot)
	if err != nil {
		parentImport = parentRoot
	}
	// The repo's parent path is read from the child's root: a relative one
	// given from here is rewritten from there.
	repoParentPath := parentPath
	if !filepath.IsAbs(parentPath) && parentPath != "~" && !strings.HasPrefix(parentPath, "~/") {
		repoParentPath = filepath.ToSlash(parentImport)
	}
	files, err := renderScaffold(kind, scaffoldVars{Hostname: hostname, ParentName: parentName, ParentPath: repoParentPath, ParentImport: filepath.ToSlash(parentImport)})
	if err != nil {
		return err
	}
	if err := writeScaffold(root, files); err != nil {
		return err
	}
	echo("Created " + root + ": a child repo of " + parentName + " (" + parentPath + ")")
	repo := git.New(a.Runner, root)
	isRepo, err := repo.IsRepo()
	if err != nil {
		return err
	}
	if !isRepo {
		if err := repo.Init(); err != nil {
			return err
		}
	}
	echo("")
	echo(Style.Header("Next steps:"))
	echo("  1. Say what this machine installs in machines/" + hostname + ".loadout.ts (import " + parentName + "'s from \"parent/…\")")
	echo("  2. loadout --repo " + root + " compile")
	echo("  3. Point LOADOUT_REPO at " + root + " on this machine, then: loadout status")
	return nil
}
