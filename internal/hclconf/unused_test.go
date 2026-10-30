package hclconf

import (
	"strings"
	"testing"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/model"
)

// What `loadout compile` warns about: declarations no machine uses, spare
// marks that aren't true, and transitional scripts every machine has done.

func warnings(t *testing.T, src string) []string {
	t.Helper()
	draft, d := draftOf(t, root(src))
	m, err := assemble.AssembleWithoutFiles(draft)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, w := range UnusedWarnings(draft, m, d.Spares, nil) {
		out = append(out, strings.SplitN(w, " — ", 2)[0])
	}
	return out
}

func TestARepoEveryMachineUsesHasNoWarnings(t *testing.T) {
	equalSlices(t, warnings(t, `
program "base" { install_via = [dnf] }
program "tool" {
  install_via = [dnf]
  depends_on  = [program.base]
}
script "step" { run = "true" }
profile "shared" { run = [script.step] }
machine "m1" {
  extends = [profile.shared]
  install = [program.tool]
}`), nil)
}

func TestWhatNoMachineUsesIsNamed(t *testing.T) {
	equalSlices(t, warnings(t, `
installer "fake" { install = "true" }
program "orphan" { install_via = [dnf] }
program "tool" { install_via = [dnf, brew] }
program "jq" { install_via = [brew] }
script "idle" { run = "true" }
script "keyboard" {
  variant "arch" { run = "true" }
  variant "fedora" { run = "true" }
}
profile "lonely" {}
machine "m1" {
  via "dnf" { install = [program.tool] }
  install = [program.jq]
  run     = [variant(script.keyboard, "arch")]
}`), []string{
		"installer 'fake' installs nothing a machine uses",
		"profile 'lonely' isn't extended by any machine",
		"program 'orphan' isn't installed on any machine",
		"program 'tool': machine 'm1' installs other programs via 'brew', but not tool",
		"script 'idle' isn't run on any machine",
		"script 'keyboard': no machine runs it as 'fedora'",
	})
}

func TestTheWarningSaysHowToMarkItSpare(t *testing.T) {
	draft, d := draftOf(t, root(`program "orphan" { install_via = [dnf] }`))
	m, _ := assemble.AssembleWithoutFiles(draft)
	equalSlices(t, UnusedWarnings(draft, m, d.Spares, nil), []string{
		`program 'orphan' isn't installed on any machine — if it's kept on purpose, mark it spare = "…"`,
	})
}

func TestAWayToInstallThroughAnInstallerNoMachineUsesIsNotAWarning(t *testing.T) {
	equalSlices(t, warnings(t, `
program "ripgrep" { install_via = [dnf, apt, pacman, brew] }
machine "laptop" {
  via "dnf" { install = [program.ripgrep] }
}`), nil)
}

func TestASpareMarkOnAPickedWayToInstallIsAWarning(t *testing.T) {
	equalSlices(t, warnings(t, `
program "tool" {
  via "dnf" { spare = "for Fedora" }
  install_via = [brew]
}
machine "m1" {
  via "dnf" { install = [program.tool] }
}`), []string{"program 'tool' via 'dnf' is marked spare, but a machine uses it"})
}

func TestASpareMarkOnAScriptVariantAMachineRunsIsAWarning(t *testing.T) {
	equalSlices(t, warnings(t, `
script "keyboard" {
  variant "arch" {
    spare = "no Arch machine"
    run   = "true"
  }
  variant "fedora" { run = "true" }
}
machine "m1" { run = [variant(script.keyboard, "arch")] }
machine "m2" { run = [variant(script.keyboard, "fedora")] }`), []string{"script 'keyboard' as 'arch' is marked spare, but a machine uses it"})
}

func TestSpareSilencesTheWarningAndASpareProfileCountsAsUsed(t *testing.T) {
	equalSlices(t, warnings(t, `
program "fedora-only" { install_via = [dnf] }
program "tool" {
  install_via = [dnf]
  via "brew-cask" { spare = "for macOS" }
}
script "keyboard" {
  variant "arch" { run = "true" }
  variant "fedora" {
    spare = "no Fedora machine"
    run   = "true"
  }
}
program "kept" {
  spare       = "for later"
  install_via = [dnf]
}
profile "fedora" {
  spare   = "no Fedora machine"
  install = [program.fedora-only]
}
machine "m1" {
  via "dnf" { install = [program.tool] }
  run = [variant(script.keyboard, "arch")]
}`), nil)
}

