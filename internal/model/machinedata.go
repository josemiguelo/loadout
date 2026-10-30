package model

import (
	"encoding/json"
	"slices"
)

// The per-machine `data` tables: the repo's data
// schema declares every key and its default, machines and profiles override
// them, and chezmoi templates read each machine's merged table from the
// lock. Kept as JSON values, because the model can't hold free-form tables.

// MergeData is over on top of base: tables merge key by key, anything else
// (lists too) replaces.
func MergeData(base, over JSONObject) JSONObject {
	out := base.Clone()
	for key, value := range over.All() {
		under, _ := base.Get(key)
		u, uok := under.(JSONObject)
		v, vok := value.(JSONObject)
		if uok && vok {
			out.Set(key, MergeData(u, v))
		} else {
			out.Set(key, value)
		}
	}
	return out
}

// ValidateData says every key of data must be declared in defaults with the
// same kind (string, boolean, number, list, table); errors name the dotted key.
func ValidateData(defaults, data JSONObject, label, prefix string) []string {
	var errors []string
	for key, value := range data.All() {
		p := prefix + key
		declared, ok := defaults.Get(key)
		switch {
		case !ok:
			errors = append(errors, label+": data key '"+p+"' is not declared in the data schema")
		case dataKind(declared) != dataKind(value):
			errors = append(errors, label+": data key '"+p+"' is a "+dataKind(value)+", but the data schema declares a "+dataKind(declared))
		default:
			d, dok := declared.(JSONObject)
			v, vok := value.(JSONObject)
			if dok && vok {
				errors = append(errors, ValidateData(d, v, label, p+".")...)
			}
		}
	}
	return errors
}

// DataConflicts is the dotted keys a and b both set to different values —
// where two profiles of one `extends` list disagree. Tables are compared key
// by key; anything else (lists too) must be equal.
func DataConflicts(a, b JSONObject, prefix string) []string {
	var keys []string
	for k := range a.All() {
		if b.Has(k) {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	var out []string
	for _, key := range keys {
		left, right := a.Value(key), b.Value(key)
		l, lok := left.(JSONObject)
		r, rok := right.(JSONObject)
		switch {
		case lok && rok:
			out = append(out, DataConflicts(l, r, prefix+key+".")...)
		case !JSONEqual(left, right):
			out = append(out, prefix+key)
		}
	}
	return out
}

// DataLine is one dotted `key: value` line of DataLines.
type DataLine struct{ Key, Value string }

// DataLines is data as dotted `key: value` lines, sorted, for `explain`;
// values are compact JSON.
func DataLines(data JSONObject, prefix string) []DataLine {
	var out []DataLine
	for key, value := range data.Sorted().All() {
		if table, ok := value.(JSONObject); ok {
			out = append(out, DataLines(table, prefix+key+".")...)
		} else {
			out = append(out, DataLine{prefix + key, JSONString(value)})
		}
	}
	return out
}

func dataKind(v any) string {
	switch x := v.(type) {
	case JSONObject:
		return "table"
	case []any:
		return "list"
	case string:
		return "string"
	case bool:
		return "boolean"
	case json.Number:
		if x == "true" || x == "false" {
			return "boolean"
		}
	}
	// kotlinx's rule: any other primitive (null too) is a number.
	return "number"
}
