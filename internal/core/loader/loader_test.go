package loader

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	ct "github.com/josemiguelo/loadout/internal/core/coretest"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/git"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/version"
)

// The lock reader: the only way the binary sees a repo's manifests.

var sources = []string{"loadout.hcl", "programs/**/*.loadout.hcl"}

func manifest(t *testing.T, minToolVersion string) model.Manifest {
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Meta("test", minToolVersion)
		b.Program("git", model.Program{Install: ct.Custom("custom", "file:install-git.sh")})
		b.Machine("m", model.MachineConfig{PM: ct.PM("git", "custom")})
	})
	m.Layout = model.RepoLayout{State: "state", Configs: ct.S("configs"), Sources: sources}
	return m
}

func put(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func hash(t *testing.T, root string, globs []string) string {
	t.Helper()
	h, err := model.SourcesHash(os.DirFS(root), globs)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

type repoOpts struct {
	manifest    *model.Manifest
	toolVersion string
	files       []string
}

// repo is a repo whose lock is current with its sources, with files on disk.
func repo(t *testing.T, o repoOpts) string {
	t.Helper()
	root := t.TempDir()
	m := manifest(t, "")
	if o.manifest != nil {
		m = *o.manifest
	}
	if o.toolVersion == "" {
		o.toolVersion = version.Version
	}
	if o.files == nil {
		o.files = []string{"install-git.sh"}
	}
	put(t, filepath.Join(root, "loadout.hcl"), "repo {}\n")
	put(t, filepath.Join(root, "programs", "cli.loadout.hcl"), "\n")
	for _, f := range o.files {
		put(t, filepath.Join(root, f), "#!/bin/sh\n")
	}
	lock := model.Lock{ToolVersion: o.toolVersion, Sources: hash(t, root, sources), Manifest: m}
	put(t, filepath.Join(root, model.LockFileName), model.EncodeLock(lock))
	// What compile writes beside the configs.
	if m.Layout.Configs != nil {
		for path, text := range model.ChezmoiDataFiles(m, *m.Layout.Configs).All() {
			put(t, filepath.Join(root, path), text)
		}
	}
	return root
}

func refusal(t *testing.T, root string) string {
	t.Helper()
	_, err := LoadRepo(root, "")
	var r model.Refusal
	if !errors.As(err, &r) {
		t.Fatalf("not a refusal: %v", err)
	}
	return err.Error()
}

func contains(t *testing.T, message string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(message, want) {
			t.Errorf("%q not in:\n%s", want, message)
		}
	}
}

func load(t *testing.T, root, home string) model.Manifest {
	t.Helper()
	m, err := LoadRepo(root, home)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func versions() (major, minor, patch int) {
	parts := strings.Split(version.Version, ".")
	major, _ = strconv.Atoi(parts[0])
	minor, _ = strconv.Atoi(parts[1])
	patch, _ = strconv.Atoi(parts[2])
	return
}

func TestACurrentLockLoads(t *testing.T) {
	root := repo(t, repoOpts{})
	want := manifest(t, "")
	if got := load(t, root, ""); model.EncodeLock(model.Lock{Manifest: got}) != model.EncodeLock(model.Lock{Manifest: want}) {
		t.Errorf("%+v", got)
	}
	layout, err := ReadLayout(root)
	if err != nil || layout.State != "state" || *layout.Configs != "configs" || strings.Join(layout.Sources, ",") != strings.Join(sources, ",") {
		t.Errorf("%v %+v", err, layout)
	}
}

func TestTheTemplatesDataMustMatchTheLock(t *testing.T) {
	missing := repo(t, repoOpts{})
	os.Remove(filepath.Join(missing, "configs/.chezmoidata/loadout.json"))
	contains(t, refusal(t, missing), "configs/.chezmoidata/loadout.json is missing — run: loadout compile")

	edited := repo(t, repoOpts{})
	put(t, filepath.Join(edited, "configs/.chezmoidata/loadout.json"), "{}\n")
	contains(t, refusal(t, edited), "configs/.chezmoidata/loadout.json doesn't match loadout.lock.json — run: loadout compile")
}

func TestThePartialMustBeLoadouts(t *testing.T) {
	missing := repo(t, repoOpts{})
	os.Remove(filepath.Join(missing, "configs/.chezmoitemplates/loadout/machine"))
	contains(t, refusal(t, missing), "configs/.chezmoitemplates/loadout/machine is missing — run: loadout compile")

	edited := repo(t, repoOpts{})
	put(t, filepath.Join(edited, "configs/.chezmoitemplates/loadout/machine"), "{{ .chezmoi.hostname }}\n")
	contains(t, refusal(t, edited), "configs/.chezmoitemplates/loadout/machine doesn't match loadout.lock.json")
}

func TestTheTemplatesDataHoldsTheDefaultsAndEveryMachine(t *testing.T) {
	m := manifest(t, "")
	m.Data = model.MapOf[any](model.E[any]("work", false))
	tree, err := model.ParseJSON(model.RenderChezmoiData(m))
	if err != nil {
		t.Fatal(err)
	}
	loadout := tree.(model.JSONObject).Value("loadout").(model.JSONObject)
	if strings.Join(loadout.Keys(), ",") != "defaults,machines" {
		t.Errorf("%v", loadout.Keys())
	}
	if w := model.JSONString(loadout.Value("defaults").(model.JSONObject).Value("work")); w != "false" {
		t.Error(w)
	}
	if ms := loadout.Value("machines").(model.JSONObject).Keys(); strings.Join(ms, ",") != "m" {
		t.Errorf("%v", ms)
	}
}

func TestNoLockSaysToCompile(t *testing.T) {
	root := t.TempDir()
	contains(t, refusal(t, root), "no loadout.lock.json in "+root+" — run: loadout compile")
}

func TestAnEditTheLockHasntSeenIsRefused(t *testing.T) {
	root := repo(t, repoOpts{})
	put(t, filepath.Join(root, "programs", "cli.loadout.hcl"), "# edited\n")
	contains(t, refusal(t, root), "the manifests changed since loadout.lock.json was written — run: loadout compile")

	// A new source file counts too.
	added := repo(t, repoOpts{})
	put(t, filepath.Join(added, "programs", "new.loadout.hcl"), "\n")
	contains(t, refusal(t, added), "run: loadout compile")

	// Files no source glob matches don't.
	other := repo(t, repoOpts{})
	put(t, filepath.Join(other, "README.md"), "hi\n")
	load(t, other, "")
}

func TestANewerLockFormatSaysToUpgrade(t *testing.T) {
	root := repo(t, repoOpts{})
	path := filepath.Join(root, model.LockFileName)
	text, _ := os.ReadFile(path)
	put(t, path, strings.Replace(string(text), `"format": 1`, `"format": 2`, 1))
	contains(t, refusal(t, root), "lock format 2", "run: loadout self-upgrade")
}

func TestALockFromANewerMinorIsRefusedAndANewerPatchIsNot(t *testing.T) {
	major, minor, patch := versions()
	newer := strconv.Itoa(major) + "." + strconv.Itoa(minor+1) + ".0"
	contains(t, refusal(t, repo(t, repoOpts{toolVersion: newer})),
		"loadout.lock.json was compiled by loadout "+newer+" (you have "+version.Version+")", "run: loadout self-upgrade")
	load(t, repo(t, repoOpts{toolVersion: strconv.Itoa(major) + "." + strconv.Itoa(minor) + "." + strconv.Itoa(patch+1)}), "")
	load(t, repo(t, repoOpts{toolVersion: "0.1.0"}), "")
}

func TestANewerMinorsFieldIsRefusedByVersionNotByTheField(t *testing.T) {
	major, minor, _ := versions()
	newer := strconv.Itoa(major) + "." + strconv.Itoa(minor+1) + ".0"
	root := repo(t, repoOpts{toolVersion: newer})
	path := filepath.Join(root, model.LockFileName)
	text, _ := os.ReadFile(path)
	put(t, path, strings.Replace(string(text), `"manifest": {`, "\"manifest\": {\n    \"fromTheFuture\": true,", 1))
	contains(t, refusal(t, root), "was compiled by loadout "+newer, "run: loadout self-upgrade")
}

// ─── a child repo's parent (contract 18) ─────────────────────────

var parentSources = []string{"loadout.hcl"}

// child is a child repo whose parent, at ~/dots, declares a script whose
// file is there; it returns the child's root and $HOME.
func child(t *testing.T) (root, home string) {
	t.Helper()
	home = t.TempDir()
	parentRoot := filepath.Join(home, "dots")
	put(t, filepath.Join(parentRoot, "loadout.hcl"), "repo {}\n")
	put(t, filepath.Join(parentRoot, "lib", "helper.sh"), "#!/bin/sh\n")
	parent := &model.ParentLayout{Name: "dotfiles", Path: "~/dots", State: "state", Sources: parentSources, Hash: hash(t, parentRoot, parentSources)}
	m := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Meta("child", "")
		b.Script("helper", model.ScriptStep{File: ct.S("helper.sh"), Check: ct.S(`file:helper.sh check "$@"`), Origin: "parent:lib"})
		b.Machine("work", model.MachineConfig{Scripts: []string{"helper"}})
	})
	m.Layout = model.RepoLayout{State: "state", Sources: sources, Parent: parent}
	root = t.TempDir()
	put(t, filepath.Join(root, "loadout.hcl"), "repo {}\n")
	lock := model.Lock{ToolVersion: version.Version, Sources: hash(t, root, sources), Manifest: m}
	put(t, filepath.Join(root, model.LockFileName), model.EncodeLock(lock))
	return root, home
}

