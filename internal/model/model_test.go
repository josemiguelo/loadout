package model

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

func read(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func decodeTestLock(t *testing.T) Lock {
	t.Helper()
	lock, err := DecodeLock(read(t, "loadout.lock.json"), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	return lock
}

// firstDiff points at where two texts part, for a readable failure.
func firstDiff(a, b string) string {
	i := 0
	for i < len(a) && i < len(b) && a[i] == b[i] {
		i++
	}
	from := max(0, i-80)
	return "at byte " + strconv.Itoa(i) + ":\n--- got\n" + a[from:min(len(a), i+80)] + "\n--- want\n" + b[from:min(len(b), i+80)]
}

func TestTheRealLockRoundTripsByteForByte(t *testing.T) {
	want := read(t, "loadout.lock.json")
	got := EncodeLock(decodeTestLock(t))
	if got != want {
		t.Fatalf("re-encoded lock differs %s", firstDiff(got, want))
	}
}

func TestChezmoiDataIsByteIdentical(t *testing.T) {
	lock := decodeTestLock(t)
	if got, want := RenderChezmoiData(lock.Manifest), read(t, "chezmoidata.json"); got != want {
		t.Fatalf("chezmoi data differs %s", firstDiff(got, want))
	}
	if want := read(t, "machine.partial"); ChezmoiPartial != want {
		t.Fatalf("partial differs %s", firstDiff(ChezmoiPartial, want))
	}
	files := ChezmoiDataFiles(lock.Manifest, "loadouts")
	if got := files.Keys(); len(got) != 2 || got[0] != "loadouts/.chezmoidata/loadout.json" ||
		got[1] != "loadouts/.chezmoitemplates/loadout/machine" {
		t.Fatalf("files = %v", got)
	}
}

func TestDecodedLockReadsTheModel(t *testing.T) {
	m := decodeTestLock(t).Manifest
	if m.Meta.Name != "jm's machines" || *m.Meta.MinToolVersion != "3.4.0" {
		t.Fatalf("meta = %+v", m.Meta)
	}
	if m.Layout.State != "machines/state" || *m.Layout.Configs != "loadouts" {
		t.Fatalf("layout = %+v", m.Layout)
	}
	brew := m.Installers.Value("brew")
	if *brew.Probe != "brew" || len(brew.Requires) != 1 || brew.Requires[0] != "setup-brew" {
		t.Fatalf("brew = %+v", brew)
	}
	if m.Machines.IsEmpty() || m.Data.IsEmpty() {
		t.Fatal("machines or data missing")
	}
}

func TestTheLockRoundTrips(t *testing.T) {
	m := Manifest{
		Layout:   RepoLayout{State: "state"},
		Programs: MapOf(E("jq", Program{Install: MapOf(E("brew", InstallVariant{}))})),
		Scripts: MapOf(
			E("a", ScriptStep{Run: Ptr("true")}),
			E("b", ScriptStep{Run: Ptr("x\n\"y\"\x01"), Modes: []string{}}),
			E("c", ScriptStep{Run: Ptr("<&>"), Modes: []string{"setup"}}),
		),
		Machines: MapOf(E("m", MachineConfig{PM: MapOf(E("jq", "brew"))})),
	}
	text := EncodeLock(Lock{ToolVersion: "3.0.0", Sources: "abc", Manifest: m})
	lock, err := DecodeLock(text, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if again := EncodeLock(lock); again != text {
		t.Fatalf("round trip differs %s", firstDiff(again, text))
	}
	if lock.Format != 1 || lock.ToolVersion != "3.0.0" || lock.Sources != "abc" {
		t.Fatalf("header = %+v", lock)
	}
	if s := lock.Manifest.Scripts.Value("b"); s.Modes == nil || len(s.Modes) != 0 {
		t.Fatalf("empty modes = %#v", s.Modes)
	}
	if !lock.Manifest.Scripts.Value("a").RunsIn("maintain") {
		t.Fatal("default modes lost")
	}
	for _, want := range []string{`"format": 1,`, `"run": "x\n\"y\"\u0001"`, `"run": "<&>"`, `"modes": []`, `"brew": {}`} {
		if !strings.Contains(text, want) {
			t.Errorf("%s not in\n%s", want, text)
		}
	}
	if strings.Count(text, `"modes"`) != 2 {
		t.Errorf("default modes written:\n%s", text)
	}
}

func TestANewerLockFormatIsRefusedByName(t *testing.T) {
	_, err := DecodeLock(`{"format": 99, "toolVersion": "9.0.0", "sources": "", "manifest": {}}`, "", nil)
	var refusal *ManifestException
	if !asManifest(err, &refusal) || !strings.Contains(refusal.Message, "newer loadout") {
		t.Fatalf("err = %v", err)
	}
	if want := "loadout.lock.json was written by a newer loadout (lock format 99) — run: loadout self-upgrade"; err.Error() != want {
		t.Fatalf("err = %q", err)
	}
}

func TestTheToolVersionIsCheckedBeforeTheBody(t *testing.T) {
	var seen string
	_, err := DecodeLock(`{"toolVersion": "9.0.0", "sources": "", "manifest": {"future": 1}}`, "x.json", func(v string) error {
		seen = v
		return &ToolTooOldException{Message: "too old", Required: v}
	})
	if seen != "9.0.0" || err == nil || err.Error() != "too old" {
		t.Fatalf("seen %q, err %v", seen, err)
	}
	_, err = DecodeLock(`{"toolVersion": "9.0.0", "sources": "", "manifest": {"future": 1}}`, "x.json", nil)
	if err == nil || !strings.HasPrefix(err.Error(), "x.json can't be read (Encountered an unknown key 'future'") ||
		!strings.HasSuffix(err.Error(), "— run: loadout compile") {
		t.Fatalf("err = %v", err)
	}
}

func TestAnUnreadableLockSaysSo(t *testing.T) {
	cases := map[string]string{
		`{`:                               "loadout.lock.json is not valid JSON (",
		`[]`:                              "loadout.lock.json is not a lock file — run: loadout compile",
		`{"sources": "", "manifest": {}}`: "loadout.lock.json can't be read (Field 'toolVersion' is required",
	}
	for text, want := range cases {
		_, err := DecodeLock(text, "", nil)
		if err == nil || !strings.HasPrefix(err.Error(), want) {
			t.Errorf("%s: err = %v, want %q…", text, err, want)
		}
		if _, ok := err.(Refusal); !ok {
			t.Errorf("%s: %T is not a Refusal", text, err)
		}
	}
}

func asManifest(err error, target **ManifestException) bool {
	e, ok := err.(*ManifestException)
	*target = e
	return ok
}

func TestSourcesHashCoversPathAndContentInPathOrder(t *testing.T) {
	repo := fstest.MapFS{
		"loadout.hcl":          {Data: []byte("repo {}\n")},
		"b/x.loadout.hcl":      {Data: []byte("b")},
		"a/.y.loadout.hcl":     {Data: []byte("a")},
		"a/z.txt":              {Data: []byte("no")},
		".git/q.loadout.hcl":   {Data: []byte("no")},
		"a/.git/q.loadout.hcl": {Data: []byte("no")},
		"a/deep/w.loadout.hcl": {Data: []byte("w")},
	}
	got, err := SourcesHash(repo, []string{"loadout.hcl", "**/*.loadout.hcl", "a/**/.*.loadout.hcl", "loadout.hcl"})
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.New()
	for _, f := range []string{"a/.y.loadout.hcl", "a/deep/w.loadout.hcl", "b/x.loadout.hcl", "loadout.hcl"} {
		h.Write([]byte(f + "\x00" + string(repo[f].Data) + "\x00"))
	}
	if want := hex.EncodeToString(h.Sum(nil)); got != want {
		t.Fatalf("hash = %s, want %s", got, want)
	}
	empty, _ := SourcesHash(repo, nil)
	if empty != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("empty = %s", empty)
	}
}

func TestMatchingFollowsTheSourceRules(t *testing.T) {
	yes := [][2]string{
		{"programs/**/*.loadout.kt", "programs/a.loadout.kt"},
		{"programs/**/*.loadout.kt", "programs/x/y/a.loadout.kt"},
		{"programs/?.kt", "programs/a.kt"},
		{"configs/**/.loadout.kt", "configs/private_dot_config/tmux/.loadout.kt"},
		{"configs/**/.*/.*.loadout.kt", "configs/a/.t/.t.loadout.kt"},
		{"configs/**/.*/.*.loadout.kt", "configs/.t/.t.loadout.kt"},
	}
	no := [][2]string{
		{"programs/**/*.loadout.kt", "programs/a.loadout.kt.sample"},
		{"programs/*.kt", "programs/x/a.kt"},
		// Wildcards never match a dot entry; spelling the dot does.
		{"programs/*.kt", "programs/.hidden.kt"},
		{"configs/**/*.loadout.kt", "configs/tmux/.loadout.kt"},
		{"**/*.kt", ".git/x.kt"},
		// ** never enters a dot folder; a manifest in one needs a glob that spells it.
		{"configs/**/.*.loadout.kt", "configs/a/.t/.t.loadout.kt"},
		{"configs/**/.*/.*.loadout.kt", "configs/a/.t/.loadout/.x.loadout.kt"},
		{"configs/**/.*/.*.loadout.kt", "configs/a/.t/.loadout/x.loadout.kt"},
	}
	for _, c := range yes {
		if !GlobMatches(c[0], c[1]) {
			t.Errorf("%s should match %s", c[0], c[1])
		}
	}
	for _, c := range no {
		if GlobMatches(c[0], c[1]) {
			t.Errorf("%s should not match %s", c[0], c[1])
		}
	}
}

func TestExpandIsPathSortedAndNeverEntersGit(t *testing.T) {
	repo := fstest.MapFS{}
	for _, f := range []string{"programs/b.loadout.kt", "programs/a/z.loadout.kt", "programs/a.loadout.kt", ".git/c.loadout.kt"} {
		repo[f] = &fstest.MapFile{}
	}
	got, err := GlobExpand(repo, "programs/**/*.loadout.kt")
	if err != nil {
		t.Fatal(err)
	}
	if want := "programs/a.loadout.kt programs/a/z.loadout.kt programs/b.loadout.kt"; strings.Join(got, " ") != want {
		t.Fatalf("got %v", got)
	}
	// A literal path is that file or nothing; a missing base is nothing.
	if got, _ := GlobExpand(repo, "programs/a.loadout.kt"); len(got) != 1 {
		t.Fatalf("literal = %v", got)
	}
	if got, _ := GlobExpand(repo, "nowhere/**/*.kt"); len(got) != 0 {
		t.Fatalf("missing = %v", got)
	}
}

func TestProblemsNameWhatsWrong(t *testing.T) {
	cases := map[string]string{
		"programs/**/*.kt": "",
		"/etc":             "is absolute; layout paths are relative to the repo root",
		"../x":             "leaves the repo (..)",
		"a//b":             "has an empty path segment",
		"":                 "is empty",
	}
	for pattern, want := range cases {
		if got := GlobProblem(pattern); got != want {
			t.Errorf("GlobProblem(%q) = %q, want %q", pattern, got, want)
		}
	}
}

func TestAScriptEntrysWhitespaceBecomesSingleSpaces(t *testing.T) {
	if name, args := ScriptEntry("  name\n\ta \n  b  "); name != "name" || args != "a b" {
		t.Fatalf("got %q %q", name, args)
	}
}

func TestShellLineExpandsFileAndPutsPathFirst(t *testing.T) {
	if got := ShellLine("file:x.sh check \"$@\"", nil); got != `sh 'x.sh' check "$@"` {
		t.Fatalf("got %s", got)
	}
	if got := ShellLine("file:x.sh", []string{"$HOME/.local/bin", "/opt/b"}); got != `PATH="$HOME/.local/bin:/opt/b:$PATH"; export PATH; sh 'x.sh'` {
		t.Fatalf("got %s", got)
	}
	if got := ExpandFilePrefix("echo hi"); got != "echo hi" {
		t.Fatalf("got %s", got)
	}
}

func TestDataMergesTablesAndReplacesTheRest(t *testing.T) {
	base := MapOf[any](E[any]("a", true), E[any]("k", MapOf[any](E[any]("x", "1"), E[any]("y", "2"))), E[any]("l", []any{"a"}))
	over := MapOf[any](E[any]("k", MapOf[any](E[any]("y", "3"))), E[any]("l", []any{"b"}), E[any]("n", KotlinDouble(1)))
	if got := JSONString(MergeData(base, over)); got != `{"a":true,"k":{"x":"1","y":"3"},"l":["b"],"n":1.0}` {
		t.Fatalf("got %s", got)
	}
	if got := DataConflicts(base, over, ""); strings.Join(got, ",") != "k.y,l" {
		t.Fatalf("conflicts %v", got)
	}
	errs := ValidateData(base, MapOf[any](E[any]("a", "yes"), E[any]("k", MapOf[any](E[any]("z", "1")))), "machine 'm'", "")
	want := []string{
		"machine 'm': data key 'a' is a string, but the data schema declares a boolean",
		"machine 'm': data key 'k.z' is not declared in the data schema",
	}
	if strings.Join(errs, "|") != strings.Join(want, "|") {
		t.Fatalf("errors %v", errs)
	}
}

func TestKotlinDoublesReadAsKotlinWritesThem(t *testing.T) {
	for f, want := range map[float64]string{0.85: "0.85", 1: "1.0", 0: "0.0", 1e7: "1.0E7", 1.5e-4: "1.5E-4", -2.5: "-2.5", 123456.0: "123456.0"} {
		if got := string(KotlinDouble(f)); got != want {
			t.Errorf("KotlinDouble(%v) = %s, want %s", f, got, want)
		}
	}
}

func TestAMachineSeesItsScriptVariantAndToolPaths(t *testing.T) {
	m := Manifest{
		Programs: MapOf(E("setup-brew", Program{Install: MapOf(E("linux", InstallVariant{
			Command:  Ptr("x"),
			Provides: []Provides{{Binary: "brew", At: Ptr("/home/linuxbrew/.linuxbrew/bin")}, {Binary: "flatpak"}},
		}))})),
		Installers: MapOf(E("brew", Installer{Probe: Ptr("brew"), Install: Ptr("brew install {pkg}"), Upgrade: Ptr("brew upgrade")})),
		Scripts: MapOf(E("keyboard", ScriptStep{
			Description: "fn swap", Sudo: true, Check: Ptr("base-check"), After: []string{"programs.setup-brew"},
			Variants: MapOf(
				E("arch", ScriptStep{File: Ptr("arch.sh"), After: []string{"scripts.x", "programs.setup-brew"}, Origin: "k"}),
				E("fedora", ScriptStep{File: Ptr("fedora.sh")}),
			),
		})),
		Machines: MapOf(E("m", MachineConfig{
			PM:             MapOf(E("setup-brew", "linux")),
			Scripts:        []string{"keyboard"},
			ScriptVariants: MapOf(E("keyboard", "arch")),
		})),
	}
	seen := m.ForMachine("m")
	step := seen.Scripts.Value("keyboard")
	if *step.File != "arch.sh" || !step.Sudo || step.Description != "fn swap" || *step.Check != "base-check" ||
		strings.Join(step.After, ",") != "programs.setup-brew,scripts.x" || step.Origin != "k" || !step.Variants.IsEmpty() {
		t.Fatalf("step = %+v", step)
	}
	if got := seen.ToolPathOf("brew"); len(got) != 1 || got[0] != "/home/linuxbrew/.linuxbrew/bin" {
		t.Fatalf("tool path = %v", got)
	}
	if _, ok := seen.ToolPaths["flatpak"]; ok {
		t.Fatal("a binary without `at` has no tool path")
	}
	if m.Scripts.Value("keyboard").File != nil {
		t.Fatal("ForMachine changed the manifest it was called on")
	}
}

func TestParentRootPlacesItsCheckout(t *testing.T) {
	for p, want := range map[string]string{"~/dots": "/home/u/dots", "~": "/home/u", "/abs/./x": "/abs/x", "../dots": "/work/dots"} {
		got, err := ParentLayout{Name: "dotfiles", Path: p}.Root("/home/u/", "/work/child")
		if err != nil || got != want {
			t.Errorf("Root(%s) = %s, %v; want %s", p, got, err, want)
		}
	}
	if _, err := (ParentLayout{Name: "dotfiles", Path: "~/x"}).Root("", "/c"); err == nil ||
		err.Error() != "HOME is unset: can't place parent dotfiles at ~/x" {
		t.Fatalf("err = %v", err)
	}
}
