package exec

import (
	"maps"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/model"
)

// CommandFrame is how manifest commands run (contract 5): in the directory
// of the file that declared them (its repo-relative origin), with the
// `LOADOUT_*` variables. In a child repo (contract 18) a parent's
// declaration (model.OriginParent) runs in the parent's checkout with the
// parent's `LOADOUT_REPO` and `LOADOUT_CONFIGS`, as it would in the parent
// itself. A frame without a repo root (unit tests) runs in the caller's
// directory with only the variables it was given.
type CommandFrame struct {
	// repoRoot is the absolute repo root, or "" for "the caller's directory".
	repoRoot string
	env      map[string]string
	// parent is a child repo's parent: where its declarations run, and what they see instead of env.
	parent *FrameParent
}

// FrameParent is a child repo's parent checkout and its commands' variables.
type FrameParent struct {
	Root string
	Env  map[string]string
}

// NewCommandFrame is a frame over repoRoot ("" = the caller's directory)
// with env, and parent for a child repo (nil otherwise).
func NewCommandFrame(repoRoot string, env map[string]string, parent *FrameParent) CommandFrame {
	return CommandFrame{repoRoot, env, parent}
}

// Cwd is where a command of origin runs, or "" for the caller's directory.
func (f CommandFrame) Cwd(origin string) string {
	root := f.repoRoot
	if model.IsParentOrigin(origin) && f.parent != nil {
		root = f.parent.Root
	}
	if root == "" {
		return ""
	}
	folder := model.OriginFolder(origin)
	if folder == "" {
		return root
	}
	return root + "/" + folder
}

// Command is line, declared at origin, in this frame.
func (f CommandFrame) Command(line, origin string) ShellCommand {
	cwd := f.Cwd(origin)
	vars := f.env
	if model.IsParentOrigin(origin) && f.parent != nil {
		vars = f.parent.Env
	}
	env := maps.Clone(vars)
	if cwd != "" {
		if env == nil {
			env = map[string]string{}
		}
		env["LOADOUT_FRAGMENT_DIR"] = cwd
	}
	return ShellCommand{Line: line, Cwd: cwd, Env: env}
}

// FrameOf is the frame for system in the repo at absolute repoRoot, with its
// `layout configs` (nil: none); for a child repo, also its parent's absolute
// parentRoot ("" for none) and configs.
func FrameOf(repoRoot string, system coremodel.SystemInfo, configs *string, parentRoot string, parentConfigs *string) CommandFrame {
	common := map[string]string{
		"LOADOUT_MACHINE": system.Machine,
		"LOADOUT_OS":      string(system.Os),
	}
	// Every command of a child sees its parent: a parent program's `file`
	// value runs in whichever repo's installer takes it.
	if parentRoot != "" {
		common["LOADOUT_PARENT"] = parentRoot
	}
	repoEnv := func(root string, configs *string) map[string]string {
		env := maps.Clone(common)
		env["LOADOUT_REPO"] = root
		if configs != nil {
			env["LOADOUT_CONFIGS"] = root + "/" + *configs
		}
		return env
	}
	var parent *FrameParent
	if parentRoot != "" {
		parent = &FrameParent{parentRoot, repoEnv(parentRoot, parentConfigs)}
	}
	return CommandFrame{repoRoot, repoEnv(repoRoot, configs), parent}
}
