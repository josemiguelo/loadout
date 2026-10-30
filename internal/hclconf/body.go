package hclconf

import (
	"fmt"
	"slices"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"
	"github.com/zclconf/go-cty/cty/convert"
)

// DiagnosticsError is what HCL says is wrong with the manifests: syntax,
// unknown names, values of the wrong type. Each line is one diagnostic,
// `<file>:<line>,<col>: <summary>; <detail>`, the file relative to the repo
// root; Error joins them so that main's one `error: ` prefix starts every
// line.
type DiagnosticsError struct{ Lines []string }

func (e *DiagnosticsError) Error() string { return strings.Join(e.Lines, "\nerror: ") }

// Refusal marks it a refusal.
func (*DiagnosticsError) Refusal() {}

// diagnosticsError is diags as one refusal.
func diagnosticsError(diags hcl.Diagnostics) *DiagnosticsError {
	var lines []string
	for _, d := range diags {
		if d.Severity != hcl.DiagError {
			continue
		}
		line := d.Summary
		if d.Detail != "" {
			line += "; " + d.Detail
		}
		if d.Subject != nil {
			line = fmt.Sprintf("%s:%d,%d: %s", d.Subject.Filename, d.Subject.Start.Line, d.Subject.Start.Column, line)
		}
		if !slices.Contains(lines, line) {
			lines = append(lines, line)
		}
	}
	return &DiagnosticsError{Lines: lines}
}

func diag(subject hcl.Range, summary, detail string, args ...any) *hcl.Diagnostic {
	return &hcl.Diagnostic{Severity: hcl.DiagError, Summary: summary, Detail: fmt.Sprintf(detail, args...), Subject: subject.Ptr()}
}

// spec is what a block's body may hold: its attributes, and its blocks with
// how many labels each takes (min, max).
type spec struct {
	attrs  []string
	blocks map[string][2]int
}

// check reports what body holds that s doesn't allow, in HCL's own words.
func (s spec) check(body *hclsyntax.Body, where string) hcl.Diagnostics {
	var diags hcl.Diagnostics
	for _, attr := range sortedAttrs(body) {
		if !slices.Contains(s.attrs, attr.Name) {
			diags = append(diags, diag(attr.NameRange, "Unsupported argument", "An argument named %q is not expected in %s.", attr.Name, where))
		}
	}
	for _, block := range body.Blocks {
		labels, ok := s.blocks[block.Type]
		if !ok {
			diags = append(diags, diag(block.TypeRange, "Unsupported block type", "Blocks of type %q are not expected in %s.", block.Type, where))
			continue
		}
		diags = append(diags, checkLabels(block, labels)...)
	}
	return diags
}

func checkLabels(block *hclsyntax.Block, labels [2]int) hcl.Diagnostics {
	n := len(block.Labels)
	switch {
	case n < labels[0]:
		return hcl.Diagnostics{diag(block.OpenBraceRange, "Missing name for "+block.Type, "A %s block needs a name: %s \"<name>\" { … }.", block.Type, block.Type)}
	case n > labels[1]:
		at := block.LabelRanges[labels[1]]
		if labels[1] == 0 {
			return hcl.Diagnostics{diag(at, "Extraneous label for "+block.Type, "A %s block takes no name.", block.Type)}
		}
		return hcl.Diagnostics{diag(at, "Extraneous label for "+block.Type, "A %s block takes one name.", block.Type)}
	}
	return nil
}

// sortedAttrs is body's attributes in source order.
func sortedAttrs(body *hclsyntax.Body) []*hclsyntax.Attribute {
	attrs := make([]*hclsyntax.Attribute, 0, len(body.Attributes))
	for _, a := range body.Attributes {
		attrs = append(attrs, a)
	}
	slices.SortFunc(attrs, func(a, b *hclsyntax.Attribute) int { return a.SrcRange.Start.Byte - b.SrcRange.Start.Byte })
	return attrs
}

// value is attr's value, nil when it isn't there, is null, or failed to
// evaluate (its diagnostics reported).
func (d *decoder) value(attr *hclsyntax.Attribute) *cty.Value {
	if attr == nil {
		return nil
	}
	v, diags := attr.Expr.Value(d.ctx)
	d.diags = append(d.diags, diags...)
	if diags.HasErrors() || v.IsNull() || !v.IsWhollyKnown() {
		return nil
	}
	return &v
}

func (d *decoder) typeError(attr *hclsyntax.Attribute, want string) {
	d.diags = append(d.diags, diag(attr.Expr.Range(), "Incorrect attribute value type", "Inappropriate value for attribute %q: %s required.", attr.Name, want))
}

// str is attr's string, nil when absent.
func (d *decoder) str(body *hclsyntax.Body, name string) *string {
	attr := body.Attributes[name]
	v := d.value(attr)
	if v == nil {
		return nil
	}
	s, err := convert.Convert(*v, cty.String)
	if err != nil {
		d.typeError(attr, "string")
		return nil
	}
	out := s.AsString()
	return &out
}

// text is attr's string, "" when absent.
func (d *decoder) text(body *hclsyntax.Body, name string) string {
	if s := d.str(body, name); s != nil {
		return *s
	}
	return ""
}

