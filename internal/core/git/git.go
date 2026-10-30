// Package git is the config repo's git, through the `git` binary.
package git

import (
	"fmt"
	"strings"

	"github.com/josemiguelo/loadout/internal/core/exec"
)

// GitException is a git command that failed.
type GitException struct{ Message string }

func (e *GitException) Error() string { return e.Message }

// Refusal marks it a refusal.
func (*GitException) Refusal() {}

// GitClient is a thin wrapper over the `git` binary, always operating on the config repo.
type GitClient struct {
	runner   exec.ProcessRunner
	repoRoot string
}

// New is the git of the repo at repoRoot.
func New(runner exec.ProcessRunner, repoRoot string) *GitClient { return &GitClient{runner, repoRoot} }

func (g *GitClient) git(args string) (exec.ExecResult, error) {
	return g.runner.Capture(exec.Line("git "+args, g.repoRoot))
}

func (g *GitClient) require(args, what string) error {
	result, err := g.git(args)
	if err != nil {
		return err
	}
	if !result.Success() {
		detail := strings.TrimSpace(result.Stderr)
		if detail == "" {
			detail = strings.TrimSpace(result.Stdout)
		}
		return &GitException{fmt.Sprintf("git %s failed (exit %d): %s", what, result.ExitCode, detail)}
	}
	return nil
}

// IsRepo says whether the repo root is inside a git work tree.
func (g *GitClient) IsRepo() (bool, error) {
	r, err := g.git("rev-parse --is-inside-work-tree")
	return r.Success(), err
}

// HasUpstream says whether the current branch tracks a remote one.
func (g *GitClient) HasUpstream() (bool, error) {
	r, err := g.git("rev-parse --abbrev-ref @{upstream}")
	return r.Success(), err
}

// Init makes the repo root a git repo.
func (g *GitClient) Init() error { return g.require("init", "init") }

// PullRebase pulls with a rebase, stashing local edits around it.
func (g *GitClient) PullRebase() error { return g.require("pull --rebase --autostash", "pull") }

// AddCommit stages paths and commits them; false when nothing changed.
func (g *GitClient) AddCommit(paths []string, message string) (bool, error) {
	for _, path := range paths {
		if err := g.require("add '"+path+"'", "add"); err != nil {
			return false, err
		}
	}
	quiet, err := g.git("diff --cached --quiet")
	if err != nil {
		return false, err
	}
	if quiet.Success() {
		return false, nil
	}
	if err := g.require("commit -m '"+strings.ReplaceAll(message, "'", `'\''`)+"'", "commit"); err != nil {
		return false, err
	}
	return true, nil
}

// Push pushes the current branch.
func (g *GitClient) Push() error { return g.require("push", "push") }
