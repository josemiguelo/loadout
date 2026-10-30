package model

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"slices"
	"strconv"
)

// Lock is loadout.lock.json: a config repo's manifests, compiled. `loadout
// compile` writes it; the rest of the binary reads nothing else. It's
// generated, like state, but committed: a fresh machine needs only the
// binary and a clone.
type Lock struct {
	// Format is bumped only when an older binary could misread the file; see
	// LockFormat. Always written; 0 is written as LockFormat.
	Format int
	// ToolVersion is the loadout version that wrote it.
	ToolVersion string
	// Sources is the sha256 of the sources it was compiled from (SourcesHash).
	Sources  string
	Manifest Manifest
}

// LockFileName is the lock's file name, at the repo root.
const LockFileName = "loadout.lock.json"

// LockFormat is the lock layout this binary writes and reads.
const LockFormat = 1

// EncodeLock is the lock's text, as kotlinx wrote it: pretty-printed with a
// two-space indent, defaults (the model's) left out — keeping the lock short
// and its diffs about what changed — and a final newline.
func EncodeLock(lock Lock) string {
	format := lock.Format
	if format == 0 {
		format = LockFormat
	}
	var w objWriter
	w.any("format", format)
	w.str("toolVersion", lock.ToolVersion)
	w.str("sources", lock.Sources)
	w.any("manifest", lock.Manifest.toJSON())
	return PrettyJSON(w.obj) + "\n"
}

// DecodeLock is the lock in text. A newer format is refused by name before
// anything else is read, and checkToolVersion (when not nil) sees the
// writer's version before the body is decoded, so an old binary says
// "upgrade" instead of failing on a field a newer minor added. label names
// the file in messages (LockFileName when empty).
func DecodeLock(text, label string, checkToolVersion func(string) error) (Lock, error) {
	if label == "" {
		label = LockFileName
	}
	tree, err := lockHeader(text, label)
	if err != nil {
		return Lock{}, err
	}
	if checkToolVersion != nil {
		if v, ok := tree.Get("toolVersion"); ok {
			content, _, isPrimitive := primitive(v)
			if !isPrimitive {
				return Lock{}, notALock(label)
			}
			if v != nil {
				if err := checkToolVersion(content); err != nil {
					return Lock{}, err
				}
			}
		}
	}
	var derr error
	lock := readLock(tree, &derr)
	if derr != nil {
		return Lock{}, NewManifestException(fmt.Sprintf("%s can't be read (%s) — run: loadout compile", label, derr))
	}
	return lock, nil
}

func notALock(label string) error {
	return NewManifestException(label + " is not a lock file — run: loadout compile")
}

// lockHeader is text as a JSON object whose format this binary reads.
func lockHeader(text, label string) (JSONObject, error) {
	v, err := ParseJSON(text)
	if err != nil {
		return JSONObject{}, NewManifestException(fmt.Sprintf("%s is not valid JSON (%s) — run: loadout compile", label, err))
	}
	tree, ok := v.(JSONObject)
	if !ok {
		return JSONObject{}, notALock(label)
	}
	format := LockFormat
	if f, ok := tree.Get("format"); ok {
		content, _, isPrimitive := primitive(f)
		if !isPrimitive {
			return JSONObject{}, notALock(label)
		}
		n, err := strconv.Atoi(content)
		if err != nil {
			return JSONObject{}, notALock(label)
		}
		format = n
	}
	if format > LockFormat {
		return JSONObject{}, NewManifestException(fmt.Sprintf("%s was written by a newer loadout (lock format %d) — run: loadout self-upgrade", label, format))
	}
	return tree, nil
}

// SourcesHash is the sha256 over every file the globs match in repo (rooted
// at the repo root): each one's repo-relative path and content, in path
// order. The compile stamps it into the lock and the binary recomputes it,
// so an edit the lock hasn't seen is caught.
func SourcesHash(repo fs.FS, globs []string) (string, error) {
	var files []string
	for _, g := range globs {
		matched, err := GlobExpand(repo, g)
		if err != nil {
			return "", err
		}
		files = append(files, matched...)
	}
	files = distinct(files)
	slices.Sort(files)
	h := sha256.New()
	for _, file := range files {
		content, err := fs.ReadFile(repo, file)
		if err != nil {
			return "", err
		}
		h.Write([]byte(file))
		h.Write([]byte{0})
		h.Write(content)
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
