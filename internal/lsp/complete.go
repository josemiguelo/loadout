package lsp

import (
	"regexp"
	"slices"
	"strings"

	"github.com/josemiguelo/loadout/internal/hclconf"
)

// Completion: what may go at the cursor, from the language's shape
// (hclconf.ShapeOf) and the repo's names (hclconf.Analysis), at the place
// scan reads off the text before the cursor.

type completionItem struct {
	Label            string   `json:"label"`
	Kind             int      `json:"kind"`
	Detail           string   `json:"detail,omitempty"`
	FilterText       string   `json:"filterText"`
	InsertTextFormat int      `json:"insertTextFormat"`
	TextEdit         textEdit `json:"textEdit"`
}

type textEdit struct {
	Range   lspRange `json:"range"`
	NewText string   `json:"newText"`
}

type completionList struct {
	IsIncomplete bool             `json:"isIncomplete"`
	Items        []completionItem `json:"items"`
}

// CompletionItemKind values.
const (
	itemFunction  = 3
	itemField     = 5
	itemVariable  = 6
	itemClass     = 7
	itemInterface = 8
	itemModule    = 9
	itemProperty  = 10
	itemValue     = 12
	itemKeyword   = 14
	itemFolder    = 19
)

// InsertTextFormat values.
const (
	formatPlain   = 1
	formatSnippet = 2
)

// kinds is what each reference kind's names show as.
var kinds = map[string]int{
	"program":   itemModule,
	"script":    itemFunction,
	"profile":   itemFolder,
	"installer": itemInterface,
	"local":     itemVariable,
}

// prefixes is the reference kinds, offered where any value may start.
var prefixes = []string{"program", "script", "profile", "installer", "local"}

var (
	// qualified is `<kind>.<partial name>` ending at the cursor.
	qualified = regexp.MustCompile(`(?:^|[^\w.-])([A-Za-z_][\w-]*)\.([\w-]*)$`)
	// partialWord is the name being typed at the cursor, not after a dot.
	partialWord = regexp.MustCompile(`(?:^|[^\w.-])([\w-]*)$`)
	// labelStart is a block's first label being typed: `via "bre`.
	labelStart = regexp.MustCompile(`^\s*([A-Za-z_][\w-]*)\s+"([\w-]*)$`)
	// variantArg is variant()'s second argument being typed.
	variantArg = regexp.MustCompile(`variant\(\s*(program|script)\.([\w-]+)\s*,\s*"([\w-]*)$`)
)

// completer is one completion request: the text, the cursor, and what the
// repo declares.
type completer struct {
	src      []byte
	off      int
	line     int
	encoding string
	a        *hclconf.Analysis
	entry    bool // the file is the repo's loadout.hcl
	items    []completionItem
}

// complete is what to offer at offset off in src, on line (LSP's, from 0).
func complete(src []byte, off int, line int, encoding string, a *hclconf.Analysis, entry bool) completionList {
	if a == nil {
		a = &hclconf.Analysis{}
	}
	c := &completer{src: src, off: off, line: line, encoding: encoding, a: a, entry: entry}
	c.run()
	if c.items == nil {
		c.items = []completionItem{}
	}
	return completionList{Items: c.items}
}

func (c *completer) run() {
	before := c.src[:c.off]
	tail := string(before[strings.LastIndexByte(string(before), '\n')+1:])
	at := scan(before)
	if at.quoted {
		c.inString(at, tail)
		return
	}
	if m := qualified.FindStringSubmatch(tail); m != nil {
		if _, ok := kinds[m[1]]; ok {
			c.names(m[1], m[2], false)
		}
		return
	}
	m := partialWord.FindStringSubmatch(tail)
	if m == nil {
		return
	}
	partial := m[1]
	switch {
	case at.objectKey:
		c.objectKeys(at, partial)
	case at.attr != "":
		c.value(at, partial)
	case at.statementTokens > 0:
		// a block header or a broken line: nothing goes here
	default:
		c.body(at.path, at.set, partial)
	}
}

