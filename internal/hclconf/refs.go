package hclconf

import (
	"github.com/zclconf/go-cty/cty"
	"github.com/zclconf/go-cty/cty/function"
	"github.com/zclconf/go-cty/cty/function/stdlib"
)

// A reference is what `program.x`, `script.x`, `profile.x`, `installer.x`
// and a bare installer name evaluate to: identity only (its kind and name,
// and what variant() and args() add), so the order declarations evaluate in
// never matters. What a name refers to is looked up after every file is
// read.

// refType is every reference's type: one type, so lists of references
// concat, flatten and distinct like any other values.
var refType = cty.Object(map[string]cty.Type{
	"kind":    cty.String,
	"name":    cty.String,
	"variant": cty.String,
	"args":    cty.List(cty.String),
})

// ref is a reference, decoded.
type ref struct {
	kind, name string
	// variant is variant()'s name, "" when none was picked.
	variant string
	// args is args()' words.
	args []string
}

func refVal(kind, name string) cty.Value {
	return cty.ObjectVal(map[string]cty.Value{
		"kind":    cty.StringVal(kind),
		"name":    cty.StringVal(name),
		"variant": cty.StringVal(""),
		"args":    cty.ListValEmpty(cty.String),
	})
}

func (r ref) value() cty.Value {
	args := cty.ListValEmpty(cty.String)
	if len(r.args) > 0 {
		vals := make([]cty.Value, len(r.args))
		for i, a := range r.args {
			vals[i] = cty.StringVal(a)
		}
		args = cty.ListVal(vals)
	}
	return cty.ObjectVal(map[string]cty.Value{
		"kind":    cty.StringVal(r.kind),
		"name":    cty.StringVal(r.name),
		"variant": cty.StringVal(r.variant),
		"args":    args,
	})
}

// asRef is v as a reference, when it is one.
func asRef(v cty.Value) (ref, bool) {
	if v.IsNull() || !v.IsKnown() || !v.Type().Equals(refType) {
		return ref{}, false
	}
	r := ref{
		kind:    v.GetAttr("kind").AsString(),
		name:    v.GetAttr("name").AsString(),
		variant: v.GetAttr("variant").AsString(),
	}
	for it := v.GetAttr("args").ElementIterator(); it.Next(); {
		_, a := it.Element()
		r.args = append(r.args, a.AsString())
	}
	return r, true
}

// display is how messages write a reference: `program.git`.
func (r ref) display() string { return r.kind + "." + r.name }

// variantFunc is `variant(program.setup-brew, "linux")`: one of a
// program's install variants, or one of a script's variants.
var variantFunc = function.New(&function.Spec{
	Params: []function.Parameter{
		{Name: "of", Type: cty.DynamicPseudoType},
		{Name: "name", Type: cty.String},
	},
	Type: function.StaticReturnType(refType),
	Impl: func(args []cty.Value, _ cty.Type) (cty.Value, error) {
		r, ok := asRef(args[0])
		if !ok || (r.kind != "program" && r.kind != "script") {
			return cty.NilVal, function.NewArgErrorf(0, "variant() takes a program or a script, e.g. variant(program.x, \"linux\")")
		}
		if r.variant != "" {
			return cty.NilVal, function.NewArgErrorf(0, "%s already names variant %q", r.display(), r.variant)
		}
		if len(r.args) > 0 {
			return cty.NilVal, function.NewArgErrorf(0, "pick the variant first: args(variant(%s, …), …)", r.display())
		}
		r.variant = args[1].AsString()
		return r.value(), nil
	},
})