func TestASpareMarkOnSomethingUsedIsAWarning(t *testing.T) {
	equalSlices(t, warnings(t, `
program "tool" {
  spare       = "for later"
  install_via = [dnf]
}
machine "m1" { install = [program.tool] }`), []string{"program 'tool' is marked spare, but machine 'm1' uses it"})
}

func TestAMachineCantBeSpare(t *testing.T) {
	contains(t, refusal(t, `machine "m1" { spare = "unused" }`), "machine 'm1' is marked spare, but only a profile can be")
}

// ─── transitional ──────────────────────────────────────────────────────

const transitionalRepo = `
script "cleanup" {
  run          = "rm -f old"
  check        = "test ! -e old"
  transitional = true
}
script "other" {
  run   = "true"
  check = "true"
}
profile "shared" { run = [script.cleanup] }
machine "m1" { extends = [profile.shared] }
machine "m2" {
  extends = [profile.shared]
  run     = [script.other]
}
machine "m3" { run = [script.other] }
`

func done(entries map[string][]string) map[string]map[string]bool {
	out := map[string]map[string]bool{}
	for machine, scripts := range entries {
		out[machine] = map[string]bool{}
		for _, s := range scripts {
			out[machine][s] = true
		}
	}
	return out
}

func TestAScriptEveryRunnerHasDoneIsNamedForDeletion(t *testing.T) {
	draft, d := draftOf(t, root(transitionalRepo))
	m, _ := assemble.AssembleWithoutFiles(draft)
	equalSlices(t, d.Transitional, []string{"cleanup"})
	equalSlices(t, TransitionalWarnings(m, d.Transitional, done(map[string][]string{"m1": {"cleanup"}, "m2": {"cleanup", "other"}})),
		[]string{"script 'cleanup' is done on every machine that runs it (m1, m2): it's transitional, so delete it"})
}

func TestOneRunnerNotDoneOrWithoutStateKeepsItQuiet(t *testing.T) {
	draft, d := draftOf(t, root(transitionalRepo))
	m, _ := assemble.AssembleWithoutFiles(draft)
	equalSlices(t, TransitionalWarnings(m, d.Transitional, done(map[string][]string{"m1": {"cleanup"}, "m2": {"other"}})), nil)
	equalSlices(t, TransitionalWarnings(m, d.Transitional, done(map[string][]string{"m1": {"cleanup"}})), nil)
}

func TestATransitionalScriptNeedsACheckOnItselfOrEveryVariant(t *testing.T) {
	contains(t, refusal(t, `
script "nocheck" {
  run          = "true"
  transitional = true
}
machine "m1" { run = [script.nocheck] }`), "script 'nocheck' is transitional, so it needs a check")
	contains(t, refusal(t, `
script "half" {
  transitional = true
  variant "a" {
    run   = "true"
    check = "true"
  }
  variant "b" { run = "true" }
}
machine "m1" { run = [variant(script.half, "a")] }`), "script 'half' is transitional, so it needs a check")
}

func TestTransitionalBelongsToTheScriptNotAVariant(t *testing.T) {
	contains(t, refusal(t, `
script "v" {
  variant "a" {
    run          = "true"
    check        = "true"
    transitional = true
  }
}
machine "m1" { run = [variant(script.v, "a")] }`), "script 'v': transitional = true goes on the script, not on its 'a' variant")
}

// ─── a child repo (contract 18) ────────────────────────────────────────

// parentRepoFiles is a parent: a program, a profile, a machine of its own and a data schema.
var parentRepoFiles = map[string]string{
	EntryFile: `
repo {
  name             = "dots"
  state            = "state"
  configs          = "configs"
  min_tool_version = "3.1.0"
}
data {
  work = flag(false)
}
# At the parent's root: the parent's root.
program "htop" {
  custom { command = "true" }
}
`,
	"programs/git.loadout.hcl": `
program "git" {
  custom { command = "true" }
}
profile "base" { install = [program.git] }
machine "laptop" {
  extends = [profile.base]
  install = [program.htop]
}
`,
}

