package hclconf

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/version"
)

// KotlinRepoMessage refuses a loadout 3 repo: Kotlin manifests, no loadout.hcl.
const KotlinRepoMessage = "this repo's manifests are Kotlin; loadout 4 reads HCL"

// Compile is `loadout compile` for the repo at root: loadout.hcl and the
// files its `repo.sources` globs match, decoded (with a child repo's
// parent's, contract 18), assembled and checked, written to
// loadout.lock.json and, with configs, to the chezmoi data file and partial
// (contract 17) — each only when its content changed, and never outside
// root. The warnings (what no machine uses, transitional scripts every
// machine has done) come back without their "warning: " prefix, for the
// caller to print; they never stop the compile. The error is a refusal
// (model.Refusal): HCL's diagnostics (*DiagnosticsError, one line each) or a
// *model.ManifestException; or an I/O error.
func Compile(root string) ([]string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	if !isFile(filepath.Join(root, EntryFile)) {
		if isFile(filepath.Join(root, "loadout.kt")) || isFile(filepath.Join(root, "build.gradle.kts")) {
			return nil, model.NewManifestException(KotlinRepoMessage)
		}
		return nil, model.NewManifestException(root + " has no " + EntryFile + " — a config repo starts there (see: loadout init)")
	}
	repoFS := os.DirFS(root)
	entry, err := os.ReadFile(filepath.Join(root, EntryFile))
	if err != nil {
		return nil, err
	}
	sources, parentRef, err := readRepo(entry)
	if err != nil {
		return nil, err
	}
	globs := model.Distinct(append([]string{EntryFile}, sources...))
	files, err := readFiles(repoFS, globs, "")
	if err != nil {
		return nil, err
	}

	var parent *parentRepo
	if parentRef != nil {
		if parent, err = loadParent(*parentRef, root); err != nil {
			return nil, err
		}
	}
	var opts Options
	if parent != nil {
		opts.Parent = parent.decoded
	}
	decoded, err := Decode(files, opts)
	if err != nil {
		return nil, err
	}
	var draft assemble.ManifestDraft
	if parent == nil {
		draft, err = decoded.DraftOf()
	} else {
		draft, err = decoded.DraftOver(parent.decoded, parent.ref.Name)
	}
	if err != nil {
		return nil, err
	}
	draft.Manifest.Layout.Sources = globs
	var parentFS fs.FS
	if parent != nil {
		parentFS = parent.fs
		layout := parent.decoded.Draft.Manifest.Layout
		draft.Manifest.Layout.Parent = &model.ParentLayout{
			Name:    parent.ref.Name,
			Path:    parent.ref.Path,
			State:   layout.State,
			Configs: layout.Configs,
			Sources: parent.globs,
			Hash:    parent.hash,
		}
	}
	manifest, err := assemble.Assemble(draft, repoFS, parentFS)
	if err != nil {
		return nil, err
	}
	hash, err := model.SourcesHash(repoFS, globs)
	if err != nil {
		return nil, err
	}
	lock := model.Lock{ToolVersion: version.Version, Sources: hash, Manifest: manifest}
	if err := writeIfChanged(root, filepath.Join(root, model.LockFileName), model.EncodeLock(lock)); err != nil {
		return nil, err
	}
	// A repo with dotfiles gets their templates' data and partial beside them.
	if configs := manifest.Layout.Configs; configs != nil {
		for p, text := range model.ChezmoiDataFiles(manifest, *configs).All() {
			target := filepath.Join(root, filepath.FromSlash(p))
			if err := writeIfChanged(root, target, text); err != nil {
				return nil, err
			}
		}
	}

	// Warnings, not refusals: the lock is written either way. A parent's
	// declarations are the parent's compile's to judge.
	var inherited []string
	if parent != nil {
		inherited = assemble.DeclaredNames(parent.decoded.Draft)
	}
	warnings := UnusedWarnings(draft, manifest, decoded.Spares, inherited)
	if len(decoded.Transitional) > 0 {
		done := doneScripts(filepath.Join(root, filepath.FromSlash(manifest.Layout.State)), manifest.Machines.Keys())
		warnings = append(warnings, TransitionalWarnings(manifest, decoded.Transitional, done)...)
	}
	return warnings, nil
}

func isFile(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.Mode().IsRegular()
}

// readRepo is the entry file's `repo.sources` and `repo.parent`, read before
// anything else is: which files to decode, and against which parent. A
// mistake here is reported again, with everything else, by Decode.
func readRepo(src []byte) ([]string, *ParentRef, error) {
	file, diags := hclsyntax.ParseConfig(src, EntryFile, hcl.InitialPos)
	if diags.HasErrors() {
		return nil, nil, diagnosticsError(diags)
	}
	d := &decoder{ctx: &hcl.EvalContext{Functions: functions(), Variables: map[string]cty.Value{}}, out: &Decoded{}}
	for _, b := range file.Body.(*hclsyntax.Body).Blocks {
		if b.Type != "repo" {
			continue
		}
		d.out.Sources = d.strings(b.Body, "sources")
		for _, p := range b.Body.Blocks {
			if p.Type == "parent" && d.required(p, "name") && d.required(p, "path") {
				d.out.Parent = &ParentRef{Name: d.text(p.Body, "name"), Path: d.text(p.Body, "path")}
			}
		}
		break
	}
	if d.diags.HasErrors() {
		return nil, nil, diagnosticsError(d.diags)
	}
	return d.out.Sources, d.out.Parent, nil
}

