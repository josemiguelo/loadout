package hclconf

import (
	"strings"
	"testing"

	"github.com/josemiguelo/loadout/internal/model"
)

// The manifest language's constructs, one by one: references, functions,
// locals, the variant body, data, and how HCL's diagnostics read.

// diagnostics is the lines Decode refuses files with.
func diagnostics(t *testing.T, files map[string]string) []string {
	t.Helper()
	_, err := Decode(filesOf(files), Options{})
	if err == nil {
		t.Fatal("decoded; wanted diagnostics")
	}
	de, ok := err.(*DiagnosticsError)
	if !ok {
		t.Fatalf("%T is not a DiagnosticsError: %v", err, err)
	}
	return de.Lines
}

func variantOf(t *testing.T, body string) model.InstallVariant {
	t.Helper()
	d := decode(t, root("program \"p\" {\n  custom {\n"+body+"\n  }\n}\n"))
	equalSlices(t, d.Errors, nil)
	return d.Draft.Manifest.Programs.Value("p").Install.Value("custom")
}

func TestTheVariantBody(t *testing.T) {
	v := variantOf(t, `pkg = "p-bin"
command = "make install"
probe = "make"
outdated = "curl -s x"
needs_sudo = false
params = { b = "2", a = "1" }`)
	equal(t, deref(v.Pkg), "p-bin")
	equal(t, deref(v.Command), "make install")
	equal(t, deref(v.Probe), "make")
	equal(t, deref(v.Outdated), "curl -s x")
	equal(t, *v.Sudo, false)
	// Params keep the order they're written in.
	equalSlices(t, v.With.Keys(), []string{"b", "a"})

	v = variantOf(t, `installed_by = "x.sh --flag"`)
	equal(t, deref(v.Command), "file:x.sh --flag")

	v = variantOf(t, `managed_by = "x.sh"`)
	equal(t, deref(v.Command), "file:x.sh install")
	equal(t, deref(v.Check), "file:x.sh check")
	equal(t, v.Present, true)

	v = variantOf(t, `command = "x"
version = "x --version"`)
	equal(t, deref(v.Check), "x --version")
	equal(t, deref(v.Regex), VersionRegex)
	equal(t, v.Present, false)

	v = variantOf(t, `command = "x"
version = "x -V"
regex = "x ([0-9]+)"`)
	equal(t, deref(v.Regex), "x ([0-9]+)")

	v = variantOf(t, `command = "x"
present = "test -x x"`)
	equal(t, deref(v.Check), "test -x x")
	equal(t, v.Present, true)
	if v.Regex != nil {
		t.Error("present has no regex")
	}

	// A regex alone overrides only the derived check's.
	m := manifestOf(t, `program "sublime" {
  via "dnf" { regex = "([0-9]{4})" }
}`)
	resolved := m.ResolveInstall("sublime", "dnf")
	equal(t, deref(resolved.Check.Regex), "([0-9]{4})")
	equal(t, resolved.Check.Command, "rpm -q sublime")

	m = manifestOf(t, `
program "dnf-plugins-core" { install_via = [dnf] }
program "kitty" {
  via "dnf-copr" {
    params     = { copr = "solopasha/kitty" }
    depends_on = [program.dnf-plugins-core]
  }
}
program "brew" {
  custom {
    command = "x"
    provides "brew" {
      at = "/opt/homebrew/bin"
    }
    provides "flatpak" {}
  }
}`)
	equalSlices(t, m.Programs.Value("kitty").Install.Value("dnf-copr").DependsOn, []string{"dnf-plugins-core"})
	provides := m.Programs.Value("brew").Install.Value("custom").Provides
	if len(provides) != 2 || provides[0].Binary != "brew" || deref(provides[0].At) != "/opt/homebrew/bin" || provides[1].Binary != "flatpak" || provides[1].At != nil {
		t.Errorf("provides: %+v", provides)
	}
}