func decodeParent(t *testing.T) *Decoded {
	t.Helper()
	d, err := Decode(filesOf(parentRepoFiles), Options{AsParent: true})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func childOver(t *testing.T, parent *Decoded, files map[string]string) (*Decoded, assemble.ManifestDraft, error) {
	t.Helper()
	child, err := Decode(filesOf(files), Options{Parent: parent})
	if err != nil {
		t.Fatal(err)
	}
	draft, err := child.DraftOver(parent, "dotfiles")
	return child, draft, err
}

func TestAChildMachineUsesTheParentsDeclarationsButNotItsMachines(t *testing.T) {
	_, draft, err := childOver(t, decodeParent(t), map[string]string{
		EntryFile: `
repo {
  name             = "work"
  state            = "state"
  min_tool_version = "3.3.0"
}`,
		"programs/work.loadout.hcl": `
program "worktool" {
  custom { command = "true" }
}
machine "work-mac" {
  extends = [profile.base]
  install = [program.worktool]
  data    = { work = true }
}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	m, err := assemble.AssembleWithoutFiles(draft)
	if err != nil {
		t.Fatal(err)
	}
	equalSlices(t, m.Machines.Keys(), []string{"work-mac"})
	equalSlices(t, m.Machines.Value("work-mac").PM.Keys(), []string{"git", "worktool"})
	equal(t, m.Programs.Value("git").Origin, "parent:programs")
	equal(t, m.Programs.Value("htop").Origin, "parent:")
	equal(t, m.Programs.Value("worktool").Origin, "programs")
	equal(t, model.JSONString(m.Machines.Value("work-mac").Data.Value("work")), "true")
	// The floor is the higher of the two; meta and layout are the child's.
	equal(t, deref(m.Meta.MinToolVersion), "3.3.0")
	equal(t, m.Meta.Name, "work")
	if m.Layout.Configs != nil {
		t.Error("the parent's configs are the parent's")
	}
}

func TestAChildsDataIsCheckedAgainstTheParentsSchema(t *testing.T) {
	child, _, err := childOver(t, decodeParent(t), map[string]string{
		EntryFile: `repo { state = "state" }`,
		"m.loadout.hcl": `machine "m" {
  data = { wrok = true }
}`,
	})
	if err == nil {
		t.Fatal("an undeclared key is refused")
	}
	equalSlices(t, child.Errors, []string{"machine 'm': data key 'wrok' is not declared in the data schema"})
}

func TestANameBothReposDeclareIsRefusedNamingTheParent(t *testing.T) {
	_, _, err := childOver(t, decodeParent(t), map[string]string{
		EntryFile: `
repo { state = "state" }
program "git" {
  custom { command = "true" }
}
machine "laptop" {}`,
	})
	contains(t, err.Error(),
		"program 'git' is declared by parent dotfiles too",
		"machine 'laptop' is declared by parent dotfiles too — a machine belongs to one repo")
}

func TestAChildCantDeclareADataSchema(t *testing.T) {
	_, _, err := childOver(t, decodeParent(t), map[string]string{
		EntryFile: "repo { state = \"state\" }\ndata {\n  secret = flag(false)\n}\n",
	})
	contains(t, err.Error(), "a child repo's data schema is its parent's")
}

func TestAParentsMistakesAreNamedAsItsOwn(t *testing.T) {
	parent, err := Decode(filesOf(map[string]string{EntryFile: `
program "p" {
  custom { command = "x" }
  custom { command = "y" }
}`}), Options{AsParent: true})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = childOver(t, parent, map[string]string{EntryFile: `repo { state = "state" }`})
	contains(t, err.Error(), "parent dotfiles: program 'p' has two 'custom' variants")
}

func TestWarningsAreAboutTheChildsOwnDeclarationsOnly(t *testing.T) {
	parent := decodeParent(t)
	child, draft, err := childOver(t, parent, map[string]string{
		EntryFile: `
repo { state = "state" }
program "forgotten" {
  custom { command = "true" }
}
machine "work-mac" { install = [program.git] }`,
	})
	if err != nil {
		t.Fatal(err)
	}
	m, err := assemble.AssembleWithoutFiles(draft)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, w := range UnusedWarnings(draft, m, child.Spares, assemble.DeclaredNames(parent.Draft)) {
		out = append(out, strings.SplitN(w, " —", 2)[0])
	}
	// htop and the base profile are unused here, but they're the parent's.
	equalSlices(t, out, []string{"program 'forgotten' isn't installed on any machine"})
}
