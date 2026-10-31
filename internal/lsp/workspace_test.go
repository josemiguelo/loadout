package lsp

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Diagnostics over a repo on disk, as the editor's buffers change.

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for p, text := range files {
		target := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

const repoEntry = `repo {
  name    = "test"
  state   = "machines/state"
  sources = ["programs/*.loadout.hcl"]
}

machine "m" {
  install = [program.jq]
}
`

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func initializeIn(t *testing.T, dir string, encodings ...string) string {
	t.Helper()
	params := map[string]any{"rootUri": uriOf(dir)}
	if len(encodings) > 0 {
		params["capabilities"] = map[string]any{"general": map[string]any{"positionEncodings": encodings}}
	}
	return jsonOf(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": params})
}

func didOpen(t *testing.T, path, text string) string {
	return jsonOf(t, map[string]any{"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": map[string]any{
		"textDocument": map[string]any{"uri": uriOf(path), "languageId": "hcl", "version": 1, "text": text},
	}})
}

func didChange(t *testing.T, path, text string) string {
	return jsonOf(t, map[string]any{"jsonrpc": "2.0", "method": "textDocument/didChange", "params": map[string]any{
		"textDocument":   map[string]any{"uri": uriOf(path), "version": 2},
		"contentChanges": []map[string]any{{"text": text}},
	}})
}

func didClose(t *testing.T, path string) string {
	return jsonOf(t, map[string]any{"jsonrpc": "2.0", "method": "textDocument/didClose", "params": map[string]any{
		"textDocument": map[string]any{"uri": uriOf(path)},
	}})
}

// published is each publishDiagnostics in order, as `uri` and its
// diagnostics' `line:char-line:char message`.
type published struct {
	uri   string
	diags []string
}

func publishedIn(t *testing.T, replies []map[string]any) []published {
	t.Helper()
	var out []published
	for _, r := range replies {
		if r["method"] != "textDocument/publishDiagnostics" {
			continue
		}
		var p publishParams
		if err := json.Unmarshal([]byte(jsonOf(t, r["params"])), &p); err != nil {
			t.Fatal(err)
		}
		got := published{uri: p.URI, diags: []string{}}
		for _, d := range p.Diagnostics {
			got.diags = append(got.diags, jsonOf(t, d.Range.Start)+"-"+jsonOf(t, d.Range.End)+" "+d.Message)
		}
		out = append(out, got)
	}
	return out
}

func pos(line, char int) string {
	b, _ := json.Marshal(position{line, char})
	return string(b)
}

func TestAnOpenedMistakeIsPublishedAndFixingItClearsIt(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"loadout.hcl": repoEntry, "programs/jq.loadout.hcl": `program "jq" { install_via = [brew] }`})
	jq := filepath.Join(dir, "programs/jq.loadout.hcl")
	replies, code, logs := session(t, frame(
		initializeIn(t, dir),
		didOpen(t, jq, `program "jq" { install_via = [brew] }`),
		didChange(t, jq, `program "jaq" { install_via = [brew] }`),
		didChange(t, jq, `program "jq" { install_via = [brew] }`),
		shutdown, exit))
	if code != 0 {
		t.Fatalf("code %d, logs %q", code, logs)
	}
	got := publishedIn(t, replies)
	entry := uriOf(filepath.Join(dir, "loadout.hcl"))
	if len(got) != 2 || got[0].uri != entry || got[1].uri != entry || len(got[1].diags) != 0 {
		t.Fatalf("published: %v", got)
	}
	// The unsaved rename breaks loadout.hcl's reference to program.jq
	// (HCL's range for it starts at the dot).
	want := pos(7, 20) + "-" + pos(7, 23) + ` Unsupported attribute; This object does not have an attribute named "jq".`
	if len(got[0].diags) != 1 || got[0].diags[0] != want {
		t.Errorf("diagnostics: %q, want %q", got[0].diags, want)
	}
}

func TestClosingABufferChecksTheDiskAgain(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"loadout.hcl": repoEntry, "programs/jq.loadout.hcl": `program "jq" { install_via = [brew] }`})
	jq := filepath.Join(dir, "programs/jq.loadout.hcl")
	replies, _, _ := session(t, frame(initializeIn(t, dir), didOpen(t, jq, `program "jaq" {}`), didClose(t, jq), shutdown, exit))
	got := publishedIn(t, replies)
	if len(got) != 2 || len(got[0].diags) == 0 || len(got[1].diags) != 0 {
		t.Errorf("published: %v", got)
	}
}