func TestAtMostOneCheckAndOneCommand(t *testing.T) {
	lines := diagnostics(t, root(`program "p" {
  custom {
    version    = "x"
    managed_by = "x.sh"
    command    = "y"
  }
}`))
	equal(t, len(lines), 2)
	contains(t, lines[0], "loadout.hcl:4,5: Conflicting arguments; version and managed_by can't both be set")
	contains(t, lines[1], "loadout.hcl:5,5: Conflicting arguments; managed_by and command can't both be set")
}

func TestVariantsAreInTheOrderWritten(t *testing.T) {
	m := manifestOf(t, `program "p" {
  via "pacman" {}
  install_via = [dnf, brew]
  custom "linux" { command = "x" }
  via "apt" {}
}`)
	equalSlices(t, m.Programs.Value("p").Install.Keys(), []string{"pacman", "dnf", "brew", "linux", "apt"})
	contains(t, refusal(t, `program "p" {
  install_via = [brew]
  via "brew" { pkg = "q" }
}`), "program 'p' has two 'brew' variants")
}

func TestAnUnlabelledCustomIsNamedCustom(t *testing.T) {
	m := manifestOf(t, `program "p" {
  custom {
    command = "x"
  }
}
machine "m" { install = [program.p] }`)
	equal(t, m.Machines.Value("m").PM.Value("p"), "custom")
}

func TestReferencesFlattenAndMayComeFromLocalsAndFunctions(t *testing.T) {
	m := manifestFiles(t, map[string]string{
		EntryFile: `
locals {
  everyday = [program.bat, local.more]
  more     = [program.eza, [program.fd]]
}
function "ssh_key" {
  params = [name]
  result = [args(script.setup-ssh, name), args(script.github-ssh-key, name, "extra words")]
}
`,
		"programs/cli.loadout.hcl": `
program "bat" { install_via = [brew] }
program "eza" { install_via = [brew] }
program "fd" { install_via = [brew] }
program "curl" { install_via = [brew] }
script "setup-ssh" { file = "ssh.sh" }
script "github-ssh-key" { file = "gh.sh" }
`,
		"machines/m.loadout.hcl": `
machine "m" {
  install = [
    # comments inside lists are fine
    program.curl,
    local.everyday,
  ]
  run = ssh_key("t2")
}
`,
	})
	config := m.Machines.Value("m")
	equalSlices(t, config.PM.Keys(), []string{"bat", "curl", "eza", "fd"})
	equalSlices(t, config.Scripts, []string{"setup-ssh t2", "github-ssh-key t2 extra words"})
}

func TestAnUnknownReferenceIsHCLsDiagnostic(t *testing.T) {
	lines := diagnostics(t, map[string]string{"programs/profiles.loadout.hcl": `machine "m9" {
  install = [program.ghost-program]
  run     = [script.ghost-script]
}`})
	equal(t, len(lines), 2)
	contains(t, lines[0], `programs/profiles.loadout.hcl:2,21: Unsupported attribute; This object does not have an attribute named "ghost-program".`)
	contains(t, lines[1], `programs/profiles.loadout.hcl:3,20: Unsupported attribute; This object does not have an attribute named "ghost-script".`)
	// main's one prefix starts every line.
	err := &DiagnosticsError{Lines: lines}
	equal(t, strings.Count("error: "+err.Error(), "error: "), 2)
}

func TestASyntaxErrorIsReportedWithItsPosition(t *testing.T) {
	lines := diagnostics(t, map[string]string{"maintenance/broken.loadout.hcl": "script \"broken\" {\n  run = \"true\"\n  check = [\n}\n"})
	if len(lines) == 0 || !strings.HasPrefix(lines[0], "maintenance/broken.loadout.hcl:") {
		t.Errorf("lines: %q", lines)
	}
}

