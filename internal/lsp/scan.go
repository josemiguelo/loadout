package lsp

import (
	"regexp"
	"strings"
)

// scan reads the text before the cursor as HCL, loosely: strings, heredocs
// and comments skipped, blocks, object values and brackets tracked, so
// completion knows where the cursor is without the file having to parse.

// cursor is where the cursor is.
type cursor struct {
	// quoted is inside a string, a heredoc or a comment.
	quoted bool
	// path is the enclosing blocks' types, outermost first; labels is the
	// innermost one's labels.
	path   []string
	labels []string
	// set is the attributes the innermost block already sets.
	set []string
	// attr is the attribute whose value the cursor is in; "" at a body's
	// key position.
	attr string
	// objects is, inside attr's value, the keys leading to the object the
	// cursor is in (none for attr's own object).
	objects []string
	// objectKey is an object's key position; objectSet is the keys that
	// object already has.
	objectKey bool
	objectSet []string
	// statementTokens is how many tokens the body's current statement
	// already has before the word being typed: 0 where an attribute or a
	// block starts.
	statementTokens int
}

type tokenKind int

const (
	tokIdent tokenKind = iota
	tokString
	tokPunct
	tokNewline
	tokOther
)

type token struct {
	kind tokenKind
	text string // an identifier, a string's content, or the punctuation
	end  int    // offset just past it
}

var identRe = regexp.MustCompile(`^[A-Za-z_][\w-]*`)

// tokens is text's tokens; quoted says text ends inside a string, a
// heredoc or a comment.
func tokens(text []byte) (out []token, quoted bool) {
	s := string(text)
	for i := 0; i < len(s); {
		c := s[i]
		next := byte(0)
		if i+1 < len(s) {
			next = s[i+1]
		}
		switch {
		case c == '\n':
			out = append(out, token{tokNewline, "\n", i + 1})
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '#' || c == '/' && next == '/':
			end := strings.IndexByte(s[i:], '\n')
			if end < 0 {
				return out, true
			}
			i += end
		case c == '/' && next == '*':
			end := strings.Index(s[i+2:], "*/")
			if end < 0 {
				return out, true
			}
			i += 2 + end + 2
		case c == '"':
			end := closingQuote(s, i+1)
			if end < 0 {
				return out, true
			}
			out = append(out, token{tokString, s[i+1 : end], end + 1})
			i = end + 1
		case c == '<' && next == '<':
			end, ok := heredocEnd(s, i)
			if !ok {
				return out, true
			}
			out = append(out, token{tokOther, "<<", end})
			i = end
		case identRe.MatchString(s[i:]):
			id := identRe.FindString(s[i:])
			out = append(out, token{tokIdent, id, i + len(id)})
			i += len(id)
		case strings.IndexByte("{}[]()=:,.", c) >= 0:
			// `==`, `<=` and the like are operators, not assignments.
			if c == '=' && (next == '=' || i > 0 && strings.IndexByte("=!<>", s[i-1]) >= 0) {
				out = append(out, token{tokOther, "op", i + 1})
				i++
				continue
			}
			out = append(out, token{tokPunct, string(c), i + 1})
			i++
		default:
			out = append(out, token{tokOther, string(c), i + 1})
			i++
		}
	}
	return out, false
}

// closingQuote is the index of the quote ending the string whose content
// starts at from, or -1 when it doesn't end before the line or the text
// does. `${…}` is read as plain text.
func closingQuote(s string, from int) int {
	for i := from; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case '"':
			return i
		case '\n':
			return i - 1 // HCL strings don't span lines: the line ends it
		}
	}
	return -1
}

var heredocStart = regexp.MustCompile(`^<<-?([A-Za-z_][\w-]*)\r?\n`)

// heredocEnd is the offset just past the heredoc starting at from (its
// closing marker's line, the newline left), and whether it ends in s.
func heredocEnd(s string, from int) (int, bool) {
	m := heredocStart.FindStringSubmatch(s[from:])
	if m == nil {
		return from + 2, true // not a heredoc: `<<` alone
	}
	for i := from + len(m[0]); i < len(s); {
		end := strings.IndexByte(s[i:], '\n')
		if end < 0 {
			return 0, false
		}
		if strings.TrimSpace(s[i:i+end]) == m[1] {
			return i + end, true
		}
		i += end + 1
	}
	return 0, false
}

type frameKind int

const (
	frameBody frameKind = iota
	frameObject
	frameBracket
)

// scope is an open block body, object value or bracket.
type scope struct {
	kind frameKind

	// A body: its type and labels, the attributes it sets, its current
	// statement's tokens, and the attribute whose value is being read.
	typ    string
	labels []string
	set    []string
	stmt   []token
	attr   string

	// An object: the key it's the value of in its parent object, the
	// keys it has, whether an item's key is being read, and that key.
	key       string
	keys      []string
	keyPos    bool
	itemKey   string
	itemValue bool
}

