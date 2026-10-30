package engine

import (
	"testing"

	"github.com/josemiguelo/loadout/internal/assemble"
	ct "github.com/josemiguelo/loadout/internal/core/coretest"
	"github.com/josemiguelo/loadout/internal/core/exec/fakeexec"
	"github.com/josemiguelo/loadout/internal/model"
)

func updates(runner *fakeexec.Runner) *UpdateChecker { return NewUpdateChecker(runner, noFrame) }

func TestCandidateParsedEvenOnNonZeroExit(t *testing.T) {
	// dnf check-update prints the update line and exits 100.
	runner := fakeexec.New().OnCommand("dnf -q check-update ripgrep", fakeexec.Stdout("ripgrep.x86_64  15.2.0-1.fc44  updates"), fakeexec.Exit(100))
	c := must[*string](t)(updates(runner).Candidate(*ct.Version("dnf -q check-update ripgrep", `([0-9]+\.[0-9][0-9.]*)`)))
	if c == nil || *c != "15.2.0" {
		t.Errorf("%v", c)
	}
}

func TestNoOutputMeansUpToDate(t *testing.T) {
	runner := fakeexec.New().OnCommand("brew outdated --verbose ripgrep")
	if c := must[*string](t)(updates(runner).Candidate(*ct.Version("brew outdated --verbose ripgrep", "([0-9.]+)"))); c != nil {
		t.Error(*c)
	}
}

func TestOutdatedResolvesThroughInstallerWithPkgSubstitution(t *testing.T) {
	manifest := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("dnf", model.Installer{
			Install: s("sudo dnf install -y {pkg}"), Check: s("rpm -q {pkg}"),
			Outdated: s("dnf -q check-update {pkg}"), Regex: s("([0-9.]+)"),
		})
		b.Program("zlib-devel", model.Program{Install: ct.Variants(model.E("dnf", model.InstallVariant{Pkg: s("zlib-ng")}))})
	})
	resolved := manifest.ResolveInstall("zlib-devel", "dnf")
	if resolved.Outdated == nil || resolved.Outdated.Command != "dnf -q check-update zlib-ng" || *resolved.Outdated.Regex != "([0-9.]+)" {
		t.Errorf("%+v", resolved.Outdated)
	}

	// No oracle declared -> nil.
	bare := ct.ManifestOf(t, func(b *ct.Draft) { b.Program("x", model.Program{Install: ct.Custom("manual", "true")}) })
	if o := bare.ResolveInstall("x", "manual").Outdated; o != nil {
		t.Errorf("%+v", o)
	}
}

func TestBatchCandidatesParsePkgAndCandidateText(t *testing.T) {
	runner := fakeexec.New().OnCommand("list-outdated",
		fakeexec.Stdout("kitty 0.48.2-1.fc44\nobsidian Version: 1.13.7\n\nmalformed\n"), fakeexec.Exit(100))
	batch := must[model.Map[string]](t)(updates(runner).BatchCandidates("list-outdated", "", nil))
	if batch.Value("kitty") != "0.48.2-1.fc44" || batch.Value("obsidian") != "Version: 1.13.7" || batch.Len() != 2 {
		t.Errorf("%v", batch.Keys())
	}
}

func TestOutdatedAllResolvesPerInstallerAndVariantOverrideWins(t *testing.T) {
	manifest := ct.ManifestOf(t, func(b *ct.Draft) {
		b.Installer("dnf", model.Installer{
			Install: s("sudo dnf install -y {pkg}"), Check: s("rpm -q {pkg}"),
			Outdated: s("dnf -q check-update {pkg}"), OutdatedAll: s("dnf -q check-update"), Regex: s("([0-9.]+)"),
		})
		b.Program("kitty", model.Program{Install: ct.Variants(model.E("dnf", model.InstallVariant{Pkg: s("kitty-terminal")}))})
		b.Program("special", model.Program{Install: ct.Variants(model.E("dnf", model.InstallVariant{Outdated: s("custom-oracle")}))})
	})
	// Batch oracle covers the plain variant; per-pkg pattern is not used.
	batched := manifest.ResolveInstall("kitty", "dnf")
	if batched.Outdated != nil {
		t.Errorf("per-pkg: %+v", batched.Outdated)
	}
	if o := batched.OutdatedAll; o == nil || o.Installer != "dnf" || o.Command != "dnf -q check-update" || o.Pkg != "kitty-terminal" || o.Regex != "([0-9.]+)" {
		t.Errorf("batch: %+v", o)
	}
	// An explicit variant oracle overrides the batch.
	explicit := manifest.ResolveInstall("special", "dnf")
	if explicit.OutdatedAll != nil || explicit.Outdated == nil || explicit.Outdated.Command != "custom-oracle" {
		t.Errorf("%+v %+v", explicit.OutdatedAll, explicit.Outdated)
	}
}