// body is what a block at path may still hold: its attributes not yet
// set, and its blocks.
func (c *completer) body(path, set []string, partial string) {
	shape, ok := hclconf.ShapeOf(path...)
	if !ok || shape.Free {
		return
	}
	r := c.replace(partial)
	for _, a := range shape.Attrs {
		if slices.Contains(set, a.Name) {
			continue
		}
		c.add(completionItem{Label: a.Name, Kind: itemProperty, Detail: describe(a), FilterText: a.Name,
			InsertTextFormat: formatSnippet, TextEdit: textEdit{Range: r, NewText: a.Name + " = " + valueSnippet(a.Value)}})
	}
	for _, b := range shape.Blocks {
		if len(path) == 0 && (b.Type == "repo" && !c.entry || b.Type == "data" && c.a.HasData) {
			continue
		}
		snippet := b.Type + " {\n\t$0\n}"
		detail := b.Type + " block"
		if b.Labels[0] > 0 {
			snippet = b.Type + ` "${1}" {` + "\n\t$0\n}"
			detail = b.Type + ` "<name>" block`
			if b.LabelRefs != "" {
				detail = b.Type + ` "<` + b.LabelRefs + `>" block`
			}
		}
		c.add(completionItem{Label: b.Type, Kind: itemClass, Detail: detail, FilterText: b.Type,
			InsertTextFormat: formatSnippet, TextEdit: textEdit{Range: r, NewText: snippet}})
	}
}

// describe is an attribute's detail: what it takes.
func describe(a hclconf.Attr) string {
	switch a.Value {
	case hclconf.ValueRefs:
		var kinds []string
		for _, k := range a.Refs {
			kinds = append(kinds, k+"s")
		}
		return "list of " + strings.Join(kinds, " and ")
	case hclconf.ValueCommands:
		return "command, or list of commands"
	case hclconf.ValueParams:
		return "the installer's params"
	case hclconf.ValueData:
		return "data settings"
	case hclconf.ValueList:
		return "list of strings"
	case hclconf.ValueNames:
		return "list of names"
	case hclconf.ValueName:
		return "name"
	case hclconf.ValueExpr:
		return "expression"
	}
	return string(a.Value)
}

// valueSnippet is what an attribute's value starts as.
func valueSnippet(v hclconf.Value) string {
	switch v {
	case hclconf.ValueString, hclconf.ValueCommands:
		return `"${1}"`
	case hclconf.ValueList, hclconf.ValueRefs, hclconf.ValueNames:
		return "[${1}]"
	case hclconf.ValueFlag:
		return "${1:true}"
	case hclconf.ValueParams, hclconf.ValueData:
		return "{\n\t$0\n}"
	}
	return "${1}"
}

// value is what may go where attribute at.attr's value starts.
func (c *completer) value(at cursor, partial string) {
	shape, ok := hclconf.ShapeOf(at.path...)
	if !ok {
		return
	}
	if shape.Free {
		if len(at.path) > 0 && at.path[0] == "data" {
			c.dataKinds(partial)
		} else {
			c.anyValue(partial)
		}
		return
	}
	i := slices.IndexFunc(shape.Attrs, func(a hclconf.Attr) bool { return a.Name == at.attr })
	if i < 0 {
		return
	}
	a := shape.Attrs[i]
	switch a.Value {
	case hclconf.ValueRefs:
		for _, kind := range a.Refs {
			c.names(kind, partial, kind != "installer")
		}
		c.names("local", partial, true)
		// variant() and args() pick a machine's own installs and runs; a via
		// block names programs alone.
		c.functions(partial, true, len(at.path) == 1 && (at.attr == "install" || at.attr == "run"))
	case hclconf.ValueFlag:
		c.literals(partial, "true", "false")
	case hclconf.ValueData:
		if len(at.objects) > 0 {
			if k := dataKey(c.a.Data, at.objects); k != nil && k.Kind == "flag" {
				c.literals(partial, "true", "false")
			}
		}
	case hclconf.ValueExpr:
		c.anyValue(partial)
	}
}