// argsFunc is `args(script.setup-ssh, "t2")`: a script run with arguments,
// each one or more words (contract 12). Lists of words are taken as their
// words.
var argsFunc = function.New(&function.Spec{
	Params: []function.Parameter{{Name: "script", Type: cty.DynamicPseudoType}},
	VarParam: &function.Parameter{
		Name: "args",
		Type: cty.DynamicPseudoType,
	},
	Type: function.StaticReturnType(refType),
	Impl: func(args []cty.Value, _ cty.Type) (cty.Value, error) {
		r, ok := asRef(args[0])
		if !ok || r.kind != "script" {
			return cty.NilVal, function.NewArgErrorf(0, "args() takes a script, e.g. args(script.x, \"word\")")
		}
		if len(r.args) > 0 {
			return cty.NilVal, function.NewArgErrorf(0, "%s already has arguments", r.display())
		}
		for i, a := range args[1:] {
			words, ok := stringsOf(a)
			if !ok {
				return cty.NilVal, function.NewArgErrorf(i+1, "an argument is a string (one or more words)")
			}
			r.args = append(r.args, words...)
		}
		if len(r.args) == 0 {
			return cty.NilVal, function.NewArgErrorf(0, "args() needs at least one argument")
		}
		return r.value(), nil
	},
})

// stringsOf is v as strings: a string, or a list or tuple of them (nested).
func stringsOf(v cty.Value) ([]string, bool) {
	if v.IsNull() || !v.IsKnown() {
		return nil, false
	}
	t := v.Type()
	if t == cty.String {
		return []string{v.AsString()}, true
	}
	if t.IsListType() || t.IsTupleType() || t.IsSetType() {
		var out []string
		for it := v.ElementIterator(); it.Next(); {
			_, e := it.Element()
			words, ok := stringsOf(e)
			if !ok {
				return nil, false
			}
			out = append(out, words...)
		}
		return out, true
	}
	return nil, false
}

// prefixFunc is a one-string function that prefixes `file:`: file() for a
// param value that is a repo file, run_script() for a command that runs one.
func prefixFunc(param string) function.Function {
	return function.New(&function.Spec{
		Params: []function.Parameter{{Name: param, Type: cty.String}},
		Type:   function.StaticReturnType(cty.String),
		Impl: func(args []cty.Value, _ cty.Type) (cty.Value, error) {
			return cty.StringVal("file:" + args[0].AsString()), nil
		},
	})
}

// functions is what every expression may call, user functions aside.
func functions() map[string]function.Function {
	return map[string]function.Function{
		"variant":    variantFunc,
		"args":       argsFunc,
		"file":       prefixFunc("path"),
		"run_script": prefixFunc("command"),

		"chomp":         stdlib.ChompFunc,
		"coalesce":      stdlib.CoalesceFunc,
		"compact":       stdlib.CompactFunc,
		"concat":        stdlib.ConcatFunc,
		"contains":      stdlib.ContainsFunc,
		"distinct":      stdlib.DistinctFunc,
		"element":       stdlib.ElementFunc,
		"flatten":       stdlib.FlattenFunc,
		"format":        stdlib.FormatFunc,
		"formatlist":    stdlib.FormatListFunc,
		"indent":        stdlib.IndentFunc,
		"join":          stdlib.JoinFunc,
		"keys":          stdlib.KeysFunc,
		"length":        stdlib.LengthFunc,
		"lookup":        stdlib.LookupFunc,
		"lower":         stdlib.LowerFunc,
		"merge":         stdlib.MergeFunc,
		"regex_replace": stdlib.RegexReplaceFunc,
		"replace":       stdlib.ReplaceFunc,
		"reverse":       stdlib.ReverseListFunc,
		"setunion":      stdlib.SetUnionFunc,
		"slice":         stdlib.SliceFunc,
		"sort":          stdlib.SortFunc,
		"split":         stdlib.SplitFunc,
		"substr":        stdlib.SubstrFunc,
		"title":         stdlib.TitleFunc,
		"trim":          stdlib.TrimFunc,
		"trimprefix":    stdlib.TrimPrefixFunc,
		"trimspace":     stdlib.TrimSpaceFunc,
		"trimsuffix":    stdlib.TrimSuffixFunc,
		"upper":         stdlib.UpperFunc,
		"values":        stdlib.ValuesFunc,
	}
}
