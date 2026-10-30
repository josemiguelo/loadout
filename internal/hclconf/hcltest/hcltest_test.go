package hcltest

import (
	"strings"
	"testing"
)

func TestManifestOfIsTheFrontEndWithoutFileChecks(t *testing.T) {
	m := ManifestOf(t, `
program "jq" { install_via = [brew] }
script "s" { file = "missing.sh" }
machine "m" {
  install = [program.jq]
  run     = [script.s]
}`)
	if m.Layout.State != "state" || m.Machines.Value("m").PM.Value("jq") != "brew" {
		t.Errorf("manifest: %+v", m)
	}
	files := ManifestOfFiles(t, map[string]string{"tools/t.loadout.hcl": `script "s" { file = "s.sh" }`})
	if files.Scripts.Value("s").Origin != "tools" {
		t.Error("a file's declarations take its folder")
	}
	if message := Refusal(t, `machine "m" { install = [program.jq] }`); !strings.Contains(message, `"jq"`) {
		t.Error(message)
	}
}
