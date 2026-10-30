package state

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/model"
)

func s(v string) *string { return &v }

func sampleState(machine string, rgVersion *string) coremodel.MachineState {
	rg := coremodel.ProgramState{Status: coremodel.Missing}
	if rgVersion != nil {
		rg = coremodel.ProgramState{Status: coremodel.Installed, Version: rgVersion}
	}
	return coremodel.MachineState{
		Machine: machine, Os: "linux", Distro: s("fedora"), Arch: "x86_64", ToolVersion: "0.1.0",
		UpdatedAt: "2026-08-14T12:00:00Z",
		Programs:  model.MapOf(model.E("ripgrep", rg)),
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func write(t *testing.T, store *StateStore, state coremodel.MachineState) {
	t.Helper()
	if err := store.Write(state); err != nil {
		t.Fatal(err)
	}
}

func TestRoundTripsState(t *testing.T) {
	store := NewStateStore(t.TempDir(), "state", false)
	write(t, store, sampleState("laptop", s("14.1.0")))
	loaded := store.Read("laptop")
	if loaded == nil || !loaded.Equal(sampleState("laptop", s("14.1.0"))) {
		t.Errorf("%+v", loaded)
	}
	if store.Read("ghost") != nil {
		t.Error("ghost")
	}
}

func TestAKotlinWrittenStateFileReadsAndWritesBackByteForByte(t *testing.T) {
	text := read(t, "testdata/machine.json")
	state, err := Decode(text)
	if err != nil {
		t.Fatal(err)
	}
	if got := Encode(state); got != text {
		t.Errorf("not byte-identical:\n%s", got[:min(len(got), 400)])
	}
}

func TestAParentsStoreIsReadNeverWritten(t *testing.T) {
	root := t.TempDir()
	write(t, NewStateStore(root, "state", false), sampleState("laptop", s("14.1.0")))
	parent := NewStateStore(root, "state", true)
	if keys := parent.ReadAll().Keys(); len(keys) != 1 || keys[0] != "laptop" {
		t.Errorf("%v", keys)
	}
	if err := parent.Write(sampleState("work", s("14.1.0"))); err == nil {
		t.Error("wrote the parent's state")
	}
	entries, _ := os.ReadDir(filepath.Join(root, "state"))
	if len(entries) != 1 || entries[0].Name() != "laptop.json" {
		t.Errorf("%v", entries)
	}
}

func TestReadAllReturnsAllMachines(t *testing.T) {
	store := NewStateStore(t.TempDir(), "state", false)
	write(t, store, sampleState("laptop", s("14.1.0")))
	write(t, store, sampleState("desktop", nil))
	all := store.ReadAll()
	if keys := all.Keys(); len(keys) != 2 || keys[0] != "desktop" || keys[1] != "laptop" {
		t.Errorf("%v", keys)
	}
	if st := all.Value("desktop").Programs.Value("ripgrep").Status; st != coremodel.Missing {
		t.Error(st)
	}
}

func TestReadAllOnEmptyRepoIsEmpty(t *testing.T) {
	store := NewStateStore(t.TempDir(), "state", false)
	if !store.ReadAll().IsEmpty() || len(store.LastWarnings()) != 0 {
		t.Error("not empty")
	}
}

func TestNewerSchemaStateFilesAreSkippedWithWarning(t *testing.T) {
	root := t.TempDir()
	store := NewStateStore(root, "state", false)
	write(t, store, sampleState("laptop", s("14.1.0")))
	future := `{"schemaVersion": 99, "machine": "future", "os": "linux", "arch": "x86_64",
                    "toolVersion": "9.9.9", "updatedAt": "2027-01-01T00:00:00Z"}`
	if err := os.WriteFile(filepath.Join(root, "state", "future.json"), []byte(future), 0o644); err != nil {
		t.Fatal(err)
	}
	all := store.ReadAll()
	if keys := all.Keys(); len(keys) != 1 || keys[0] != "laptop" {
		t.Errorf("%v", keys)
	}
	if w := store.LastWarnings(); len(w) != 1 || !strings.Contains(w[0], "newer loadout") {
		t.Errorf("%v", w)
	}
	if store.Read("future") != nil || len(store.LastWarnings()) == 0 {
		t.Error("read the future")
	}
	store.Read("laptop")
	if len(store.LastWarnings()) != 0 {
		t.Errorf("%v", store.LastWarnings())
	}
}

func TestConfigsAreLeftOutWhenEmptyAndRoundTripWhenPresent(t *testing.T) {
	root := t.TempDir()
	store := NewStateStore(root, "state", false)
	write(t, store, sampleState("plain", s("14.1.0")))
	if strings.Contains(read(t, filepath.Join(root, "state", "plain.json")), "configs") {
		t.Error("configs written")
	}
	withConfigs := sampleState("dotted", s("14.1.0"))
	withConfigs.Configs = model.MapOf(
		model.E("tmux", coremodel.ConfigState{Status: coremodel.ConfigApplied}),
		model.E("zsh", coremodel.ConfigState{Status: coremodel.ConfigDrifted, Files: []string{".config/zsh/.zshrc"}}),
	)
	write(t, store, withConfigs)
	if !strings.Contains(read(t, filepath.Join(root, "state", "dotted.json")), `"drifted"`) {
		t.Error("no drifted")
	}
	if got := store.Read("dotted"); got == nil || !got.Equal(withConfigs) {
		t.Errorf("%+v", got)
	}
}

func TestWrittenJsonUsesLowercaseStatusNames(t *testing.T) {
	root := t.TempDir()
	write(t, NewStateStore(root, "state", false), sampleState("laptop", s("14.1.0")))
	text := read(t, filepath.Join(root, "state", "laptop.json"))
	if !strings.Contains(text, `"installed"`) || strings.Contains(text, "INSTALLED") {
		t.Error(text)
	}
}

func TestAnUnreadableStateFileWarnsInsteadOfCrashing(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "state"), 0o755)
	os.WriteFile(filepath.Join(root, "state", "m1.json"), []byte("{ this is not json"), 0o644)
	os.WriteFile(filepath.Join(root, "state", "m2.json"), []byte("{ also broken"), 0o644)
	store := NewStateStore(root, "state", false)

	// Read: a crash here reaches the user as a stack trace (contract 9).
	if store.Read("m1") != nil {
		t.Error("read")
	}
	if w := store.LastWarnings(); len(w) != 1 || !strings.Contains(w[0], "state/m1.json") {
		t.Errorf("%v", w)
	}
	// ReadAll: silence here would make the machine vanish from `diff`.
	if !store.ReadAll().IsEmpty() || len(store.LastWarnings()) != 2 {
		t.Errorf("%v", store.LastWarnings())
	}
}