// objectKeys is the keys an object value may still take: data settings,
// or a variant's params.
func (c *completer) objectKeys(at cursor, partial string) {
	shape, ok := hclconf.ShapeOf(at.path...)
	if !ok {
		return
	}
	i := slices.IndexFunc(shape.Attrs, func(a hclconf.Attr) bool { return a.Name == at.attr })
	if i < 0 {
		return
	}
	r := c.replace(partial)
	switch shape.Attrs[i].Value {
	case hclconf.ValueData:
		for _, k := range dataTable(c.a.Data, at.objects) {
			if slices.Contains(at.objectSet, k.Name) {
				continue
			}
			c.add(completionItem{Label: k.Name, Kind: itemField, Detail: "data · " + k.Kind, FilterText: k.Name,
				InsertTextFormat: formatSnippet, TextEdit: textEdit{Range: r, NewText: k.Name + " = " + dataSnippet(k.Kind)}})
		}
	case hclconf.ValueParams:
		if len(at.objects) > 0 || len(at.labels) == 0 || at.path[len(at.path)-1] != "via" {
			return
		}
		installer := at.labels[len(at.labels)-1]
		for _, d := range unique(c.a, "installer") {
			if d.Name != installer {
				continue
			}
			for _, p := range d.Params {
				if !slices.Contains(at.objectSet, p) {
					c.add(completionItem{Label: p, Kind: itemField, Detail: installer + " param", FilterText: p,
						InsertTextFormat: formatSnippet, TextEdit: textEdit{Range: r, NewText: p + ` = "${1}"`}})
				}
			}
		}
	}
}

// dataTable is the schema's keys in the table path leads to.
func dataTable(keys []hclconf.DataKey, path []string) []hclconf.DataKey {
	for _, step := range path {
		k := dataKey(keys, []string{step})
		if k == nil || k.Kind != "table" {
			return nil
		}
		keys = k.Table
	}
	return keys
}

// dataKey is the schema's key at path.
func dataKey(keys []hclconf.DataKey, path []string) *hclconf.DataKey {
	var found *hclconf.DataKey
	for _, step := range path {
		i := slices.IndexFunc(keys, func(k hclconf.DataKey) bool { return k.Name == step })
		if i < 0 {
			return nil
		}
		found = &keys[i]
		keys = found.Table
	}
	return found
}

func dataSnippet(kind string) string {
	switch kind {
	case "flag":
		return "${1:true}"
	case "text":
		return `"${1}"`
	case "list":
		return "[${1}]"
	case "table":
		return "{\n\t$0\n}"
	}
	return "${1}"
}

// dataKinds is what a data schema key is declared with.
func (c *completer) dataKinds(partial string) {
	r := c.replace(partial)
	for _, k := range []struct{ name, snippet, detail string }{
		{"flag", "flag(${1:false})", "a boolean, with its default"},
		{"text", `text("${1}")`, "a string, with its default"},
		{"number", "number(${1:0})", "a number, with its default"},
		{"whole", "whole(${1:0})", "a whole number, with its default"},
		{"list", "list([${1}])", "a list, with its default"},
	} {
		c.add(completionItem{Label: k.name, Kind: itemFunction, Detail: k.detail, FilterText: k.name,
			InsertTextFormat: formatSnippet, TextEdit: textEdit{Range: r, NewText: k.snippet}})
	}
}

// anyValue is what any expression may start with: the installers, the
// reference kinds and the functions.
func (c *completer) anyValue(partial string) {
	c.names("installer", partial, false)
	r := c.replace(partial)
	for _, p := range prefixes {
		c.add(completionItem{Label: p + ".", Kind: itemKeyword, Detail: "a " + p + " by name", FilterText: p,
			InsertTextFormat: formatPlain, TextEdit: textEdit{Range: r, NewText: p + "."}})
	}
	c.functions(partial, false, true)
}

