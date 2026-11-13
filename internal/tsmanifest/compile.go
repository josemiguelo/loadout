// Package tsmanifest is `loadout compile`: a repo's manifests are TypeScript,
// run by bun, and what loadout.ts prints (the draft) is assembled, checked
// and written to loadout.lock.json, which every other command reads.
package tsmanifest

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	osexec "os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/core/bun"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/version"
)

// EntryFile is a repo's root manifest: run by compile, it imports the rest.
const EntryFile = "loadout.ts"

// SDKFile is the SDK compile writes beside the entry (manifests import it as
// "loadout"): the one this binary reads drafts from, so a repo's types are
// always the loadout's that compiles it.
const SDKFile = "loadout.sdk.ts"

//go:embed sdk/loadout.sdk.ts
var SDK string

// ScriptSDKFile is the script SDK compile writes beside it (scripts import
// it as "loadout/script"): loadout's protocols for scripts in TypeScript (a
// managed script's check/install, an oracle's rows and update, the LOADOUT_*
// environment), as the binary that runs them speaks them.
const ScriptSDKFile = "loadout.script.ts"

//go:embed sdk/loadout.script.ts
var ScriptSDK string

// HCLRepoMessage refuses a repo still declared in HCL (loadout 4).
const HCLRepoMessage = "this repo's manifests are HCL; loadout 5 reads TypeScript (loadout.ts) — see the wiki's Writing-Your-Manifest"

// KotlinRepoMessage refuses a repo still declared in Kotlin (loadout 3).
const KotlinRepoMessage = "this repo's manifests are Kotlin; loadout 5 reads TypeScript (loadout.ts)"

// Draft is what loadout.ts prints: the manifest before assembly, and what
// only compile reads (the warnings' marks, the parent it names).
type Draft struct {
	assemble.ManifestDraft
	// Spares is what `spare: "reason"` marked, keyed as warnings name it.
	Spares model.Map[string]
	// Transitional is the scripts marked transitional, in declaration order.
	Transitional []string
	// Parent is the repo this one builds on (a child repo), nil for any other.
	Parent *ParentRef
}

// ParentRef is `repo({ parent })`: the parent's name in messages, and its checkout.
type ParentRef struct{ Name, Path string }

// Compile is `loadout compile` for the repo at root: loadout.ts run with
// bun (a child's parent too, contract 18), the draft assembled and checked,
// the lock (and with configs, the templates' data and partial) written when
// it changed. The warnings (what no machine uses, transitional scripts
// every machine has done) come back without their "warning: " prefix; they
// never stop a compile. The error is a refusal (model.Refusal) or I/O.
func Compile(root string, runner exec.ProcessRunner) ([]string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	if !isFile(filepath.Join(root, EntryFile)) {
		switch {
		case isFile(filepath.Join(root, "loadout.hcl")):
			return nil, model.NewManifestException(HCLRepoMessage)
		case isFile(filepath.Join(root, "loadout.kt")) || isFile(filepath.Join(root, "build.gradle.kts")):
			return nil, model.NewManifestException(KotlinRepoMessage)
		}
		return nil, model.NewManifestException(root + " has no " + EntryFile + " — a config repo starts there (see: loadout init)")
	}
	bunBin, err := bunFor(root, runner)
	if err != nil {
		return nil, err
	}
	for file, text := range map[string]string{SDKFile: SDK, ScriptSDKFile: ScriptSDK} {
		if err := writeIfChanged(root, filepath.Join(root, file), text); err != nil {
			return nil, err
		}
	}
	d, err := run(bunBin, root, false)
	if err != nil {
		return nil, err
	}
	draft := d.ManifestDraft
	var parentFS fs.FS
	var inherited []string
	if d.Parent != nil {
		parent, err := loadParent(bunBin, *d.Parent, root)
		if err != nil {
			return nil, err
		}
		over, errs := assemble.DraftOver(draft, parent.draft.ManifestDraft, d.Parent.Name)
		if len(errs) > 0 {
			return nil, assemble.Invalid(model.Distinct(errs))
		}
		draft = over
		layout := parent.draft.Manifest.Layout
		draft.Manifest.Layout.Parent = &model.ParentLayout{
			Name: d.Parent.Name, Path: d.Parent.Path, State: layout.State, Configs: layout.Configs,
			Sources: layout.Sources, Hash: parent.hash,
		}
		parentFS = parent.fs
		inherited = assemble.DeclaredNames(parent.draft.ManifestDraft)
	}
	repoFS := os.DirFS(root)
	manifest, err := assemble.Assemble(draft, repoFS, parentFS)
	if err != nil {
		return nil, err
	}
	hash, err := model.SourcesHash(repoFS, manifest.Layout.Sources)
	if err != nil {
		return nil, err
	}
	lock := model.Lock{ToolVersion: version.Version, Sources: hash, Manifest: manifest}
	if err := writeIfChanged(root, filepath.Join(root, model.LockFileName), model.EncodeLock(lock)); err != nil {
		return nil, err
	}
	if configs := manifest.Layout.Configs; configs != nil {
		for p, text := range model.ChezmoiDataFiles(manifest, *configs).All() {
			if err := writeIfChanged(root, filepath.Join(root, filepath.FromSlash(p)), text); err != nil {
				return nil, err
			}
		}
	}
	warnings := UnusedWarnings(draft, manifest, d.Spares, inherited)
	if len(d.Transitional) > 0 {
		done := doneScripts(filepath.Join(root, filepath.FromSlash(manifest.Layout.State)), manifest.Machines.Keys())
		warnings = append(warnings, TransitionalWarnings(manifest, d.Transitional, done)...)
	}
	return warnings, nil
}

