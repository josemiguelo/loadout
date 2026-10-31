package lsp

import (
	"regexp"
	"strings"

	"github.com/josemiguelo/loadout/internal/hclconf"
)

// Completion: the names a reference may use, guessed from the text before
// the cursor.

type completionItem struct {
	Label      string   `json:"label"`
	Kind       int      `json:"kind"`
	Detail     string   `json:"detail"`
	FilterText string   `json:"filterText"`
	TextEdit   textEdit `json:"textEdit"`
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
	itemVariable  = 6
	itemInterface = 8
	itemModule    = 9
	itemKeyword   = 14
	itemFolder    = 19
)

// kinds is what each reference kind's names show as.
var kinds = map[string]int{
	"program":   itemModule,
	"script":    itemFunction,
	"profile":   itemFolder,
	"installer": itemInterface,
	"local":     itemVariable,
}

// prefixes is the reference kinds, offered where a value starts.
var prefixes = []string{"program", "script", "profile", "installer", "local"}

var (
	// qualified is `<kind>.<partial name>` ending at the cursor.
	qualified = regexp.MustCompile(`(?:^|[^\w.-])([A-Za-z_][\w-]*)\.([\w-]*)$`)
	// bare is a partial name ending at the cursor, not after a dot.
	bare = regexp.MustCompile(`(?:^|[^\w.-])([\w-]*)$`)
)

// complete is what to offer at offset off in src.
func complete(src []byte, off int, line int, encoding string, a *hclconf.Analysis) completionList {
	list := completionList{Items: []completionItem{}}
	before := src[:off]
	ctx := scan(before)
	if ctx.quoted {
		return list
	}
	lineStart := strings.LastIndexByte(string(before), '\n') + 1
	tail := string(before[lineStart:])
	// The partial name the item replaces: from its start to the cursor.
	replace := func(partial string) lspRange {
		start := toPosition(src, line+1, off-len(partial), encoding)
		return lspRange{Start: start, End: toPosition(src, line+1, off, encoding)}
	}
	if m := qualified.FindStringSubmatch(tail); m != nil {
		if _, ok := kinds[m[1]]; !ok {
			return list
		}
		r := replace(m[2])
		for _, d := range unique(a, m[1]) {
			list.Items = append(list.Items, item(d, r))
		}
		return list
	}
	m := bare.FindStringSubmatch(tail)
	if m == nil || !ctx.value {
		return list
	}
	r := replace(m[1])
	for _, d := range unique(a, "installer") {
		list.Items = append(list.Items, item(d, r))
	}
	for _, p := range prefixes {
		list.Items = append(list.Items, completionItem{
			Label: p + ".", Kind: itemKeyword, Detail: "a " + p + " by name", FilterText: p,
			TextEdit: textEdit{Range: r, NewText: p + "."},
		})
	}
	return list
}

func item(d hclconf.Declaration, r lspRange) completionItem {
	return completionItem{Label: d.Name, Kind: kinds[d.Kind], Detail: detail(d), FilterText: d.Name, TextEdit: textEdit{Range: r, NewText: d.Name}}
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

// context is where the cursor is, from the text before it.
type context struct {
	// quoted is inside a string, a heredoc or a comment.
	quoted bool
	// value is where a value goes: after `=` on the line, or inside an
	// unclosed `[` or `(`.
	value bool
}

// scan reads text as HCL, loosely, to its end: strings, heredocs and
// comments skipped, brackets counted.
func scan(text []byte) context {
	depth := 0
	afterEquals := false
	for i := 0; i < len(text); i++ {
		c := text[i]
		next := byte(0)
		if i+1 < len(text) {
			next = text[i+1]
		}
		switch {
		case c == '"':
			end := closingQuote(text, i+1)
			if end < 0 {
				return context{quoted: true}
			}
			i = end
		case c == '#' || c == '/' && next == '/':
			end := strings.IndexByte(string(text[i:]), '\n')
			if end < 0 {
				return context{quoted: true}
			}
			i += end - 1
		case c == '/' && next == '*':
			end := strings.Index(string(text[i+2:]), "*/")
			if end < 0 {
				return context{quoted: true}
			}
			i += 2 + end + 1
		case c == '<' && next == '<':
			end, ok := heredocEnd(text, i)
			if !ok {
				return context{quoted: true}
			}
			i = end
		case c == '[' || c == '(':
			depth++
		case c == ']' || c == ')':
			depth = max(depth-1, 0)
		case c == '=' && next != '=' && (i == 0 || !strings.ContainsRune("=!<>", rune(text[i-1]))):
			afterEquals = true
		case c == '\n' || c == '{' || c == '}':
			if depth == 0 {
				afterEquals = false
			}
		}
	}
	return context{value: depth > 0 || afterEquals}
}

// closingQuote is the index of the quote ending the string that starts at
// from, or -1 when it doesn't end in text. `${…}` is read as plain text.
func closingQuote(text []byte, from int) int {
	for i := from; i < len(text); i++ {
		switch text[i] {
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

// heredocEnd is the index of the last byte of the heredoc starting at
// from, and whether it ends in text.
func heredocEnd(text []byte, from int) (int, bool) {
	m := heredocStart.FindSubmatch(text[from:])
	if m == nil {
		return from + 1, true // not a heredoc: `<<` alone
	}
	marker := string(m[1])
	i := from + len(m[0])
	for i < len(text) {
		end := strings.IndexByte(string(text[i:]), '\n')
		line := string(text[i:])
		if end >= 0 {
			line = line[:end]
		}
		if strings.TrimSpace(line) == marker && end >= 0 {
			return i + end - 1, true
		}
		if end < 0 {
			break
		}
		i += end + 1
	}
	return 0, false
}