// functions is the repo's functions, then the language's: all of them, or,
// when onlyPickers, just args() and variant() (when withPickers).
func (c *completer) functions(partial string, onlyPickers, withPickers bool) {
	r := c.replace(partial)
	for _, d := range unique(c.a, "function") {
		c.add(completionItem{Label: d.Name, Kind: itemFunction, Detail: detail(d), FilterText: d.Name,
			InsertTextFormat: formatSnippet, TextEdit: textEdit{Range: r, NewText: d.Name + "(${1})"}})
	}
	for _, name := range hclconf.FunctionNames() {
		picker := name == "args" || name == "variant"
		if picker && !withPickers || onlyPickers && !picker {
			continue
		}
		snippet := name + "(${1})"
		switch name {
		case "variant":
			snippet = `variant(${1}, "${2}")`
		case "args":
			snippet = "args(${1}, ${2})"
		}
		c.add(completionItem{Label: name, Kind: itemFunction, Detail: "function", FilterText: name,
			InsertTextFormat: formatSnippet, TextEdit: textEdit{Range: r, NewText: snippet}})
	}
}

func (c *completer) literals(partial string, values ...string) {
	r := c.replace(partial)
	for _, v := range values {
		c.add(completionItem{Label: v, Kind: itemValue, FilterText: v, InsertTextFormat: formatPlain, TextEdit: textEdit{Range: r, NewText: v}})
	}
}

// names is kind's declared names, replacing partial: each as `<kind>.<name>`
// when qualify, bare otherwise.
func (c *completer) names(kind, partial string, qualify bool) {
	r := c.replace(partial)
	for _, d := range unique(c.a, kind) {
		text := d.Name
		if qualify {
			text = kind + "." + d.Name
		}
		c.add(completionItem{Label: text, Kind: kinds[kind], Detail: detail(d), FilterText: text,
			InsertTextFormat: formatPlain, TextEdit: textEdit{Range: r, NewText: text}})
	}
}

// inString is what goes inside a string: a block's first label when it
// names something (`via "brew"`), or variant()'s variant.
func (c *completer) inString(at cursor, tail string) {
	if m := variantArg.FindStringSubmatch(tail); m != nil {
		r := c.replace(m[3])
		for _, d := range unique(c.a, m[1]) {
			if d.Name != m[2] {
				continue
			}
			for _, v := range d.Variants {
				c.add(completionItem{Label: v, Kind: itemValue, Detail: m[1] + " " + d.Name + "'s variant", FilterText: v,
					InsertTextFormat: formatPlain, TextEdit: textEdit{Range: r, NewText: v}})
			}
		}
		return
	}
	m := labelStart.FindStringSubmatch(tail)
	if m == nil || at.attr != "" || at.objectKey || at.statementTokens != 1 {
		return
	}
	shape, ok := hclconf.ShapeOf(at.path...)
	if !ok {
		return
	}
	i := slices.IndexFunc(shape.Blocks, func(b hclconf.Block) bool { return b.Type == m[1] })
	if i < 0 || shape.Blocks[i].LabelRefs == "" {
		return
	}
	c.names(shape.Blocks[i].LabelRefs, m[2], false)
}

func (c *completer) add(it completionItem) { c.items = append(c.items, it) }

// replace is the range of partial, ending at the cursor.
func (c *completer) replace(partial string) lspRange {
	start := toPosition(c.src, c.line+1, c.off-len(partial), c.encoding)
	return lspRange{Start: start, End: toPosition(c.src, c.line+1, c.off, c.encoding)}
}

// detail is where d is declared.
func detail(d hclconf.Declaration) string {
	switch {
	case d.Range != nil:
		return d.Kind + " · " + d.Range.Filename
	case d.Kind == "installer":
		return "built-in installer (or the parent's)"
	}
	return d.Kind + " · parent"
}

// unique is a's declarations of kind, one per name: where it's declared in
// this repo when it is (a built-in installer the repo redefines, a name
// declared twice).
func unique(a *hclconf.Analysis, kind string) []hclconf.Declaration {
	if a == nil {
		return nil
	}
	var out []hclconf.Declaration
	at := map[string]int{}
	for _, d := range a.Declarations {
		if d.Kind != kind {
			continue
		}
		if i, seen := at[d.Name]; seen {
			if out[i].Range == nil && d.Range != nil {
				out[i] = d
			}
			continue
		}
		at[d.Name] = len(out)
		out = append(out, d)
	}
	return out
}
