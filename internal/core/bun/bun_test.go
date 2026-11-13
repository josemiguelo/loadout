package bun

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAssetIsBunsReleaseZipForTheOsAndArch(t *testing.T) {
	for _, c := range []struct {
		goos, goarch string
		avx2         bool
		want         string
	}{
		{"linux", "amd64", true, "bun-linux-x64.zip"},
		{"linux", "amd64", false, "bun-linux-x64-baseline.zip"},
		{"linux", "arm64", false, "bun-linux-aarch64.zip"},
		{"darwin", "arm64", false, "bun-darwin-aarch64.zip"},
		{"darwin", "amd64", true, "bun-darwin-x64.zip"},
	} {
		got, err := Asset(c.goos, c.goarch, c.avx2)
		if err != nil || got != c.want {
			t.Errorf("Asset(%s, %s, %v) = %q, %v; want %q", c.goos, c.goarch, c.avx2, got, err, c.want)
		}
	}
	if _, err := Asset("windows", "amd64", true); err == nil {
		t.Error("windows has a build")
	}
	if _, err := Asset("linux", "riscv64", true); err == nil {
		t.Error("riscv64 has a build")
	}
}

func TestSumOfReadsShasumsLines(t *testing.T) {
	a := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	b := "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
	sums := a + "  bun-linux-x64.zip\n" + b + "  bun-linux-x64-baseline.zip\n"
	if got, ok := SumOf(sums, "bun-linux-x64-baseline.zip"); !ok || got != b {
		t.Errorf("got %q, %v", got, ok)
	}
	if _, ok := SumOf(sums, "bun-darwin-x64.zip"); ok {
		t.Error("found an asset that isn't listed")
	}
}

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, content := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(content))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestUnpackWritesTheBinaryExecutable(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "out")
	archive := zipOf(t, map[string]string{"bun-linux-x64/": "", "bun-linux-x64/bun": "#!/bin/sh\n", "bun-linux-x64/LICENSE": "MIT"})
	if err := Unpack(archive, dir); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "bun"))
	if err != nil || info.Mode()&0o111 == 0 {
		t.Fatalf("not executable: %v %v", info, err)
	}
	if err := Unpack(zipOf(t, map[string]string{"x/README": ""}), t.TempDir()); err == nil {
		t.Error("unpacked a zip without bun")
	}
}

func TestPruneKeepsTheVersionInUseAndFreshWorkFolders(t *testing.T) {
	home := t.TempDir()
	for _, d := range []string{"1.2.0", "1.3.0", ".1.3.0-fresh", ".1.1.0-stale"} {
		os.MkdirAll(filepath.Join(home, d), 0o755)
	}
	old := time.Now().Add(-48 * time.Hour)
	os.Chtimes(filepath.Join(home, ".1.1.0-stale"), old, old)
	Prune(home, "1.3.0")
	entries, _ := os.ReadDir(home)
	var left []string
	for _, e := range entries {
		left = append(left, e.Name())
	}
	if len(left) != 2 || left[0] != ".1.3.0-fresh" || left[1] != "1.3.0" {
		t.Errorf("left %v", left)
	}
}
