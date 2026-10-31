package hclconf

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/hashicorp/hcl/v2"

	"github.com/josemiguelo/loadout/internal/model"
)

// Analysis is what an editor needs from the manifests, whatever their
// mistakes: what they name and everything wrong with them.
type Analysis struct {
	// Declarations is every name a reference may use, and the machines:
	// the built-in installers, the parent's declarations, then each file's
	// in order.
	Declarations []Declaration
	// Diagnostics is HCL's, all of them: syntax, unknown names, wrong
	// types, each with its position.
	Diagnostics hcl.Diagnostics
	// Errors is the manifest language's own mistakes (Decoded.Errors),
	// which have no position.
	Errors []string
	// Data is the data schema's keys (the parent's, for a child without
	// one); HasData says whether there is a schema at all.
	Data    []DataKey
	HasData bool
}

// DataKey is one key of the data schema.
type DataKey struct {
	Name string
	// Kind is flag, text, number, whole, list or table.
	Kind string
	// Table is a table's keys.
	Table []DataKey
}

// Declaration is one name a reference may use (`<Kind>.<Name>`), a
// function, or a machine.
type Declaration struct {
	// Kind is installer, program, script, profile, local, function or
	// machine.
	Kind, Name string
	// Range is the name where it's declared (a block's label, a local's
	// name); nil for a built-in installer and the parent's declarations.
	Range *hcl.Range
	// Variants is a program's install variants or a script's variants:
	// what variant() picks.
	Variants []string
	// Params is an installer's params: what its variants' `params` set.
	Params []string
}

// Analyze decodes files as Decode does, through every pass, without
// stopping at a mistake. A file that doesn't parse adds its syntax errors
// and the names HCL recovered from it, nothing else.
func Analyze(files []File, opts Options) *Analysis {
	a, _ := analyze(files, opts)
	return a
}

// analyze is Analyze and what files declare, which is complete only when
// the analysis found nothing wrong.
func analyze(files []File, opts Options) (*Analysis, *Decoded) {
	d := &decoder{opts: opts, out: &Decoded{variants: map[string][]string{}}}
	syntax := d.parse(files)
	d.decodeAll()
	d.out.Errors = d.errors
	d.out.schema = d.schema
	return &Analysis{
		Declarations: d.declarations(),
		Diagnostics:  append(syntax, d.diags...),
		Errors:       model.Distinct(d.errors),
		Data:         dataKeys(d.schema),
		HasData:      d.schema != nil,
	}, d.out
}

// Check is everything compile would refuse in the repo at root, writing
// nothing. A repo-relative path in overlay is read from there instead of
// the disk (an editor's unsaved buffers), and one the sources globs match
// that isn't on disk yet is checked too. The globs are read past a syntax
// error in the entry file, from what HCL recovered of it; an entry file
// whose repo block can't be read is checked alone: without its globs, no
// other file is known. The error is an I/O error, or root having no entry
// file.
func Check(root string, overlay map[string][]byte) (*Analysis, error) {
	repo, err := readRepoFiles(root, overlay, true)
	var diags *DiagnosticsError
	var refusal model.Refusal
	switch {
	case errors.As(err, &diags):
		entry, ok := overlay[EntryFile]
		if !ok {
			if entry, err = os.ReadFile(filepath.Join(root, EntryFile)); err != nil {
				return nil, err
			}
		}
		return Analyze([]File{{Path: EntryFile, Src: entry}}, Options{}), nil
	case errors.As(err, &refusal):
		return &Analysis{Errors: []string{err.Error()}}, nil
	case err != nil:
		return nil, err
	}
	a, decoded := analyze(repo.files, repo.opts())
	if len(a.Diagnostics) > 0 || len(a.Errors) > 0 {
		return a, nil
	}
	if _, _, err := repo.assemble(decoded); err != nil {
		if !errors.As(err, &refusal) {
			return nil, err
		}
		a.Errors = refusalLines(err.Error())
	}
	return a, nil
}

// refusalLines is a refusal's message as one error per mistake: an
// "Invalid manifest:" list is split into its items.
func refusalLines(message string) []string {
	items, ok := strings.CutPrefix(message, "Invalid manifest:\n  - ")
	if !ok {
		return []string{message}
	}
	return strings.Split(items, "\n  - ")
}

// declarations is every name the namespace holds, with where it's declared.
func (d *decoder) declarations() []Declaration {
	var out []Declaration
	library := model.InstallerLibrary()
	for _, n := range library.Keys() {
		out = append(out, Declaration{Kind: "installer", Name: n, Params: library.Value(n).Params})
	}
	if p := d.opts.Parent; p != nil {
		m := p.Draft.Manifest
		for _, n := range m.Installers.Keys() {
			out = append(out, Declaration{Kind: "installer", Name: n, Params: m.Installers.Value(n).Params})
		}
		for _, n := range m.Programs.Keys() {
			out = append(out, Declaration{Kind: "program", Name: n, Variants: m.Programs.Value(n).Install.Keys()})
		}
		for _, n := range m.Scripts.Keys() {
			out = append(out, Declaration{Kind: "script", Name: n, Variants: m.Scripts.Value(n).Variants.Keys()})
		}
		for _, n := range p.Draft.Profiles.Keys() {
			out = append(out, Declaration{Kind: "profile", Name: n})
		}
	}
	m := d.out.Draft.Manifest
	for _, b := range slices.Concat(d.blocks, d.broken) {
		decl := Declaration{Kind: b.block.Type}
		if len(b.block.Labels) > 0 {
			decl.Name, decl.Range = b.block.Labels[0], b.block.LabelRanges[0].Ptr()
		}
		switch b.block.Type {
		case "installer":
			decl.Params = m.Installers.Value(decl.Name).Params
		case "program":
			decl.Variants = d.out.variants[decl.Name]
		case "script":
			decl.Variants = m.Scripts.Value(decl.Name).Variants.Keys()
		case "profile", "machine", "function":
		case "locals":
			for _, a := range sortedAttrs(b.block.Body) {
				out = append(out, Declaration{Kind: "local", Name: a.Name, Range: a.NameRange.Ptr()})
			}
			continue
		default:
			continue
		}
		out = append(out, decl)
	}
	return out
}

// dataKeys is schema's keys, in declaration order.
func dataKeys(schema *dataSchema) []DataKey {
	if schema == nil {
		return nil
	}
	var out []DataKey
	for _, k := range schema.keys {
		out = append(out, DataKey{Name: k, Kind: schema.kinds[k], Table: dataKeys(schema.table[k])})
	}
	return out
}
