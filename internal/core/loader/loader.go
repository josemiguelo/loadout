// Package loader reads a config repo's lock: the
// only manifest the binary knows.
package loader

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/version"
)

// The manifests themselves are HCL, compiled by `loadout compile`; the lock
// is refused when it's missing, written by a newer loadout, below the
// repo's version floor, or older than the sources it was compiled from, and
// so is a repo whose chezmoi data or partial (model.ChezmoiDataFiles)
// doesn't match it. home is $HOME ("" when unset), for a parent at `~/…`.

// ReadLayout is the repo's layout, from the lock alone (no staleness or file checks).
func ReadLayout(repoRoot string) (model.RepoLayout, error) {
	lock, err := readLock(repoRoot)
	if err != nil {
		return model.RepoLayout{}, err
	}
	return lock.Manifest.Layout, nil
}

// LoadRepo is the repo's manifest, checked: the lock is current with its
// sources and every `file:` path it names exists. Machines see their own
// script variants through model.Manifest.ForMachine.
func LoadRepo(repoRoot, home string) (model.Manifest, error) {
	lock, err := readLock(repoRoot)
	if err != nil {
		return model.Manifest{}, err
	}
	manifest := lock.Manifest
	hash, err := model.SourcesHash(os.DirFS(repoRoot), manifest.Layout.Sources)
	if err != nil {
		return model.Manifest{}, err
	}
	if hash != lock.Sources {
		return model.Manifest{}, model.NewManifestException("the manifests changed since " + model.LockFileName + " was written — run: loadout compile")
	}
	// A child's lock holds its parent's declarations as they were: a parent
	// edit it hasn't seen is refused the same way (contract 18).
	parentRoot, err := ParentRoot(repoRoot, manifest.Layout, home)
	if err != nil {
		return model.Manifest{}, err
	}
	var parentFS fs.FS
	if parent := manifest.Layout.Parent; parent != nil {
		parentFS = os.DirFS(parentRoot)
		hash, err := model.SourcesHash(parentFS, parent.Sources)
		if err != nil {
			return model.Manifest{}, err
		}
		if hash != parent.Hash {
			return model.Manifest{}, model.NewManifestException(
				"parent " + parent.Name + ": the manifests changed since " + model.LockFileName + " was written — run: loadout compile")
		}
	}
	if configs := manifest.Layout.Configs; configs != nil {
		for path, expected := range model.ChezmoiDataFiles(manifest, *configs).All() {
			current, err := os.ReadFile(filepath.Join(repoRoot, path))
			if err != nil || string(current) != expected {
				what := "doesn't match " + model.LockFileName
				if err != nil {
					what = "is missing"
				}
				return model.Manifest{}, model.NewManifestException(path + " " + what + " — run: loadout compile")
			}
		}
	}
	if missing := assemble.CheckFiles(manifest, os.DirFS(repoRoot), parentFS); len(missing) > 0 {
		return model.Manifest{}, assemble.Invalid(missing)
	}
	return manifest, nil
}

// ParentRoot is a child repo's parent checkout, canonical; "" for a repo
// without a parent. One that isn't there is refused by name and path.
func ParentRoot(repoRoot string, layout model.RepoLayout, home string) (string, error) {
	parent := layout.Parent
	if parent == nil {
		return "", nil
	}
	root, err := parent.Root(home, repoRoot)
	if err != nil {
		return "", err
	}
	missing := func() error {
		return model.NewManifestException("parent " + parent.Name + " is not at " + parent.Path +
			" — clone it there, or change the parent block's path in loadout.hcl and compile")
	}
	if _, err := os.Stat(root); err != nil {
		return "", missing()
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", missing()
	}
	return filepath.Abs(canonical)
}

// ParentChanged says whether a child repo's parent's manifests changed
// since the child's lock was written: `sync` recompiles the child then.
// False for a repo without a parent.
func ParentChanged(repoRoot, home string) (bool, error) {
	layout, err := ReadLayout(repoRoot)
	if err != nil {
		return false, err
	}
	parent := layout.Parent
	if parent == nil {
		return false, nil
	}
	root, err := ParentRoot(repoRoot, layout, home)
	if err != nil {
		return false, err
	}
	hash, err := model.SourcesHash(os.DirFS(root), parent.Sources)
	if err != nil {
		return false, err
	}
	return hash != parent.Hash, nil
}

// ToolTooOld says whether this binary is too old for the repo's lock; read alone, like ReadLayout.
func ToolTooOld(repoRoot string) bool {
	_, err := readLock(repoRoot)
	var tooOld *model.ToolTooOldException
	return errors.As(err, &tooOld)
}

func readLock(repoRoot string) (model.Lock, error) {
	path := filepath.Join(repoRoot, model.LockFileName)
	text, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return model.Lock{}, model.NewManifestException("no " + model.LockFileName + " in " + repoRoot + " — run: loadout compile")
		}
		return model.Lock{}, err
	}
	// A newer minor may write what this binary would misread (a field it
	// doesn't know), so its version is checked before the body is read; a
	// patch release never changes what a lock means.
	lock, err := model.DecodeLock(string(text), "", func(toolVersion string) error {
		if !version.AtLeast(minor(version.Version), minor(toolVersion)) {
			return &model.ToolTooOldException{
				Message: model.LockFileName + " was compiled by loadout " + toolVersion + " (you have " + version.Version + ") — " +
					"run: loadout self-upgrade",
				Required: minor(toolVersion) + ".0",
			}
		}
		return nil
	})
	if err != nil {
		return model.Lock{}, err
	}
	if required := lock.Manifest.Meta.MinToolVersion; required != nil && !version.AtLeast(version.Version, *required) {
		return model.Lock{}, &model.ToolTooOldException{
			Message: "this config repo requires loadout >= " + *required + " (you have " + version.Version + ") — " +
				"run: loadout self-upgrade",
			Required: *required,
		}
	}
	return lock, nil
}

func minor(v string) string {
	parts := strings.Split(v, ".")
	return strings.Join(parts[:min(2, len(parts))], ".")
}
