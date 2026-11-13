// Package bun keeps the bun a repo pins (`repo { bun = "…" }`): downloaded
// from bun's GitHub release on first use, checked against the release's
// SHASUMS256.txt, unpacked into $XDG_DATA_HOME/loadout/bun/<version>/. Every
// manifest command gets that folder first on PATH (exec.CommandFrame), so a
// `#!/usr/bin/env bun` script runs on a machine that has nothing installed
// yet, before any program could have installed bun.
package bun

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/cpu"

	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/platform"
)

// DownloadBaseVar overrides where releases come from: a folder (an https or
// file:// URL, anything curl reads) holding SHASUMS256.txt and the zips, for
// tests and mirrors. Default: bun's GitHub release of the version.
const DownloadBaseVar = "LOADOUT_BUN_DOWNLOAD_BASE"

const sumsFile = "SHASUMS256.txt"

// BinVar names a bun binary to use instead of any download (a CI runner's,
// the developer's): compile and every manifest command take it as it is.
const BinVar = "LOADOUT_BUN"

// DefaultVersion is the bun compile runs manifests with in a repo whose lock
// pins none yet (a first compile): the one this loadout was released with.
const DefaultVersion = "1.4.3"

// Home is where loadout keeps its buns: $XDG_DATA_HOME/loadout/bun, else
// ~/.local/share/loadout/bun.
func Home() (string, error) {
	if data, ok := platform.EnvVar("XDG_DATA_HOME"); ok && data != "" {
		return filepath.Join(data, "loadout", "bun"), nil
	}
	home, ok := platform.EnvVar("HOME")
	if !ok || home == "" {
		return "", errors.New("bun: HOME isn't set, so there's nowhere to keep it")
	}
	return filepath.Join(home, ".local", "share", "loadout", "bun"), nil
}

// Asset is the release zip for goos/goarch: bun-<os>-<arch>.zip, the
// -baseline build on x64 without AVX2 (bun's default build needs it).
func Asset(goos, goarch string, avx2 bool) (string, error) {
	var system, arch string
	switch goos {
	case "linux":
		system = "linux"
	case "darwin":
		system = "darwin"
	default:
		return "", errors.New("bun has no build for " + goos)
	}
	switch goarch {
	case "amd64":
		arch = "x64"
		if !avx2 {
			arch += "-baseline"
		}
	case "arm64":
		arch = "aarch64"
	default:
		return "", errors.New("bun has no build for " + goos + "/" + goarch)
	}
	return "bun-" + system + "-" + arch + ".zip", nil
}

// Ensure is the folder holding bun `version`'s binary, downloaded and
// unpacked the first time; afterwards a stat. Once it's in place, the other
// versions there go: a repo runs one bun.
func Ensure(runner exec.ProcessRunner, version string) (string, error) {
	if bin, ok := platform.EnvVar(BinVar); ok && bin != "" {
		if !isExecutable(bin) {
			return "", errors.New(BinVar + "=" + bin + " isn't an executable bun")
		}
		return filepath.Dir(bin), nil
	}
	home, err := Home()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, version)
	if isExecutable(filepath.Join(dir, "bun")) {
		return dir, nil
	}
	asset, err := Asset(runtime.GOOS, runtime.GOARCH, cpu.X86.HasAVX2)
	if err != nil {
		return "", err
	}
	base, ok := platform.EnvVar(DownloadBaseVar)
	if !ok || base == "" {
		base = "https://github.com/oven-sh/bun/releases/download/bun-v" + version
	}
	base = strings.TrimSuffix(base, "/")
	fail := func(why string) (string, error) {
		return "", errors.New("couldn't install bun " + version + ": " + why)
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		return fail(err.Error())
	}
	work, err := os.MkdirTemp(home, "."+version+"-")
	if err != nil {
		return fail(err.Error())
	}
	defer os.RemoveAll(work)

	sums, err := download(runner, base+"/"+sumsFile, filepath.Join(work, sumsFile))
	if err != nil {
		return fail(err.Error())
	}
	want, ok := SumOf(string(sums), asset)
	if !ok {
		return fail(sumsFile + " lists no " + asset)
	}
	archive, err := download(runner, base+"/"+asset, filepath.Join(work, asset))
	if err != nil {
		return fail(err.Error())
	}
	if got := sha256.Sum256(archive); hex.EncodeToString(got[:]) != want {
		return fail(asset + " doesn't match its checksum in " + sumsFile)
	}
	unpacked := filepath.Join(work, "unpacked")
	if err := Unpack(archive, unpacked); err != nil {
		return fail(asset + ": " + err.Error())
	}
	// Into place whole: a download cut short never looks installed. Another
	// loadout that got there first is as good.
	if err := os.Rename(unpacked, dir); err != nil && !isExecutable(filepath.Join(dir, "bun")) {
		return fail(err.Error())
	}
	Prune(home, version)
	return dir, nil
}

// download is url's content, fetched by curl into file.
func download(runner exec.ProcessRunner, url, file string) ([]byte, error) {
	result, err := runner.Capture(exec.Line("curl -fsSL --retry 2 -o "+quote(file)+" "+quote(url), ""))
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		why := strings.TrimSpace(result.Stderr)
		if why == "" {
			why = "curl exited " + strconv.Itoa(result.ExitCode)
		}
		return nil, errors.New(url + ": " + why)
	}
	return os.ReadFile(file)
}

var sumLine = regexp.MustCompile(`^([0-9a-f]{64})\s+\*?(\S+)$`)

// SumOf is asset's sha256 in a SHASUMS256.txt ("<hex>  <file>" per line).
func SumOf(sums, asset string) (string, bool) {
	for line := range strings.SplitSeq(sums, "\n") {
		if m := sumLine.FindStringSubmatch(strings.TrimSpace(line)); m != nil && m[2] == asset {
			return m[1], true
		}
	}
	return "", false
}

// Unpack writes the zip's `bun` binary (bun-<os>-<arch>/bun in a release)
// into dir as dir/bun, executable.
func Unpack(archive []byte, dir string) error {
	r, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return err
	}
	for _, f := range r.File {
		if f.FileInfo().IsDir() || path.Base(f.Name) != "bun" {
			continue
		}
		in, err := f.Open()
		if err != nil {
			return err
		}
		defer in.Close()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		out, err := os.OpenFile(filepath.Join(dir, "bun"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	}
	return errors.New("no bun binary in it")
}

// Prune removes every bun in home but keep's, and work folders a loadout
// left behind more than a day ago (a fresh one may be another loadout's,
// still downloading).
func Prune(home, keep string) {
	entries, err := os.ReadDir(home)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if name == keep || !e.IsDir() {
			continue
		}
		if strings.HasPrefix(name, ".") {
			info, err := e.Info()
			if err != nil || time.Since(info.ModTime()) < 24*time.Hour {
				continue
			}
		}
		_ = os.RemoveAll(filepath.Join(home, name))
	}
}

func isExecutable(file string) bool {
	info, err := os.Stat(file)
	return err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0
}

// quote is s as one sh word.
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