func TestAReferenceOfTheWrongKindIsNamed(t *testing.T) {
	lines := diagnostics(t, root(`
program "git" { install_via = [brew] }
script "s" { run = "true" }
machine "m" {
  install = [script.s]
  run     = [program.git, "plain"]
}`))
	equal(t, len(lines), 3)
	contains(t, lines[0], "loadout.hcl:5,14: Wrong kind of reference; install takes programs, but script.s is a script.")
	contains(t, lines[1], "Wrong kind of reference; run takes scripts, but program.git is a program.")
	contains(t, lines[2], "Not a reference; run takes scripts")
}

func TestVariantAndArgsOnlyTakeWhatTheyFit(t *testing.T) {
	lines := diagnostics(t, root(`
program "git" { install_via = [brew] }
machine "m" {
  run = [args(program.git, "x"), variant(brew, "y")]
}`))
	equal(t, len(lines), 2)
	contains(t, lines[0], "args() takes a script")
	contains(t, lines[1], "variant() takes a program or a script")
	contains(t, strings.Join(diagnostics(t, root(`
program "git" { install_via = [brew] }
machine "m" {
  via "brew" { install = [variant(program.git, "brew")] }
}`)), "\n"), `via "brew" installs each program as its brew variant`)
}

func TestLabelsNamingAnInstallerMustNameOne(t *testing.T) {
	lines := diagnostics(t, root(`
program "p" {
  via "brwe" {}
}
requires "dnff" { programs = [program.p] }
machine "m" {
  via "omarchi" { install = [program.p] }
}`))
	equal(t, len(lines), 3)
	contains(t, lines[0], `loadout.hcl:3,7: Unknown installer; There is no installer named "brwe"`)
	contains(t, lines[1], `"dnff"`)
	contains(t, lines[2], `"omarchi"`)
}

func TestLocalsEvaluateInDependencyOrderAndACycleIsNamed(t *testing.T) {
	m := manifestOf(t, `
locals {
  c = upper(local.b)
}
locals {
  b = format("%s-b", local.a)
  a = "a"
}
script "s" { run = local.c }`)
	equal(t, deref(m.Scripts.Value("s").Run), "A-B")
	lines := diagnostics(t, root(`
locals {
  x = local.y
  y = local.x
}`))
	equal(t, len(lines), 1)
	contains(t, lines[0], "Cycle among locals; local.x, local.y refer to each other: local.x -> local.y -> local.x.")
	lines = diagnostics(t, map[string]string{EntryFile: "locals {\n  x = 1\n}\n", "b.loadout.hcl": "locals {\n  x = 2\n}\n"})
	contains(t, lines[0], `b.loadout.hcl:2,3: Duplicate local value; A local value named "x" was already declared at loadout.hcl:2,3.`)
	contains(t, diagnostics(t, root(`script "s" { run = local.nope }`))[0], `This object does not have an attribute named "nope"`)
}

func TestFunctionsAreRepoUnique(t *testing.T) {
	lines := diagnostics(t, map[string]string{
		EntryFile:       "function \"f\" {\n  params = []\n  result = 1\n}\n",
		"b.loadout.hcl": "function \"f\" {\n  params = []\n  result = 2\n}\nfunction \"upper\" {\n  params = []\n  result = 3\n}\n",
	})
	contains(t, strings.Join(lines, "\n"), `Duplicate function; A function named "f" is already declared at loadout.hcl:1,10.`, `"upper" is a built-in function`)
}

func TestFileAndRunScriptMarkRepoFiles(t *testing.T) {
	m := decode(t, root(`
installer "copyin" {
  params  = ["src"]
  install = run_script("copy.sh {src}")
}
program "tool" {
  via "copyin" {
    params = { src = file("payload.txt") }
  }
}`)).Draft.Manifest
	equal(t, deref(m.Installers.Value("copyin").Install), "file:copy.sh {src}")
	equal(t, m.Programs.Value("tool").Install.Value("copyin").With.Value("src"), "file:payload.txt")
}