func scan(text []byte) cursor {
	toks, quoted := tokens(text)
	stack := []*scope{{kind: frameBody}}
	top := func() *scope { return stack[len(stack)-1] }
	push := func(f *scope) { stack = append(stack, f) }
	pop := func() {
		if len(stack) > 1 {
			stack = stack[:len(stack)-1]
		}
	}
	// endValue ends a body's attribute value, as a newline does.
	endValue := func(f *scope) { f.attr, f.stmt = "", nil }

	for _, t := range toks {
		f := top()
		switch f.kind {
		case frameBody:
			if f.attr != "" { // the value, at the body's own level
				switch {
				case t.kind == tokNewline:
					endValue(f)
				case t.text == "{" && t.kind == tokPunct:
					push(&scope{kind: frameObject, keyPos: true})
				case (t.text == "[" || t.text == "(") && t.kind == tokPunct:
					push(&scope{kind: frameBracket})
				case t.text == "}" && t.kind == tokPunct:
					endValue(f)
					pop()
					top().stmt = nil
				}
				continue
			}
			switch {
			case t.kind == tokNewline:
				f.stmt = nil
			case t.kind == tokPunct && t.text == "=" && len(f.stmt) == 1 && f.stmt[0].kind == tokIdent:
				f.attr = f.stmt[0].text
				f.set = append(f.set, f.attr)
				f.stmt = nil
			case t.kind == tokPunct && t.text == "{":
				b := &scope{kind: frameBody}
				if len(f.stmt) > 0 && f.stmt[0].kind == tokIdent {
					b.typ = f.stmt[0].text
					for _, l := range f.stmt[1:] {
						b.labels = append(b.labels, l.text)
					}
				}
				f.stmt = nil
				push(b)
			case t.kind == tokPunct && t.text == "}":
				pop()
				top().stmt = nil
			default:
				f.stmt = append(f.stmt, t)
			}
		case frameObject:
			switch {
			case t.kind == tokNewline || t.kind == tokPunct && t.text == ",":
				f.keyPos, f.itemKey, f.itemValue = true, "", false
			case f.keyPos && (t.kind == tokIdent || t.kind == tokString):
				f.itemKey = t.text
			case f.keyPos && t.kind == tokPunct && (t.text == "=" || t.text == ":"):
				f.keyPos, f.itemValue = false, true
				if f.itemKey != "" {
					f.keys = append(f.keys, f.itemKey)
				}
			case t.kind == tokPunct && t.text == "{":
				push(&scope{kind: frameObject, key: f.itemKey, keyPos: true})
			case t.kind == tokPunct && (t.text == "[" || t.text == "("):
				push(&scope{kind: frameBracket})
			case t.kind == tokPunct && t.text == "}":
				pop()
			}
		case frameBracket:
			switch {
			case t.kind == tokPunct && (t.text == "[" || t.text == "("):
				push(&scope{kind: frameBracket})
			case t.kind == tokPunct && (t.text == "]" || t.text == ")"):
				pop()
			case t.kind == tokPunct && t.text == "{":
				push(&scope{kind: frameObject, keyPos: true})
			case t.kind == tokPunct && t.text == "}":
				// a bracket left open in an object or block: close up to it
				for len(stack) > 1 && top().kind == frameBracket {
					pop()
				}
				if top().kind != frameBody || top().attr != "" {
					pop()
				}
			}
		}
	}
	return cursorOf(stack, toks, quoted, len(text))
}

// cursorOf is where the cursor is, from the frames open at the end of the
// text (end long).
func cursorOf(stack []*scope, toks []token, quoted bool, end int) cursor {
	c := cursor{quoted: quoted}
	body := 0
	for i, f := range stack {
		if f.kind == frameBody {
			body = i
			if i > 0 {
				c.path = append(c.path, f.typ)
			}
		}
	}
	b := stack[body]
	c.labels, c.set, c.attr = b.labels, b.set, b.attr
	if b.attr == "" {
		stmt := b.stmt
		// The word being typed isn't part of the statement yet.
		if n := len(stmt); n > 0 && stmt[n-1].kind == tokIdent && stmt[n-1].end == end && !quoted {
			stmt = stmt[:n-1]
		}
		c.statementTokens = len(stmt)
		return c
	}
	// Inside the attribute's value: the objects leading to the cursor.
	var innermost *scope
	for _, f := range stack[body+1:] {
		if f.kind == frameObject {
			if innermost != nil {
				c.objects = append(c.objects, f.key)
			}
			innermost = f
		}
	}
	if innermost != nil && stack[len(stack)-1] == innermost {
		c.objectSet = innermost.keys
		if innermost.keyPos {
			c.objectKey = true
		} else if innermost.itemKey != "" {
			// an item's value: the key path includes it
			c.objects = append(c.objects, innermost.itemKey)
		}
	}
	return c
}