func TestUpdatedAtMovesOnlyWhenSomethingElseChanged(t *testing.T) {
	root := t.TempDir()
	store := NewStateStore(root, "state", false)
	first := sampleState("laptop", s("14.1.0"))
	write(t, store, first)
	again := sampleState("laptop", s("14.1.0"))
	again.UpdatedAt = "2026-08-15T00:00:00Z"
	kept, err := store.WriteChanged(&first, again)
	if err != nil || kept.UpdatedAt != first.UpdatedAt || store.Read("laptop").UpdatedAt != first.UpdatedAt {
		t.Errorf("%v %s", err, kept.UpdatedAt)
	}
	moved := sampleState("laptop", s("14.2.0"))
	moved.UpdatedAt = "2026-08-15T00:00:00Z"
	if now, _ := store.WriteChanged(&first, moved); now.UpdatedAt != moved.UpdatedAt || store.Read("laptop").UpdatedAt != moved.UpdatedAt {
		t.Error(now.UpdatedAt)
	}
}

func TestCompileWritesOnlyUnderTheRepoRootAndOnlyWhatChanged(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "configs", ".chezmoidata", "loadout.json")
	if err := WriteIfChanged(root, target, "{}\n"); err != nil || read(t, target) != "{}\n" {
		t.Fatal(err)
	}
	info, _ := os.Stat(target)
	if err := WriteIfChanged(root, target, "{}\n"); err != nil {
		t.Fatal(err)
	}
	if again, _ := os.Stat(target); !again.ModTime().Equal(info.ModTime()) {
		t.Error("rewritten")
	}
	if err := WriteIfChanged(root, filepath.Join(root, "..", "parent", "loadout.lock.json"), "x"); err == nil {
		t.Error("wrote outside the repo")
	}
}