func TestCustomSourceRowsParseAndValidate(t *testing.T) {
	runner := fakeexec.New().OnCommand("plugin-sweep", fakeexec.Stdout(
		"java 9bd89aa ea1fe99\nruby fa85ede 498c76f extra\n"+
			"go 1111111 2222222 3 commit(s) behind https://github.com/x/go/compare/1111111...2222222\nmalformed line\n"))
	result := must[SourceResult](t)(updates(runner).SourceRows("plugin-sweep", ""))
	if result.Error != nil || len(result.Rows) != 3 {
		t.Fatalf("%+v", result)
	}
	row := func(r SourceRow) string {
		link := ""
		if r.Link != nil {
			link = *r.Link
		}
		return r.Name + "|" + r.Current + "|" + r.Candidate + "|" + r.Note + "|" + link
	}
	for i, want := range []string{
		"java|9bd89aa|ea1fe99||",
		"ruby|fa85ede|498c76f|extra|",
		// A URL in the tail is the row's link, lifted out of the note.
		"go|1111111|2222222|3 commit(s) behind|https://github.com/x/go/compare/1111111...2222222",
	} {
		if got := row(result.Rows[i]); got != want {
			t.Errorf("row %d: %s", i, got)
		}
	}

	manifest := ct.ManifestOf(t, func(b *ct.Draft) { b.Outdated("asdf-plugins", model.OutdatedSource{Command: s("sh sweep.sh")}) })
	if c := manifest.Outdated.Value("asdf-plugins").Command; *c != "sh sweep.sh" {
		t.Error(*c)
	}

	_, err := assemble.AssembleWithoutFiles(assemble.ManifestDraft{Manifest: model.Manifest{
		Layout:   model.RepoLayout{State: "state"},
		Outdated: model.MapOf(model.E("broken", model.OutdatedSource{})),
	}})
	contains(t, refused[*model.ManifestException](t, err), "outdated.broken needs a command")
}

func TestCustomSourceNonZeroExitIsReportedAsErrorNotEmptyRows(t *testing.T) {
	// A crashed/failing source must NOT look like "nothing outdated": its
	// exit code and last stderr line become a surfaced error, no rows.
	runner := fakeexec.New().OnCommand("flaky-oracle", fakeexec.Exit(1),
		fakeexec.Stdout("java 9bd89aa ea1fe99\n"), fakeexec.Stderr("warming up\nfatal: could not fetch remote\n"))
	result := must[SourceResult](t)(updates(runner).SourceRows("flaky-oracle", ""))
	if len(result.Rows) != 0 || result.Error == nil || *result.Error != "exited 1: fatal: could not fetch remote" {
		t.Errorf("%+v", result)
	}
}

func TestCustomSourceMissingBinaryIsReportedAsError(t *testing.T) {
	// Unregistered command = exit 127 (missing binary) -> loud error.
	result := must[SourceResult](t)(updates(fakeexec.New()).SourceRows("no-such-oracle", ""))
	if len(result.Rows) != 0 || result.Error == nil {
		t.Fatalf("%+v", result)
	}
	contains(t, *result.Error, "exited 127")
}

// A front end always gives an installer a regex; a lock written otherwise is still refused.
func installerOnly(installer model.Installer) error {
	_, err := assemble.AssembleWithoutFiles(assemble.ManifestDraft{Manifest: model.Manifest{
		Layout:     model.RepoLayout{State: "state"},
		Installers: model.MapOf(model.E("bad", installer)),
	}})
	return err
}

func TestOutdatedAllWithoutRegexIsRejected(t *testing.T) {
	err := installerOnly(model.Installer{Install: s("install {pkg}"), OutdatedAll: s("query")})
	contains(t, refused[*model.ManifestException](t, err), "outdated-all command but no regex")
}

func TestOutdatedWithoutRegexIsRejected(t *testing.T) {
	err := installerOnly(model.Installer{Install: s("install {pkg}"), Outdated: s("query {pkg}")})
	contains(t, refused[*model.ManifestException](t, err), "outdated command but no regex")
}

func TestAProgramsPathComesFirstForItsOutdatedCheck(t *testing.T) {
	runner := fakeexec.New().OnCommand(`PATH="/opt/x:$PATH"; export PATH; x latest`, fakeexec.Stdout("2.0.0"))
	vc := model.VersionCheck{Command: "x latest", Regex: s("([0-9.]+)"), Path: []string{"/opt/x"}}
	if c := must[*string](t)(updates(runner).Candidate(vc)); c == nil || *c != "2.0.0" {
		t.Errorf("%v", c)
	}
}