func TestAnErrorWithoutAPositionMarksWhatItNames(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"loadout.hcl":             repoEntry,
		"programs/jq.loadout.hcl": "program \"jq\" { install_via = [brew] }\nprogram \"jq\" { install_via = [brew] }\n",
	})
	replies, _, _ := session(t, frame(initializeIn(t, dir), didOpen(t, filepath.Join(dir, "loadout.hcl"), repoEntry), shutdown, exit))
	got := publishedIn(t, replies)
	// Each label, quotes included.
	want := []string{
		pos(0, 8) + "-" + pos(0, 12) + " duplicate program 'jq'",
		pos(1, 8) + "-" + pos(1, 12) + " duplicate program 'jq'",
	}
	if len(got) != 1 || got[0].uri != uriOf(filepath.Join(dir, "programs/jq.loadout.hcl")) || jsonOf(t, got[0].diags) != jsonOf(t, want) {
		t.Errorf("published: %v", got)
	}
}

func TestColumnsAreInTheNegotiatedEncoding(t *testing.T) {
	// "ñ" is 2 bytes and 1 UTF-16 unit; "𝄞" 4 bytes and 2 units. The
	// diagnostic starts at ".ghost".
	src := "program \"jq\" { install_via = [brew] }\nmachine \"m\" {\n  # ñ𝄞\n  install = [/*ñ𝄞*/program.ghost]\n}\n"
	for encoding, char := range map[string]int{encodingUTF16: 27, encodingUTF8: 30} {
		t.Run(encoding, func(t *testing.T) {
			dir := t.TempDir()
			writeFiles(t, dir, map[string]string{"loadout.hcl": "repo {\n  name = \"t\"\n  state = \"s\"\n  sources = [\"programs/*.loadout.hcl\"]\n}\n", "programs/x.loadout.hcl": src})
			var offered []string
			if encoding == encodingUTF8 {
				offered = []string{encodingUTF8, encodingUTF16}
			}
			replies, _, _ := session(t, frame(initializeIn(t, dir, offered...), didOpen(t, filepath.Join(dir, "programs/x.loadout.hcl"), src), shutdown, exit))
			caps := replies[0]["result"].(map[string]any)["capabilities"].(map[string]any)
			got := publishedIn(t, replies)
			if caps["positionEncoding"] != encoding || len(got) != 1 || len(got[0].diags) != 1 || got[0].diags[0][:len(pos(3, char))] != pos(3, char) {
				t.Errorf("encoding %v, published %v", caps["positionEncoding"], got)
			}
		})
	}
}

func TestOutsideARepoNothingIsPublished(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"x.hcl": `nonsense {`})
	replies, code, logs := session(t, frame(initializeIn(t, dir), didOpen(t, filepath.Join(dir, "x.hcl"), `nonsense {`), shutdown, exit))
	if code != 0 || len(publishedIn(t, replies)) != 0 || logs == "" {
		t.Errorf("code %d, replies %v, logs %q", code, replies, logs)
	}
}

func TestTheRepoIsFoundFromTheFirstManifestOpened(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"loadout.hcl": repoEntry, "programs/jq.loadout.hcl": `program "jq" { install_via = [brew] }`})
	init := jsonOf(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	replies, _, _ := session(t, frame(init, didOpen(t, filepath.Join(dir, "programs/jq.loadout.hcl"), `program "jaq" {}`), shutdown, exit))
	if got := publishedIn(t, replies); len(got) != 1 {
		t.Errorf("published: %v", got)
	}
}

func TestChangesInQuickSuccessionAreCheckedOnce(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"loadout.hcl": repoEntry, "programs/jq.loadout.hcl": `program "jq" { install_via = [brew] }`})
	jq := filepath.Join(dir, "programs/jq.loadout.hcl")
	in, editor := io.Pipe()
	var out bytes.Buffer
	done := make(chan int)
	go func() { done <- serve(in, &out, io.Discard, 50*time.Millisecond) }()
	write := func(msgs ...string) {
		if _, err := io.WriteString(editor, frame(msgs...)); err != nil {
			t.Fatal(err)
		}
	}
	write(initializeIn(t, dir), didOpen(t, jq, `program "jq" { install_via = [brew] }`))
	write(didChange(t, jq, `program "a" {}`), didChange(t, jq, `program "ab" {}`), didChange(t, jq, `program "abc" {}`))
	time.Sleep(300 * time.Millisecond)
	write(shutdown, exit)
	if code := <-done; code != 0 {
		t.Fatalf("code %d", code)
	}
	var replies []map[string]any
	c := newConn(&out, io.Discard)
	for body, err := c.read(); err == nil; body, err = c.read() {
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		replies = append(replies, m)
	}
	// Opening checks at once and finds nothing; the three changes, one check.
	if got := publishedIn(t, replies); len(got) != 1 || len(got[0].diags) != 1 {
		t.Errorf("published: %v", got)
	}
}
