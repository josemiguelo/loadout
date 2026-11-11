package hclconf

import "testing"

// `later = "…"`: what setup-new-machine does after everything else, and the
// mistakes compile refuses about it.

func TestLaterIsAReasonOnAProgramOrAScript(t *testing.T) {
	m := manifestOf(t, `
program "stremio" {
  later       = "a big Flathub download"
  install_via = [flatpak]
}
program "git" { install_via = [pacman] }
script "models" {
  run   = "true"
  later = "gigabytes of models"
}
script "shell" { run = "true" }`)
	equal(t, m.Programs.Value("stremio").Later, "a big Flathub download")
	equal(t, m.Programs.Value("git").Later, "")
	equal(t, m.Scripts.Value("models").Later, "gigabytes of models")
	equal(t, m.Scripts.Value("shell").Later, "")
}

func TestLaterNeedsAReason(t *testing.T) {
	contains(t, diagnostics(t, root(`program "p" {
  later       = " "
  install_via = [pacman]
}`))[0], "Empty reason; later takes why, in a few words")
}

func TestLaterIsntForAMaintainOnlyScript(t *testing.T) {
	contains(t, diagnostics(t, root(`script "s" {
  run           = "true"
  maintain_only = true
  later         = "slow"
}`))[0], "Conflicting arguments; later orders a script within setup-new-machine")
}

func TestACoreProgramCantDependOnALaterOne(t *testing.T) {
	message := refusal(t, `
program "openssl-1.1" {
  later       = "built from source"
  install_via = [pacman]
}
program "tools" {
  depends_on  = [program["openssl-1.1"]]
  install_via = [pacman]
}`)
	contains(t, message, "program 'tools' depends on program 'openssl-1.1', which is later: mark tools later too, or drop later from openssl-1.1")
	// Later on both: fine.
	manifestOf(t, `
program "openssl-1.1" {
  later       = "built from source"
  install_via = [pacman]
}
program "tools" {
  later       = "needs openssl-1.1"
  depends_on  = [program["openssl-1.1"]]
  install_via = [pacman]
}`)
}

func TestACoreProgramCantNeedALaterOneThroughItsInstaller(t *testing.T) {
	contains(t, refusal(t, `
installer "box" {
  probe   = "box"
  install = "box add {pkg}"
  check   = "box has {pkg}"
}
requires "box" { programs = [program.box] }
program "box" {
  later       = "slow"
  install_via = [pacman]
}
program "thing" { install_via = [box] }`), "program 'thing' depends on program 'box', which is later")
}

func TestACoreScriptCantRunAfterALaterStep(t *testing.T) {
	message := refusal(t, `
program "sdk" {
  later       = "large"
  install_via = [pacman]
}
script "models" {
  run   = "true"
  later = "slow"
}
script "a" {
  run       = "true"
  run_after = [program.sdk]
}
script "b" {
  run = "true"
  variant "x" {
    run       = "true"
    run_after = [script.models]
  }
}`)
	contains(t, message, "script 'a' runs after program 'sdk', which is later: mark a later too, or drop later from sdk")
	contains(t, message, "script 'b' runs after script 'models', which is later")
	// A later step after a core one is the point.
	manifestOf(t, `
program "git" { install_via = [pacman] }
script "repos" {
  run       = "true"
  later     = "many clones"
  run_after = [program.git]
}`)
}
