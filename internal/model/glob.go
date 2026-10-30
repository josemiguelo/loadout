package model

import (
	"io/fs"
	"path"
	"slices"
	"strings"
)

// The manifest source globs (`repo { sources = […] }`), on `/`-separated
// paths relative to the repo root. `*` matches within one segment, `?` one
// character, `**` any number of segments. Wildcards never match a segment
// starting with `.`: a dot entry (`.loadout.hcl`, `.chezmoitemplates`)
// matches only when the pattern spells the dot. `.git` is never entered.

// GlobProblem is why pattern can't be a layout path or glob, or "" when it can.
func GlobProblem(pattern string) string {
	segments := strings.Split(pattern, "/")
	switch {
	case strings.TrimSpace(pattern) == "":
		return "is empty"
	case strings.HasPrefix(pattern, "/"):
		return "is absolute; layout paths are relative to the repo root"
	case slices.Contains(segments, ".."):
		return "leaves the repo (..)"
	case slices.Contains(segments, ""):
		return "has an empty path segment"
	}
	return ""
}

// GlobHasWildcard says whether pattern has a `*` or `?`.
func GlobHasWildcard(pattern string) bool { return strings.ContainsAny(pattern, "*?") }

// GlobMatches says whether pattern matches the repo-relative path.
func GlobMatches(pattern, p string) bool {
	return matchSegments(strings.Split(pattern, "/"), strings.Split(p, "/"))
}

// GlobExpand is the repo files pattern matches, path-sorted, as paths
// relative to repo's root. Symlinks are neither files nor folders here.
func GlobExpand(repo fs.FS, pattern string) ([]string, error) {
	segments := strings.Split(pattern, "/")
	n := 0
	for n < len(segments) && !GlobHasWildcard(segments[n]) {
		n++
	}
	base := "."
	if n > 0 {
		base = path.Join(segments[:n]...)
	}
	info, err := fs.Lstat(repo, base)
	if n == len(segments) {
		if err == nil && info.Mode().IsRegular() {
			return []string{base}, nil
		}
		return nil, nil
	}
	if err != nil || !info.IsDir() {
		return nil, nil
	}
	var files []string
	if err := walk(repo, base, &files); err != nil {
		return nil, err
	}
	var out []string
	for _, f := range files {
		if GlobMatches(pattern, f) {
			out = append(out, f)
		}
	}
	slices.Sort(out)
	return out, nil
}

func walk(repo fs.FS, dir string, out *[]string) error {
	entries, err := fs.ReadDir(repo, dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		child := path.Join(dir, e.Name())
		switch t := e.Type(); {
		case t.IsDir():
			if e.Name() != ".git" {
				if err := walk(repo, child, out); err != nil {
					return err
				}
			}
		case t.IsRegular():
			*out = append(*out, child)
		}
	}
	return nil
}

func matchSegments(pattern, p []string) bool {
	if len(pattern) == 0 {
		return len(p) == 0
	}
	head := pattern[0]
	if head == "**" {
		// Zero segments, or one more (never a dot entry) and try again.
		return matchSegments(pattern[1:], p) ||
			(len(p) > 0 && !strings.HasPrefix(p[0], ".") && matchSegments(pattern, p[1:]))
	}
	if len(p) == 0 {
		return false
	}
	return matchSegment(head, p[0]) && matchSegments(pattern[1:], p[1:])
}

func matchSegment(pattern, segment string) bool {
	if strings.HasPrefix(segment, ".") && !strings.HasPrefix(pattern, ".") {
		return false
	}
	return wildcard([]rune(pattern), []rune(segment))
}

// wildcard matches a whole segment: `*` any run of characters, `?` one.
func wildcard(pattern, s []rune) bool {
	if len(pattern) == 0 {
		return len(s) == 0
	}
	switch pattern[0] {
	case '*':
		for i := 0; i <= len(s); i++ {
			if wildcard(pattern[1:], s[i:]) {
				return true
			}
		}
		return false
	case '?':
		return len(s) > 0 && wildcard(pattern[1:], s[1:])
	}
	return len(s) > 0 && s[0] == pattern[0] && wildcard(pattern[1:], s[1:])
}
