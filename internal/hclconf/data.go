package hclconf

import (
	"fmt"
	"slices"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"

	"github.com/josemiguelo/loadout/internal/model"
)

// The machine-data schema: `data { … }`
// declares every key with its default, through flag/text/number/whole/list
// (which exist only there) and nested blocks for tables. A machine's or
// profile's `data = { … }` is checked against it and kept as written, so
// two profiles that disagree are still an error (contract 2).

// dataSchema is one table of the schema: its keys in declaration order.
type dataSchema struct {
	keys  []string
	kinds map[string]string // flag, text, number, whole, list, table
	table map[string]*dataSchema
}

// kindNames is each kind as messages call it (model.ValidateData's words).
var kindNames = map[string]string{
	"flag": "boolean", "text": "string", "number": "number", "whole": "whole number", "list": "list", "table": "table",
}

// decodeSchema is the data block's schema and its defaults.
func (d *decoder) decodeSchema(body *hclsyntax.Body) (*dataSchema, model.JSONObject) {
	schema := &dataSchema{kinds: map[string]string{}, table: map[string]*dataSchema{}}
	var defaults model.JSONObject
	type entry struct {
		name  string
		start int
		attr  *hclsyntax.Attribute
		block *hclsyntax.Block
	}
	var entries []entry
	for _, a := range body.Attributes {
		entries = append(entries, entry{name: a.Name, start: a.SrcRange.Start.Byte, attr: a})
	}
	for _, b := range body.Blocks {
		entries = append(entries, entry{name: b.Type, start: b.TypeRange.Start.Byte, block: b})
	}
	slices.SortFunc(entries, func(a, b entry) int { return a.start - b.start })
	for _, e := range entries {
		if _, dup := schema.kinds[e.name]; dup {
			var at hcl.Range
			if e.attr != nil {
				at = e.attr.NameRange
			} else {
				at = e.block.TypeRange
			}
			d.diags = append(d.diags, diag(at, "Duplicate data key", "The data key %q is already declared in this table.", e.name))
			continue
		}
		if e.block != nil {
			d.diags = append(d.diags, checkLabels(e.block, [2]int{0, 0})...)
			sub, subDefaults := d.decodeSchema(e.block.Body)
			schema.keys = append(schema.keys, e.name)
			schema.kinds[e.name] = "table"
			schema.table[e.name] = sub
			defaults.Set(e.name, subDefaults)
			continue
		}
		kind, value, ok := d.dataDefault(e.attr)
		if !ok {
			continue
		}
		schema.keys = append(schema.keys, e.name)
		schema.kinds[e.name] = kind
		defaults.Set(e.name, value)
	}
	return schema, defaults
}

// dataDefault is one `key = kind(default)` line.
func (d *decoder) dataDefault(attr *hclsyntax.Attribute) (string, any, bool) {
	call, ok := attr.Expr.(*hclsyntax.FunctionCallExpr)
	if !ok || kindNames[call.Name] == "" || call.Name == "table" || len(call.Args) != 1 || call.ExpandFinal {
		d.diags = append(d.diags, diag(attr.Expr.Range(), "Invalid data key", "A data key is declared with its default: flag(false), text(\"x\"), number(0.5), whole(3) or list([\"a\"]); a table is a block."))
		return "", nil, false
	}
	v, diags := call.Args[0].Value(d.ctx)
	d.diags = append(d.diags, diags...)
	if diags.HasErrors() {
		return "", nil, false
	}
	value, problem := dataValue(call.Name, v)
	if problem != "" {
		d.diags = append(d.diags, diag(call.Args[0].Range(), "Invalid default", "%s() takes a %s; this is %s.", call.Name, kindNames[call.Name], problem))
		return "", nil, false
	}
	return call.Name, value, true
}

// dataValue is v as a JSON value of kind, or why it isn't one (its kind as
// messages call it).
func dataValue(kind string, v cty.Value) (any, string) {
	if v.IsNull() || !v.IsWhollyKnown() {
		return nil, "null"
	}
	t := v.Type()
	switch kind {
	case "flag":
		if t == cty.Bool {
			return v.True(), ""
		}
	case "text":
		if t == cty.String {
			return v.AsString(), ""
		}
	case "number":
		if t == cty.Number {
			f, _ := v.AsBigFloat().Float64()
			return f, ""
		}
	case "whole":
		if t == cty.Number {
			if !v.AsBigFloat().IsInt() {
				return nil, "a number with a fraction"
			}
			n, _ := v.AsBigFloat().Int64()
			return n, ""
		}
	case "list":
		if t.IsListType() || t.IsTupleType() || t.IsSetType() {
			list := []any{}
			for it := v.ElementIterator(); it.Next(); {
				_, e := it.Element()
				if e.IsNull() || e.Type() != cty.String {
					return nil, "a list holding a " + ctyKind(e)
				}
				list = append(list, e.AsString())
			}
			return list, ""
		}
	}
	return nil, "a " + ctyKind(v)
}

// ctyKind is v's kind as data messages call it.
func ctyKind(v cty.Value) string {
	if v.IsNull() {
		return "null"
	}
	t := v.Type()
	switch {
	case t == cty.Bool:
		return "boolean"
	case t == cty.String:
		return "string"
	case t == cty.Number:
		return "number"
	case t.IsListType() || t.IsTupleType() || t.IsSetType():
		return "list"
	case t.IsObjectType() || t.IsMapType():
		return "table"
	}
	return t.FriendlyName()
}

// machineData is a machine's or profile's `data = { … }`, as written,
// checked against schema; errors name label and the dotted key.
func machineData(schema *dataSchema, v cty.Value, label, prefix string) (model.JSONObject, []string) {
	var out model.JSONObject
	var errors []string
	if schema == nil {
		schema = &dataSchema{}
	}
	for it := v.ElementIterator(); it.Next(); {
		k, value := it.Element()
		key := k.AsString()
		p := prefix + key
		kind, ok := schema.kinds[key]
		if !ok {
			errors = append(errors, label+": data key '"+p+"' is not declared in the data schema")
			continue
		}
		if kind == "table" {
			t := value.Type()
			if value.IsNull() || !(t.IsObjectType() || t.IsMapType()) {
				errors = append(errors, fmt.Sprintf("%s: data key '%s' is a %s, but the data schema declares a table", label, p, ctyKind(value)))
				continue
			}
			table, errs := machineData(schema.table[key], value, label, p+".")
			errors = append(errors, errs...)
			out.Set(key, table)
			continue
		}
		converted, problem := dataValue(kind, value)
		if problem != "" {
			errors = append(errors, fmt.Sprintf("%s: data key '%s' is %s, but the data schema declares a %s", label, p, problem, kindNames[kind]))
			continue
		}
		out.Set(key, converted)
	}
	return out, errors
}

// decodeMachineData is body's `data` attribute.
func (d *decoder) decodeMachineData(body *hclsyntax.Body, label string) model.JSONObject {
	attr := body.Attributes["data"]
	v := d.value(attr)
	if v == nil {
		return model.JSONObject{}
	}
	if t := v.Type(); !(t.IsObjectType() || t.IsMapType()) {
		d.typeError(attr, "object")
		return model.JSONObject{}
	}
	data, errors := machineData(d.schema, *v, label, "")
	d.errors = append(d.errors, errors...)
	return data
}
