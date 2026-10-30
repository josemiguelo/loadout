package app

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/platform"
	"github.com/josemiguelo/loadout/internal/version"
)

// Knows whether this binary is behind the latest published release. The one
// deliberate self-knowledge carve-out: loadout is infrastructure, not repo
// payload, so "can this machine keep participating?" is part of observing
// it. Lookups fail soft (offline -> "") and the cached form costs a file
// read, so `status` can afford it on every refresh.

const (
	selfAPI   = "https://api.github.com/repos/josemiguelo/loadout/releases/latest"
	selfCache = 6 * time.Hour
)

var tagName = regexp.MustCompile(`"tag_name": *"v([0-9][0-9.]*)"`)

// LatestRelease is the latest published release ("0.4.0"), or "" when
// unknown (offline and no cache). cached uses a ~6h on-disk cache;
// `outdated` passes false for a fresh answer.
func LatestRelease(runner exec.ProcessRunner, cached bool) string {
	cacheHome, ok := platform.EnvVar("XDG_CACHE_HOME")
	if !ok || cacheHome == "" {
		home, ok := platform.EnvVar("HOME")
		if !ok || home == "" {
			return ""
		}
		cacheHome = home + "/.cache"
	}
	cacheDir := cacheHome + "/loadout"
	cache := filepath.Join(cacheDir, "latest-release")
	// The cache is a file, so read it as one: no process per status.
	readCache := func() string {
		text, err := os.ReadFile(cache)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(text))
	}
	if cached {
		if info, err := os.Stat(cache); err == nil && time.Since(info.ModTime()) < selfCache {
			if v := readCache(); v != "" {
				return v
			}
		}
	}
	result, _ := runner.Capture(exec.Line("curl -fsSL --max-time 5 '"+selfAPI+"'", ""))
	match := tagName.FindStringSubmatch(result.Stdout)
	if match == nil {
		return readCache() // stale beats nothing when the API is unreachable
	}
	fetched := match[1]
	if os.MkdirAll(cacheDir, 0o755) == nil {
		_ = os.WriteFile(cache, []byte(fetched+"\n"), 0o644)
	}
	return fetched
}

// BehindRelease is the latest release this binary is behind, or "" when
// current or unknown.
func BehindRelease(runner exec.ProcessRunner, cached bool) string {
	latest := LatestRelease(runner, cached)
	if latest == "" || version.AtLeast(version.Version, latest) {
		return ""
	}
	return latest
}
