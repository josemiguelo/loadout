package lsp

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/hcl/v2"

	"github.com/josemiguelo/loadout/internal/hclconf"
)

// workspace is the config repo the editor has open: its root, the
// buffers it holds unsaved, and the diagnostics last published.
type workspace struct {
	conn     *conn
	log      logger
	encoding string
	// delay is how long a change waits for the next before the repo is
	// checked: typing checks once it pauses.
	delay time.Duration

	mu        sync.Mutex
	root      string            // "" until a loadout.hcl is found
	docs      map[string][]byte // open buffers, by absolute path
	published map[string]bool   // URIs whose diagnostics were last non-empty
	timer     *time.Timer
	// last is the latest check's analysis: what completion offers.
	last *hclconf.Analysis
	// checking serializes checks, so an older one never publishes after a newer.
	checking sync.Mutex
}

type logger interface{ Printf(format string, v ...any) }

func newWorkspace(c *conn, log logger, delay time.Duration) *workspace {
	return &workspace{conn: c, log: log, delay: delay, encoding: encodingUTF16, docs: map[string][]byte{}, published: map[string]bool{}}
}

// findRoot is the nearest directory from dir up holding loadout.hcl, or "".
func findRoot(dir string) string {
	for {
		if info, err := os.Stat(filepath.Join(dir, hclconf.EntryFile)); err == nil && info.Mode().IsRegular() {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// setRoot looks for the repo from the editor's workspace folder.
func (w *workspace) setRoot(dir string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if dir != "" {
		w.root = findRoot(dir)
	}
	switch {
	case dir == "":
		w.log.Printf("no workspace folder: the repo is found from the first manifest opened")
	case w.root == "":
		w.log.Printf("no %s in %s or above it: the repo is found from the first manifest opened", hclconf.EntryFile, dir)
	}
}

// open, change and close track a buffer; each schedules a check.
func (w *workspace) open(uri string, text string) {
	path, ok := pathOf(uri)
	if !ok {
		return
	}
	w.mu.Lock()
	w.docs[path] = []byte(text)
	if w.root == "" {
		w.root = findRoot(filepath.Dir(path))
	}
	w.mu.Unlock()
	w.check()
}

func (w *workspace) change(uri string, text string) {
	path, ok := pathOf(uri)
	if !ok {
		return
	}
	w.mu.Lock()
	w.docs[path] = []byte(text)
	w.mu.Unlock()
	w.schedule()
}

func (w *workspace) close(uri string) {
	path, ok := pathOf(uri)
	if !ok {
		return
	}
	w.mu.Lock()
	delete(w.docs, path)
	w.mu.Unlock()
	w.check()
}

// schedule checks the repo once changes pause for w.delay.
func (w *workspace) schedule() {
	if w.delay == 0 {
		w.check()
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timer != nil {
		w.timer.Stop()
	}
	w.timer = time.AfterFunc(w.delay, w.check)
}

// check checks the repo with the open buffers over the disk and publishes
// what it finds.
func (w *workspace) check() {
	w.checking.Lock()
	defer w.checking.Unlock()
	w.mu.Lock()
	root := w.root
	overlay := map[string][]byte{}
	for path, src := range w.docs {
		if rel, ok := relative(root, path); ok {
			overlay[rel] = src
		}
	}
	w.mu.Unlock()
	if root == "" {
		return
	}
	analysis, err := hclconf.Check(root, overlay)
	if err != nil {
		w.log.Printf("checking %s: %v", root, err)
		return
	}
	w.mu.Lock()
	w.last = analysis
	w.mu.Unlock()
	w.publish(root, overlay, analysis)
}

// snapshot is the buffer at path (the disk's when it isn't open) and the
// latest analysis, checking the repo first if it hasn't been.
func (w *workspace) snapshot(path string) ([]byte, *hclconf.Analysis) {
	w.mu.Lock()
	last := w.last
	w.mu.Unlock()
	if last == nil {
		w.check()
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	src, ok := w.docs[path]
	if !ok {
		src, _ = os.ReadFile(path)
	}
	return src, w.last
}

// diagnostic is LSP's.
type diagnostic struct {
	Range    lspRange `json:"range"`
	Severity int      `json:"severity"`
	Source   string   `json:"source"`
	Message  string   `json:"message"`
}

const severityError = 1

type publishParams struct {
	URI         string       `json:"uri"`
	Diagnostics []diagnostic `json:"diagnostics"`
}

// publish sends every file's diagnostics, and an empty list to each file
// that had some and has none now.
func (w *workspace) publish(root string, overlay map[string][]byte, a *hclconf.Analysis) {
	sources := map[string][]byte{}
	source := func(file string) []byte {
		if src, ok := sources[file]; ok {
			return src
		}
		src, ok := overlay[file]
		if !ok {
			src, _ = os.ReadFile(absolute(root, file))
		}
		sources[file] = src
		return src
	}
	byFile := map[string][]diagnostic{}
	at := func(file string, r hcl.Range, message string) {
		src := source(file)
		byFile[file] = append(byFile[file], diagnostic{
			Range: lspRange{
				Start: toPosition(src, r.Start.Line, r.Start.Byte, w.encoding),
				End:   toPosition(src, r.End.Line, r.End.Byte, w.encoding),
			},
			Severity: severityError,
			Source:   "loadout",
			Message:  message,
		})
	}
	unplaced := func(message string) {
		at(hclconf.EntryFile, hcl.Range{Start: hcl.InitialPos, End: hcl.InitialPos}, message)
	}
	for _, d := range a.Diagnostics {
		message := d.Summary
		if d.Detail != "" {
			message += "; " + d.Detail
		}
		if d.Subject == nil {
			unplaced(message)
			continue
		}
		at(d.Subject.Filename, *d.Subject, message)
	}
	for _, e := range a.Errors {
		ranges := placeError(e, a.Declarations)
		if len(ranges) == 0 {
			unplaced(e)
		}
		for _, r := range ranges {
			at(r.Filename, r, e)
		}
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	now := map[string]bool{}
	for file, diags := range byFile {
		uri := uriOf(absolute(root, file))
		now[uri] = true
		w.send(publishParams{URI: uri, Diagnostics: diags})
	}
	for uri := range w.published {
		if !now[uri] {
			w.send(publishParams{URI: uri, Diagnostics: []diagnostic{}})
		}
	}
	w.published = now
}

func (w *workspace) send(p publishParams) {
	if err := w.conn.notify("textDocument/publishDiagnostics", p); err != nil {
		w.log.Printf("writing to the editor: %v", err)
	}
}

// named is how the manifest language's errors name a declaration:
// `duplicate program 'bat'`, `machine 'm' installs 'x' twice`.
var named = regexp.MustCompile(`\b(installer|program|script|profile|machine) '([^']+)'`)

// placeError is where error e, which has no position, is about: every
// declaration of the first thing it names (both copies of a duplicate),
// or none.
func placeError(e string, decls []hclconf.Declaration) []hcl.Range {
	m := named.FindStringSubmatch(e)
	if m == nil {
		return nil
	}
	var out []hcl.Range
	for _, d := range decls {
		if d.Kind == m[1] && d.Name == m[2] && d.Range != nil {
			out = append(out, *d.Range)
		}
	}
	return out
}

// pathOf is a file URI's absolute path.
func pathOf(uri string) (string, bool) {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "file" {
		return "", false
	}
	return filepath.FromSlash(u.Path), true
}

func uriOf(path string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
}

// relative is path relative to root, slash-separated, when it's inside it.
func relative(root, path string) (string, bool) {
	if root == "" {
		return "", false
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// absolute is a diagnostic's file as a path: repo-relative, or already
// absolute (a parent's files).
func absolute(root, file string) string {
	if filepath.IsAbs(file) {
		return file
	}
	return filepath.Join(root, filepath.FromSlash(file))
}