func TestTheDataSchema(t *testing.T) {
	m := manifestOf(t, `
data {
  name  = text("x")
  count = whole(3)
  ratio = number(1)
  list  = list(["a", "b"])
  kitty {
    opacity = number(0.85)
  }
  omarchy = flag(false)
}
machine "m" {
  data = {
    count = 4
    ratio = 2
    kitty = { opacity = 0.99 }
  }
}`)
	// Declaration order; a number is a Kotlin Double ("1.0").
	equal(t, model.JSONString(m.Data), `{"name":"x","count":3,"ratio":1.0,"list":["a","b"],"kitty":{"opacity":0.85},"omarchy":false}`)
	equal(t, model.JSONString(m.Machines.Value("m").Data), `{"name":"x","count":4,"ratio":2.0,"list":["a","b"],"kitty":{"opacity":0.99},"omarchy":false}`)
}

func TestMachineDataIsCheckedAgainstTheSchema(t *testing.T) {
	schema := `
data {
  count = whole(3)
  list  = list(["a"])
  kitty {
    opacity = number(0.85)
  }
}
`
	d := decode(t, root(schema+`
profile "p" { data = { count = 1.5 } }
machine "m9" {
  data = {
    kitty = { opacty = 0.5 }
    list  = [1]
  }
}
machine "m8" { data = { kitty = 3 } }`))
	equalSlices(t, d.Errors, []string{
		"profile 'p': data key 'count' is a number with a fraction, but the data schema declares a whole number",
		"machine 'm9': data key 'kitty.opacty' is not declared in the data schema",
		"machine 'm9': data key 'list' is a list holding a number, but the data schema declares a list",
		"machine 'm8': data key 'kitty' is a number, but the data schema declares a table",
	})
	lines := diagnostics(t, root(`
data {
  a = flag("no")
  b = "plain"
  c = table(1)
}`))
	equal(t, len(lines), 3)
	contains(t, lines[0], `loadout.hcl:3,12: Invalid default; flag() takes a boolean; this is a string.`)
	contains(t, lines[1], "Invalid data key")
	contains(t, lines[2], "Invalid data key")
	contains(t, diagnostics(t, root(`program "p" { tags = [flag(true)] }`))[0], `Call to unknown function; There is no function named "flag".`)
}

func TestDeclarationsMayBeAnywhereAndAFileMayBeEmpty(t *testing.T) {
	m := manifestFiles(t, map[string]string{
		EntryFile: `
repo {
  name  = "x"
  state = "machines/state"
}
program "git" { install_via = [brew] }
machine "m" { install = [program.git] }`,
		"empty.loadout.hcl": "",
	})
	equal(t, m.Layout.State, "machines/state")
	equal(t, m.Meta.Name, "x")
	lines := diagnostics(t, map[string]string{"a.loadout.hcl": `repo { state = "s" }`})
	contains(t, lines[0], "a.loadout.hcl:1,1: Misplaced repo block; The repo block belongs in loadout.hcl")
}

func TestUnknownArgumentsAndBlocksAreNamed(t *testing.T) {
	lines := diagnostics(t, root(`
program "p" {
  install_vai = [brew]
  version "x" {}
}
thing "x" {}
script {}`))
	equal(t, len(lines), 4)
	contains(t, lines[0], `loadout.hcl:6,1: Unsupported block type; Blocks of type "thing" are not expected in a manifest file.`)
	contains(t, lines[1], `loadout.hcl:7,8: Missing name for script`)
	contains(t, lines[2], `loadout.hcl:3,3: Unsupported argument; An argument named "install_vai" is not expected in a program.`)
	contains(t, lines[3], `Blocks of type "version" are not expected in a program.`)
}

