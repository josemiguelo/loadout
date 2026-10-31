package hclconf

import (
	"slices"
	"testing"
)

// The shape the language server offers is the decoder's, whole.

func TestEveryAttributeTheDecoderTakesHasAValue(t *testing.T) {
	for path, s := range shapeSpecs {
		for _, name := range s.spec.attrs {
			a, ok := s.values[name]
			if !ok || a.Name != name || a.Value == "" {
				t.Errorf("%q: attribute %q has no value", path, name)
			}
			if a.Value == ValueRefs && len(a.Refs) == 0 {
				t.Errorf("%q: %q names no kinds", path, name)
			}
		}
		for name := range s.values {
			if !slices.Contains(s.spec.attrs, name) {
				t.Errorf("%q: %q has a value but the decoder doesn't take it", path, name)
			}
		}
	}
}

func TestEveryBlockHasAShape(t *testing.T) {
	var walk func(path []string)
	walk = func(path []string) {
		s, ok := ShapeOf(path...)
		if !ok {
			t.Errorf("no shape for %q", path)
			return
		}
		for _, b := range s.Blocks {
			walk(append(slices.Clone(path), b.Type))
		}
	}
	walk(nil)
	for path := range shapeSpecs {
		if path == "" {
			continue
		}
		if _, ok := ShapeOf(splitPath(path)...); !ok {
			t.Errorf("unreachable %q", path)
		}
	}
}

func splitPath(p string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(p); i++ {
		if i == len(p) || p[i] == '/' {
			out = append(out, p[start:i])
			start = i + 1
		}
	}
	return out
}

func TestTheShapeReadsLikeTheLanguage(t *testing.T) {
	top, _ := ShapeOf()
	var types []string
	for _, b := range top.Blocks {
		types = append(types, b.Type)
	}
	equalSlices(t, types, []string{"data", "function", "installer", "locals", "machine", "outdated", "profile", "program", "repo", "requires", "script"})
	program, _ := ShapeOf("program")
	if i := slices.IndexFunc(program.Blocks, func(b Block) bool { return b.Type == "via" }); i < 0 || program.Blocks[i].LabelRefs != "installer" {
		t.Errorf("program's via: %+v", program.Blocks)
	}
	if i := slices.IndexFunc(program.Attrs, func(a Attr) bool { return a.Name == "install_via" }); i < 0 || program.Attrs[i].Value != ValueRefs || program.Attrs[i].Refs[0] != "installer" {
		t.Errorf("program's install_via: %+v", program.Attrs)
	}
	if s, ok := ShapeOf("data", "tools", "inner"); !ok || !s.Free {
		t.Errorf("a data table: %+v %v", s, ok)
	}
	if _, ok := ShapeOf("program", "nonsense"); ok {
		t.Error("a block the language doesn't have has a shape")
	}
}