func childRefusal(t *testing.T, root, home string) string {
	t.Helper()
	_, err := LoadRepo(root, home)
	if err == nil {
		t.Fatal("loaded")
	}
	return err.Error()
}

func TestAChildLoadsWithItsParentAtItsPath(t *testing.T) {
	root, home := child(t)
	if origin := load(t, root, home).Scripts.Value("helper").Origin; origin != "parent:lib" {
		t.Error(origin)
	}
	layout, _ := ReadLayout(root)
	parentRoot, err := ParentRoot(root, layout, home)
	want, _ := filepath.EvalSymlinks(filepath.Join(home, "dots"))
	if err != nil || parentRoot != want {
		t.Errorf("%v %s", err, parentRoot)
	}
	if changed, err := ParentChanged(root, home); err != nil || changed {
		t.Errorf("%v %v", err, changed)
	}
}

func TestAParentEditTheChildHasntCompiledIsRefused(t *testing.T) {
	root, home := child(t)
	put(t, filepath.Join(home, "dots", "loadout.hcl"), "# edited\n")
	contains(t, childRefusal(t, root, home),
		"parent dotfiles: the manifests changed since loadout.lock.json was written — run: loadout compile")
	if changed, _ := ParentChanged(root, home); !changed {
		t.Error("unchanged")
	}
}

