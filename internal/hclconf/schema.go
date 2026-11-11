package hclconf

import (
	"slices"
	"strings"
)

// The manifest language's shape, for the language server: what each block
// may hold, from the same specs the decoder checks, and what each
// attribute takes.

// Value is what an attribute takes.
type Value string

const (
	ValueString   Value = "string"   // "…"
	ValueList     Value = "list"     // ["…", …]
	ValueFlag     Value = "flag"     // true or false
	ValueRefs     Value = "refs"     // [<kind>.<name>, …], Attr.Refs's kinds
	ValueCommands Value = "commands" // "…" or ["…", …]
	ValueParams   Value = "params"   // { <param> = "…" }: the installer's params
	ValueData     Value = "data"     // { <key> = … }: the data schema's keys
	ValueNames    Value = "names"    // [name, …]: bare names
	ValueName     Value = "name"     // a bare name
	ValueExpr     Value = "expr"     // any expression
)

// Attr is an attribute a block may hold.
type Attr struct {
	Name  string
	Value Value
	// Refs is the kinds a ValueRefs attribute names.
	Refs []string
}

// Block is a block a body may hold.
type Block struct {
	Type string
	// Labels is how many labels it takes, at least and at most.
	Labels [2]int
	// LabelRefs is the kind its label names ("installer"), or "" for a
	// name of its own.
	LabelRefs string
}

// Shape is what a block's body may hold.
type Shape struct {
	Attrs  []Attr
	Blocks []Block
	// Free is a body whose keys are the author's (locals, the data schema):
	// nothing to offer for them.
	Free bool
}

// shapes is every block's shape by path: its type and its ancestors'
// (`program/via/provides`), "" for a file's top level.
var shapes = map[string]Shape{}

// shapeSpecs is each path's spec and what its attributes take; init turns
// them into shapes, and a test holds every spec attribute to a value.
var shapeSpecs = map[string]struct {
	spec   spec
	values map[string]Attr
	labels map[string]string // block type -> the kind its label names
}{
	"":            {spec: topLevel, labels: map[string]string{"requires": "installer"}},
	"repo":        {spec: repoSpec, values: strs("name", "state", "configs", "min_tool_version").with(Attr{Name: "sources", Value: ValueList})},
	"repo/parent": {spec: parentSpec, values: strs("name", "path")},
	"function": {spec: functionSpec, values: values(
		Attr{Name: "params", Value: ValueNames}, Attr{Name: "variadic_param", Value: ValueName}, Attr{Name: "result", Value: ValueExpr})},
	"installer": {spec: installerSpec, values: strs("probe", "install", "check", "regex", "outdated", "outdated_all", "upgrade", "spare").with(
		Attr{Name: "needs_sudo", Value: ValueFlag}, Attr{Name: "params", Value: ValueList})},
	"requires": {spec: requiresSpec, values: values(refs("programs", "program"))},
	"program": {spec: programSpec, labels: map[string]string{"via": "installer"}, values: strs(
		"description", "version", "regex", "outdated", "upgrade", "updates_managed_by", "spare", "later").with(
		Attr{Name: "tags", Value: ValueList}, Attr{Name: "path", Value: ValueList},
		refs("depends_on", "program"), refs("install_via", "installer"))},
	"program/via":             {spec: variantSpec, values: variantValues},
	"program/custom":          {spec: variantSpec, values: variantValues},
	"program/via/provides":    {spec: providesSpec, values: strs("at")},
	"program/custom/provides": {spec: providesSpec, values: strs("at")},
	"script": {spec: scriptSpec, values: strs("description", "file", "managed_by", "spare", "updates_managed_by", "later").with(
		Attr{Name: "run", Value: ValueCommands}, Attr{Name: "check", Value: ValueCommands},
		Attr{Name: "needs_sudo", Value: ValueFlag}, Attr{Name: "setup_only", Value: ValueFlag},
		Attr{Name: "maintain_only", Value: ValueFlag}, Attr{Name: "transitional", Value: ValueFlag},
		refs("run_after", "program", "script"))},
	"script/variant": {spec: scriptVariantSpec, values: strs("file", "managed_by", "spare").with(
		Attr{Name: "run", Value: ValueCommands}, Attr{Name: "check", Value: ValueCommands},
		Attr{Name: "transitional", Value: ValueFlag}, refs("run_after", "program", "script"))},
	"script/outdated": {spec: outdatedSpec, values: outdatedValues},
	"outdated":        {spec: outdatedSpec, values: outdatedValues},
	"profile":         {spec: machineSpec, values: machineValues, labels: map[string]string{"via": "installer"}},
	"machine":         {spec: machineSpec, values: machineValues, labels: map[string]string{"via": "installer"}},
	"profile/via":     {spec: machineViaSpec, values: values(refs("install", "program"))},
	"machine/via":     {spec: machineViaSpec, values: values(refs("install", "program"))},
}

var (
	variantValues = strs("pkg", "command", "installed_by", "managed_by", "version", "present", "regex", "probe", "outdated", "spare").with(
		Attr{Name: "needs_sudo", Value: ValueFlag}, refs("depends_on", "program"), Attr{Name: "params", Value: ValueParams})
	outdatedValues = strs("name", "command", "upgrade").with(Attr{Name: "needs_sudo", Value: ValueFlag})
	machineValues  = values(refs("extends", "profile"), refs("install", "program"), refs("run", "script"),
		Attr{Name: "data", Value: ValueData}, Attr{Name: "spare", Value: ValueString})
)

type attrValues map[string]Attr

func values(attrs ...Attr) attrValues {
	out := attrValues{}
	for _, a := range attrs {
		out[a.Name] = a
	}
	return out
}

func strs(names ...string) attrValues {
	out := attrValues{}
	for _, n := range names {
		out[n] = Attr{Name: n, Value: ValueString}
	}
	return out
}

func (v attrValues) with(attrs ...Attr) attrValues {
	for _, a := range attrs {
		v[a.Name] = a
	}
	return v
}

func refs(name string, kinds ...string) Attr { return Attr{Name: name, Value: ValueRefs, Refs: kinds} }

func init() {
	for path, s := range shapeSpecs {
		var shape Shape
		for _, name := range s.spec.attrs {
			shape.Attrs = append(shape.Attrs, s.values[name])
		}
		for typ, labels := range s.spec.blocks {
			shape.Blocks = append(shape.Blocks, Block{Type: typ, Labels: labels, LabelRefs: s.labels[typ]})
		}
		slices.SortFunc(shape.Blocks, func(a, b Block) int { return strings.Compare(a.Type, b.Type) })
		shapes[path] = shape
	}
	shapes["locals"] = Shape{Free: true}
	shapes["data"] = Shape{Free: true}
}

// ShapeOf is what the block at path may hold: path is the block types from
// the file's top level in (none for the top level itself). A table inside
// the data schema is free like the schema; a path the language doesn't
// have is false.
func ShapeOf(path ...string) (Shape, bool) {
	if len(path) > 0 && path[0] == "data" {
		return shapes["data"], true
	}
	s, ok := shapes[strings.Join(path, "/")]
	return s, ok
}