// readFiles is every file globs match in repo, in glob order (each glob's
// matches path-sorted), repeats dropped. namePrefix, when set, is joined
// before each path in diagnostics (a parent's files are named where they
// are).
func readFiles(repo fs.FS, globs []string, namePrefix string) ([]File, error) {
	var paths []string
	for _, g := range globs {
		matched, err := model.GlobExpand(repo, g)
		if err != nil {
			return nil, err
		}
		paths = append(paths, matched...)
	}
	var files []File
	for _, p := range model.Distinct(paths) {
		src, err := fs.ReadFile(repo, p)
		if err != nil {
			return nil, err
		}
		f := File{Path: p, Src: src}
		if namePrefix != "" {
			f.Name = filepath.Join(namePrefix, filepath.FromSlash(p))
		}
		files = append(files, f)
	}
	return files, nil
}

// parentRepo is a child's parent, read: its checkout, the globs its own lock
// declares and their hash, and its declarations.
type parentRepo struct {
	ref     ParentRef
	fs      fs.FS
	globs   []string
	hash    string
	decoded *Decoded
}

// loadParent reads the parent of the child at childRoot. Its own lock must
// be current and have no parent of its own: the globs the child compiles
// came from it, so a stale one means an unknown file set.
func loadParent(ref ParentRef, childRoot string) (*parentRepo, error) {
	home := os.Getenv("HOME")
	root, err := model.ParentLayout{Name: ref.Name, Path: ref.Path}.Root(home, childRoot)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return nil, model.NewManifestException(fmt.Sprintf("parent %s (%s) names no directory — see repo.parent in %s", ref.Name, ref.Path, EntryFile))
	}
	lockPath := filepath.Join(root, model.LockFileName)
	text, err := os.ReadFile(lockPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, model.NewManifestException(fmt.Sprintf("parent %s (%s) has no %s — run: loadout compile there first", ref.Name, ref.Path, model.LockFileName))
	}
	if err != nil {
		return nil, err
	}
	lock, err := model.DecodeLock(string(text), "parent "+ref.Name+"'s "+model.LockFileName, nil)
	if err != nil {
		return nil, err
	}
	if lock.Manifest.Layout.Parent != nil {
		return nil, model.NewManifestException("parent " + ref.Name + " is itself a child: a parent can't have a parent")
	}
	if !isFile(filepath.Join(root, EntryFile)) {
		return nil, model.NewManifestException("parent " + ref.Name + ": " + KotlinRepoMessage)
	}
	parentFS := os.DirFS(root)
	globs := lock.Manifest.Layout.Sources
	hash, err := model.SourcesHash(parentFS, globs)
	if err != nil {
		return nil, err
	}
	if hash != lock.Sources {
		return nil, model.NewManifestException(fmt.Sprintf("parent %s: %s is older than its manifests — run: loadout compile there first", ref.Name, model.LockFileName))
	}
	files, err := readFiles(parentFS, globs, root)
	if err != nil {
		return nil, err
	}
	decoded, err := Decode(files, Options{AsParent: true})
	if err != nil {
		return nil, err
	}
	return &parentRepo{ref: ref, fs: parentFS, globs: globs, hash: hash, decoded: decoded}, nil
}

// doneScripts is each machine's scripts its state file says are done. A
// missing or unreadable file is a machine that has done nothing: never a
// reason to call a script finished.
func doneScripts(stateDir string, machines []string) map[string]map[string]bool {
	out := map[string]map[string]bool{}
	for _, machine := range machines {
		done := map[string]bool{}
		out[machine] = done
		text, err := os.ReadFile(filepath.Join(stateDir, machine+".json"))
		if err != nil {
			continue
		}
		var state struct {
			Scripts map[string]struct {
				Status any `json:"status"`
			} `json:"scripts"`
		}
		if json.Unmarshal(text, &state) != nil {
			continue
		}
		for name, s := range state.Scripts {
			if s.Status == "done" {
				done[name] = true
			}
		}
	}
	return out
}

// writeIfChanged writes text to target unless it already holds it: a
// compile that changed nothing shows nothing in git. Nothing lands outside
// root: a child's compile never writes into its parent (contract 18).
func writeIfChanged(root, target, text string) error {
	clean := filepath.Clean(target)
	if !strings.HasPrefix(clean, strings.TrimSuffix(filepath.Clean(root), string(filepath.Separator))+string(filepath.Separator)) {
		return fmt.Errorf("compile writes only under the repo root: %s", target)
	}
	if old, err := os.ReadFile(clean); err == nil && string(old) == text {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(clean), 0o755); err != nil {
		return err
	}
	return os.WriteFile(clean, []byte(text), 0o644)
}
