package model

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

// JSONObject is a JSON object with its keys in order, as kotlinx's
// JsonObject keeps them: the per-machine data tables, and the tree the lock
// is written through.
//
// A JSON value is one of: nil (null), bool, string, json.Number (the
// literal as written: "0.85", "3"), []any, JSONObject. The encoder also takes
// int, int64 and float64; a float64 is written as Kotlin writes a Double
// (KotlinDouble), so a `number` default of 1 reads "1.0", as it did.
type JSONObject = Map[any]

// KotlinDouble is f as Kotlin's Double.toString writes it: "0.85", "1.0",
// "1.0E7", "1.0E-4".
func KotlinDouble(f float64) json.Number {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		if math.Signbit(f) {
			return "-0.0"
		}
		return "0.0"
	}
	if a := math.Abs(f); a >= 1e-3 && a < 1e7 {
		s := strconv.FormatFloat(f, 'f', -1, 64)
		if !strings.Contains(s, ".") {
			s += ".0"
		}
		return json.Number(s)
	}
	s := strconv.FormatFloat(f, 'E', -1, 64) // 1.5E+07
	mantissa, exp, _ := strings.Cut(s, "E")
	if !strings.Contains(mantissa, ".") {
		mantissa += ".0"
	}
	e, _ := strconv.Atoi(exp)
	return json.Number(mantissa + "E" + strconv.Itoa(e))
}

// primitive is a JSON primitive's content and whether it's a string, as
// kotlinx's JsonPrimitive holds it; ok is false for arrays and objects.
func primitive(v any) (content string, isString bool, ok bool) {
	switch x := v.(type) {
	case nil:
		return "null", false, true
	case bool:
		return strconv.FormatBool(x), false, true
	case string:
		return x, true, true
	case json.Number:
		return string(x), false, true
	case int:
		return strconv.Itoa(x), false, true
	case int64:
		return strconv.FormatInt(x, 10), false, true
	case float64:
		return string(KotlinDouble(x)), false, true
	}
	return "", false, false
}

// JSONEqual is kotlinx's equality of JSON elements: primitives by content
// and string-ness, arrays element by element, objects key by key in any order.
func JSONEqual(a, b any) bool {
	switch x := a.(type) {
	case JSONObject:
		y, ok := b.(JSONObject)
		if !ok || x.Len() != y.Len() {
			return false
		}
		for k, v := range x.All() {
			w, ok := y.Get(k)
			if !ok || !JSONEqual(v, w) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !JSONEqual(x[i], y[i]) {
				return false
			}
		}
		return true
	}
	ca, sa, oka := primitive(a)
	cb, sb, okb := primitive(b)
	return oka && okb && ca == cb && sa == sb
}

// JSONString is v as kotlinx's toString writes it: compact, `{"a":1,"b":["x"]}`.
func JSONString(v any) string {
	var b strings.Builder
	writeJSON(&b, v, "", 0)
	return b.String()
}

// PrettyJSON is v as kotlinx writes it with prettyPrint and a two-space
// indent: one entry per line, `"key": value`, `{}` and `[]` when empty.
// Only what JSON requires is escaped (never <, >, &, or U+2028).
func PrettyJSON(v any) string {
	var b strings.Builder
	writeJSON(&b, v, "  ", 0)
	return b.String()
}

func writeJSON(b *strings.Builder, v any, indent string, level int) {
	pretty := indent != ""
	newline := func(level int) {
		if pretty {
			b.WriteByte('\n')
			for range level {
				b.WriteString(indent)
			}
		}
	}
	switch x := v.(type) {
	case JSONObject:
		b.WriteByte('{')
		first := true
		for k, e := range x.All() {
			if !first {
				b.WriteByte(',')
			}
			first = false
			newline(level + 1)
			quote(b, k)
			b.WriteByte(':')
			if pretty {
				b.WriteByte(' ')
			}
			writeJSON(b, e, indent, level+1)
		}
		if !first {
			newline(level)
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			newline(level + 1)
			writeJSON(b, e, indent, level+1)
		}
		if len(x) > 0 {
			newline(level)
		}
		b.WriteByte(']')
	case []string:
		writeJSON(b, strings2any(x), indent, level)
	default:
		content, isString, ok := primitive(v)
		if !ok {
			panic(fmt.Sprintf("not a JSON value: %T", v))
		}
		if isString {
			quote(b, content)
		} else {
			b.WriteString(content)
		}
	}
}

const hexDigits = "0123456789abcdef"

// quote writes s as kotlinx's printQuoted does: only control characters,
// '"' and '\\' are escaped.
func quote(b *strings.Builder, s string) {
	b.WriteByte('"')
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' {
			continue
		}
		b.WriteString(s[start:i])
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\f':
			b.WriteString(`\f`)
		default:
			b.WriteString(`\u00`)
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&0xf])
		}
		start = i + 1
	}
	b.WriteString(s[start:])
	b.WriteByte('"')
}

func strings2any(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

// ParseJSON reads one JSON value, keys in order and numbers as written.
func ParseJSON(text string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, fmt.Errorf("unexpected trailing content at offset %d", dec.InputOffset())
		}
		return nil, err
	}
	return v, nil
}

func parseValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			var obj JSONObject
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := kt.(string)
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				obj.Set(key, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return obj, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("unexpected %q at offset %d", t, dec.InputOffset())
	default:
		return t, nil
	}
}
