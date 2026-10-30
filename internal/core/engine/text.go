package engine

import (
	"regexp"
	"strconv"
	"strings"
)

// lines is s split on \n, \r\n or \r.
func lines(s string) []string {
	return strings.Split(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n"), "\n")
}

func isBlank(s string) bool { return strings.TrimSpace(s) == "" }

// ifBlank is s, or other when s is blank.
func ifBlank(s, other string) string {
	if isBlank(s) {
		return other
	}
	return s
}

// lastNonEmptyTrimmed is the last line of s with something on it, trimmed; nil when none.
func lastNonEmptyTrimmed(s string) *string {
	all := lines(s)
	for i := len(all) - 1; i >= 0; i-- {
		if t := strings.TrimSpace(all[i]); t != "" {
			return &t
		}
	}
	return nil
}

// group1 is pattern's first capture group in text, or nil when it doesn't match.
func group1(pattern, text string) *string {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil
	}
	m := re.FindStringSubmatch(text)
	if len(m) < 2 {
		return nil
	}
	return &m[1]
}

// shellQuote is s in single quotes, for sh.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func itoa(n int) string { return strconv.Itoa(n) }