func TestAMissingParentOrParentFileIsNamed(t *testing.T) {
	gone, home := child(t)
	os.RemoveAll(filepath.Join(home, "dots"))
	contains(t, childRefusal(t, gone, home), "parent dotfiles is not at ~/dots — clone it there")

	noFile, home := child(t)
	os.Remove(filepath.Join(home, "dots", "lib", "helper.sh"))
	contains(t, childRefusal(t, noFile, home), "scripts.helper: file 'helper.sh' not found (relative to parent:lib/)")
}

func TestTheReposVersionFloorIsEnforced(t *testing.T) {
	floor := manifest(t, "999.0.0")
	contains(t, refusal(t, repo(t, repoOpts{manifest: &floor})), "requires loadout >= 999.0.0", "run: loadout self-upgrade")
	ours := manifest(t, version.Version)
	load(t, repo(t, repoOpts{manifest: &ours}), "")
}

func TestATooOldBinaryIsItsOwnRefusalNamingTheVersionNeeded(t *testing.T) {
	major, minor, _ := versions()
	floor := manifest(t, "999.0.0")
	var tooOld *model.ToolTooOldException
	if _, err := LoadRepo(repo(t, repoOpts{manifest: &floor}), ""); !errors.As(err, &tooOld) || tooOld.Required != "999.0.0" {
		t.Errorf("%v", err)
	}
	newer := strconv.Itoa(major) + "." + strconv.Itoa(minor+1)
	if _, err := LoadRepo(repo(t, repoOpts{toolVersion: newer + ".3"}), ""); !errors.As(err, &tooOld) || tooOld.Required != newer+".0" {
		t.Errorf("%v", err)
	}
	if !ToolTooOld(repo(t, repoOpts{manifest: &floor})) {
		t.Error("the floor")
	}
	if ToolTooOld(repo(t, repoOpts{})) || ToolTooOld(repo(t, repoOpts{files: []string{}})) {
		t.Error("not too old")
	}
}

func TestAFileTheLockNamesMustStillExist(t *testing.T) {
	contains(t, refusal(t, repo(t, repoOpts{files: []string{}})),
		"programs.git.install.custom: file 'install-git.sh' not found (relative to the repo root)")
}

func TestNotALockIsRefusedCleanly(t *testing.T) {
	root := repo(t, repoOpts{})
	put(t, filepath.Join(root, model.LockFileName), "meta:\n  name: yaml\n")
	contains(t, refusal(t, root), "run: loadout compile")
}

func TestEveryLoadoutFailureReportsAsACleanOneLiner(t *testing.T) {
	// main reports a model.Refusal and nothing else of ours; a type that
	// isn't one would reach the user as something else.
	ours := []error{
		model.NewManifestException("x"),
		&model.ToolTooOldException{Message: "x"},
		&engine.ResolutionException{Message: "x"},
		&engine.UpgradeException{Message: "x"},
		&engine.ConfigException{Message: "x"},
		&git.GitException{Message: "x"},
		&exec.InterruptedByUser{},
	}
	for _, e := range ours {
		if _, ok := e.(model.Refusal); !ok {
			t.Errorf("%T is not a model.Refusal", e)
		}
	}
	if (&exec.InterruptedByUser{}).Error() != "interrupted" {
		t.Error("InterruptedByUser's message")
	}
}