// boolean is attr's bool, nil when absent.
func (d *decoder) boolean(body *hclsyntax.Body, name string) *bool {
	attr := body.Attributes[name]
	v := d.value(attr)
	if v == nil {
		return nil
	}
	b, err := convert.Convert(*v, cty.Bool)
	if err != nil {
		d.typeError(attr, "bool")
		return nil
	}
	out := b.True()
	return &out
}

func (d *decoder) isTrue(body *hclsyntax.Body, name string) bool {
	b := d.boolean(body, name)
	return b != nil && *b
}

// strings is attr's list of strings (nested lists flattened).
func (d *decoder) strings(body *hclsyntax.Body, name string) []string {
	attr := body.Attributes[name]
	v := d.value(attr)
	if v == nil {
		return nil
	}
	if v.Type() == cty.String {
		d.typeError(attr, "list of strings")
		return nil
	}
	out, ok := stringsOf(*v)
	if !ok {
		d.typeError(attr, "list of strings")
	}
	return out
}

// commands is attr's command or commands: one string or a list of them.
func (d *decoder) commands(body *hclsyntax.Body, name string) []string {
	attr := body.Attributes[name]
	v := d.value(attr)
	if v == nil {
		return nil
	}
	out, ok := stringsOf(*v)
	if !ok || len(out) == 0 {
		d.typeError(attr, "string or list of strings")
		return nil
	}
	return out
}

// refAt is a reference and where it was written.
type refAt struct {
	ref
	at hcl.Range
}

// refs is attr's references, flattened (`[program.curl, local.cli]`),
// each one of kinds. what names the attribute in messages.
func (d *decoder) refs(body *hclsyntax.Body, name string, kinds ...string) []refAt {
	attr := body.Attributes[name]
	if attr == nil {
		return nil
	}
	// A list written out gives each entry its own position.
	exprs := []hclsyntax.Expression{attr.Expr}
	if tuple, ok := attr.Expr.(*hclsyntax.TupleConsExpr); ok {
		exprs = tuple.Exprs
	}
	var out []refAt
	for _, expr := range exprs {
		v, diags := expr.Value(d.ctx)
		d.diags = append(d.diags, diags...)
		if diags.HasErrors() {
			continue
		}
		var flat []cty.Value
		if !flattenRefs(v, &flat) {
			d.diags = append(d.diags, diag(expr.Range(), "Not a reference", "%s takes %s, written as references (%s.<name>), not strings or other values.", name, plural(kinds), kinds[0]))
			continue
		}
		for _, f := range flat {
			r, _ := asRef(f)
			if !slices.Contains(kinds, r.kind) {
				d.diags = append(d.diags, diag(expr.Range(), "Wrong kind of reference", "%s takes %s, but %s is a %s.", name, plural(kinds), r.display(), r.kind))
				continue
			}
			out = append(out, refAt{r, expr.Range()})
		}
	}
	return out
}

// plainRefs is refs for an attribute that names declarations only: a
// variant() or args() there is reported.
func (d *decoder) plainRefs(body *hclsyntax.Body, name string, kinds ...string) []refAt {
	var out []refAt
	for _, r := range d.refs(body, name, kinds...) {
		if r.variant != "" || len(r.args) > 0 {
			d.diags = append(d.diags, diag(r.at, "Not a plain reference", "%s names %s as they are: variant() and args() belong in install and run.", name, plural(kinds)))
			continue
		}
		out = append(out, r)
	}
	return out
}

// flattenRefs appends v's references to out, lists flattened at any depth;
// false when v holds anything else.
func flattenRefs(v cty.Value, out *[]cty.Value) bool {
	if v.IsNull() {
		return true
	}
	if _, ok := asRef(v); ok {
		*out = append(*out, v)
		return true
	}
	t := v.Type()
	if !v.IsKnown() || !(t.IsListType() || t.IsTupleType() || t.IsSetType()) {
		return false
	}
	for it := v.ElementIterator(); it.Next(); {
		_, e := it.Element()
		if !flattenRefs(e, out) {
			return false
		}
	}
	return true
}

func plural(kinds []string) string {
	words := make([]string, len(kinds))
	for i, k := range kinds {
		words[i] = k + "s"
	}
	return strings.Join(words, " and ")
}

func names(refs []refAt) []string {
	out := make([]string, len(refs))
	for i, r := range refs {
		out[i] = r.name
	}
	return out
}

// conflict reports the second and later of attrs present in body: at most
// one of them may be.
func (d *decoder) conflict(body *hclsyntax.Body, attrs ...string) {
	var seen []string
	for _, a := range sortedAttrs(body) {
		if !slices.Contains(attrs, a.Name) {
			continue
		}
		if len(seen) > 0 {
			d.diags = append(d.diags, diag(a.NameRange, "Conflicting arguments", "%s and %s can't both be set: at most one of %s.", seen[0], a.Name, strings.Join(attrs, ", ")))
		}
		seen = append(seen, a.Name)
	}
}

// required reports name missing from block.
func (d *decoder) required(block *hclsyntax.Block, name string) bool {
	if block.Body.Attributes[name] != nil {
		return true
	}
	d.diags = append(d.diags, diag(block.DefRange(), "Missing required argument", "The argument %q is required, but no definition was found.", name))
	return false
}
