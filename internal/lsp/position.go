package lsp

import (
	"bytes"
	"unicode/utf16"
	"unicode/utf8"
)

// Positions: HCL counts lines from 1 and knows each position's byte
// offset; LSP counts lines from 0 and characters in the negotiated
// encoding, UTF-8 (bytes) when the editor offers it, UTF-16 otherwise.

type position struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}

type lspRange struct {
	Start position `json:"start"`
	End   position `json:"end"`
}

const (
	encodingUTF8  = "utf-8"
	encodingUTF16 = "utf-16"
)

// toPosition is the position of byte offset off in src, its line counted
// from line1 (HCL's, 1-based), in encoding. An offset past src is src's end.
func toPosition(src []byte, line1, off int, encoding string) position {
	off = min(max(off, 0), len(src))
	start := off
	for start > 0 && src[start-1] != '\n' {
		start--
	}
	return position{Line: line1 - 1, Character: width(src[start:off], encoding)}
}

// width is how many characters text is in encoding.
func width(text []byte, encoding string) int {
	if encoding == encodingUTF8 {
		return len(text)
	}
	n := 0
	for len(text) > 0 {
		r, size := utf8.DecodeRune(text)
		text = text[size:]
		n += utf16.RuneLen(r) // invalid UTF-8 decodes to U+FFFD, one unit
	}
	return n
}

// toOffset is p's byte offset in src, in encoding: a line past the end is
// src's end, a character past its line's end is that end.
func toOffset(src []byte, p position, encoding string) int {
	off := 0
	for line := 0; line < p.Line; line++ {
		i := bytes.IndexByte(src[off:], '\n')
		if i < 0 {
			return len(src)
		}
		off += i + 1
	}
	for n := 0; n < p.Character && off < len(src) && src[off] != '\n'; {
		r, size := utf8.DecodeRune(src[off:])
		if encoding == encodingUTF8 {
			n += size
		} else {
			n += utf16.RuneLen(r)
		}
		off += size
	}
	return off
}