// bunFor is the bun that runs root's manifests: $LOADOUT_BUN, else the one
// its lock pins (downloaded as for its scripts), else DefaultVersion.
func bunFor(root string, runner exec.ProcessRunner) (string, error) {
	version := bun.DefaultVersion
	if text, err := os.ReadFile(filepath.Join(root, model.LockFileName)); err == nil {
		if lock, err := model.DecodeLock(string(text), "", nil); err == nil && lock.Manifest.Meta.Bun != nil {
			version = *lock.Manifest.Meta.Bun
		}
	}
	dir, err := bun.Ensure(runner, version)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "bun"), nil
}

// run is the draft root's loadout.ts prints, run by bunBin with nothing of
// the caller's environment but PATH and HOME: a manifest's output must not
// depend on who compiles it. asParent marks every origin as the parent's.
func run(bunBin, root string, asParent bool) (Draft, error) {
	cmd := osexec.Command(bunBin, "run", EntryFile)
	cmd.Dir = root
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "LOADOUT_COMPILE=1"}
	if asParent {
		cmd.Env = append(cmd.Env, "LOADOUT_AS_PARENT=1")
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		why := strings.TrimSpace(stderr.String())
		if why == "" {
			why = err.Error()
		}
		if strings.Contains(why, `Cannot find module 'loadout'`) || strings.Contains(why, `Cannot find package 'loadout'`) {
			why += ` — tsconfig.json maps "loadout" to ./` + SDKFile + ` ("paths": {"loadout": ["./` + SDKFile + `"]})`
		}
		return Draft{}, model.NewManifestException(why)
	}
	if strings.TrimSpace(stdout.String()) == "" {
		return Draft{}, model.NewManifestException(EntryFile + " printed no manifest: it ends with repo({ ... })")
	}
	return decodeDraft(stdout.String())
}

// decodeDraft reads what the SDK's repo() prints.
func decodeDraft(text string) (Draft, error) {
	var extra struct {
		Spares       map[string]string `json:"spares"`
		Transitional []string          `json:"transitional"`
		Parent       *ParentRef        `json:"parent"`
	}
	if err := json.Unmarshal([]byte(text), &extra); err != nil {
		return Draft{}, model.NewManifestException(EntryFile + " printed something that isn't a manifest: " + err.Error())
	}
	m, profiles, requires, err := model.DecodeDraft(text)
	if err != nil {
		return Draft{}, model.NewManifestException(err.Error())
	}
	// What assembly's messages call each one ("machine 'm': …"), never in the lock.
	label := func(kind string) func(string, model.MachineConfig) model.MachineConfig {
		return func(name string, c model.MachineConfig) model.MachineConfig {
			c.Label = kind + " '" + name + "'"
			return c
		}
	}
	m.Machines = model.MapValues(m.Machines, label("machine"))
	profiles = model.MapValues(profiles, label("profile"))
	var spares model.Map[string]
	for _, k := range slices.Sorted(maps.Keys(extra.Spares)) {
		spares.Set(k, extra.Spares[k])
	}
	return Draft{
		ManifestDraft: assemble.ManifestDraft{Manifest: m, Profiles: profiles, Requires: requires},
		Spares:        spares,
		Transitional:  extra.Transitional,
		Parent:        extra.Parent,
	}, nil
}

// parentRepo is a child's parent, run: its checkout, its draft (every
// origin the parent's) and its sources' hash.
type parentRepo struct {
	fs    fs.FS
	hash  string
	draft Draft
}

// loadParent runs the parent of the child at childRoot. Its own lock must
// be current and have no parent of its own: the child's lock records the
// parent's sources as that lock names them.
func loadParent(bunBin string, ref ParentRef, childRoot string) (*parentRepo, error) {
	root, err := model.ParentLayout{Name: ref.Name, Path: ref.Path}.Root(os.Getenv("HOME"), childRoot)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return nil, model.NewManifestException(fmt.Sprintf("parent %s (%s) names no directory — see repo({ parent }) in %s", ref.Name, ref.Path, EntryFile))
	}
	text, err := os.ReadFile(filepath.Join(root, model.LockFileName))
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
		return nil, model.NewManifestException("parent " + ref.Name + ": " + HCLRepoMessage)
	}
	parentFS := os.DirFS(root)
	hash, err := model.SourcesHash(parentFS, lock.Manifest.Layout.Sources)
	if err != nil {
		return nil, err
	}
	if hash != lock.Sources {
		return nil, model.NewManifestException(fmt.Sprintf("parent %s: %s is older than its manifests — run: loadout compile there first", ref.Name, model.LockFileName))
	}
	d, err := run(bunBin, root, true)
	if err != nil {
		return nil, model.NewManifestException("parent " + ref.Name + ": " + err.Error())
	}
	return &parentRepo{fs: parentFS, hash: hash, draft: d}, nil
}

func isFile(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.Mode().IsRegular()
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