func TestScriptRules(t *testing.T) {
	m := manifestOf(t, `
program "gh" { install_via = [brew] }
script "setup-ssh" { run = "true" }
script "github-ssh-key" {
  description = "this machine's ssh key on GitHub"
  managed_by  = ".loadout/github-ssh-key.sh"
  run_after   = [script.setup-ssh, program.gh, script.setup-ssh]
}`)
	step := m.Scripts.Value("github-ssh-key")
	equalSlices(t, step.After, []string{"scripts.setup-ssh", "programs.gh"})
	equal(t, deref(step.File), ".loadout/github-ssh-key.sh")
	contains(t, diagnostics(t, root(`script "s" {
  run           = "x"
  setup_only    = true
  maintain_only = true
}`))[0], "Conflicting arguments; setup_only and maintain_only can't both be set")
	contains(t, diagnostics(t, root(`script "s" {
  managed_by = "x.sh"
  check      = "y"
}`))[0], "managed_by and check can't both be set")
}

func TestProgramBody(t *testing.T) {
	m := manifestOf(t, `
program "base" { install_via = [brew] }
program "claude" {
  description = "Claude Code"
  tags        = ["ai", "cli"]
  depends_on  = [program.base]
  version     = "claude --version"
  path        = ["$HOME/.local/bin"]
  outdated    = "npm view claude version"
  upgrade     = "claude update"
  custom { command = "curl x | sh" }
}`)
	p := m.Programs.Value("claude")
	equal(t, p.Description, "Claude Code")
	equalSlices(t, p.Tags, []string{"ai", "cli"})
	equalSlices(t, p.DependsOn, []string{"base"})
	equal(t, p.Version.Command, "claude --version")
	equal(t, deref(p.Version.Regex), VersionRegex)
	equalSlices(t, p.Version.Path, []string{"$HOME/.local/bin"})
	equal(t, p.Outdated.Command, "npm view claude version")
	equal(t, deref(p.Outdated.Upgrade), "claude update")
	contains(t, diagnostics(t, root(`program "p" { upgrade = "x" }`))[0], "Upgrade without outdated")
}

func TestShellTextNeedsItsDollarBracesEscaped(t *testing.T) {
	m := manifestOf(t, `script "s" {
  run = "echo $HOME $${USER} %%{x}"
  check = <<-EOT
    test -d "$HOME/x"
  EOT
}`)
	step := m.Scripts.Value("s")
	equal(t, deref(step.Run), "echo $HOME ${USER} %{x}")
	equal(t, deref(step.Check), "test -d \"$HOME/x\"\n")
}

func TestOutdatedSourcesAndInstallers(t *testing.T) {
	m := manifestFiles(t, map[string]string{"tools/t.loadout.hcl": `
installer "brew-tap" {
  probe        = "brew"
  install      = run_script("brew-tap.sh {tap} {pkg}")
  check        = "brew list --versions {pkg}"
  outdated_all = "brew outdated"
  upgrade      = "brew upgrade"
  needs_sudo   = true
  params       = ["tap"]
}
outdated "plugins" {
  command    = run_script("plugins.sh")
  upgrade    = run_script("plugins.sh update {item}")
  needs_sudo = true
}`})
	inst := m.Installers.Value("brew-tap")
	equal(t, deref(inst.Regex), VersionRegex)
	equal(t, inst.Sudo, true)
	equal(t, inst.Origin, "tools")
	equalSlices(t, inst.Params, []string{"tap"})
	src := m.Outdated.Value("plugins")
	equal(t, src.Sudo, true)
	equal(t, src.Origin, "tools")
	contains(t, strings.Join(diagnostics(t, root(`outdated "x" { upgrade = "y" }`)), "\n"), `The argument "command" is required`)
}

func TestOnlyInstallAndRunTakeVariantsAndArgs(t *testing.T) {
	lines := diagnostics(t, root(`
program "a" { install_via = [brew] }
program "b" {
  install_via = [brew]
  depends_on  = [variant(program.a, "brew")]
}
script "s" {
  run       = "true"
  run_after = [args(script.s, "x")]
}`))
	equal(t, len(lines), 2)
	contains(t, lines[0], "Not a plain reference; depends_on names programs as they are")
	contains(t, lines[1], "Not a plain reference; run_after names programs and scripts as they are")
}
