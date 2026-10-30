package cli

import (
	"strings"
	"unicode/utf8"

	"github.com/josemiguelo/loadout/internal/core/platform"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// commandHelp is structured command help: a summary line, then one
// indented line per arg/flag, names in an aligned column. Help renders it
// as written (whitespace kept), only wrapping lines too long for the
// terminal, in the root's command list as on the command's own page.
func commandHelp(summary string, details ...string) string {
	if len(details) == 0 {
		return summary
	}
	nameWidth := 0
	for _, d := range details {
		name, _, _ := strings.Cut(d, "  ")
		nameWidth = max(nameWidth, utf8.RuneCountInString(name))
	}
	lines := []string{summary}
	for _, d := range details {
		name, desc, _ := strings.Cut(d, "  ")
		desc = strings.TrimSpace(desc)
		if desc == "" {
			lines = append(lines, "  "+name)
		} else {
			lines = append(lines, "  "+padEnd(name, nameWidth+2)+desc)
		}
	}
	return strings.Join(lines, "\n")
}

// argSpec is one positional argument, for the usage line and Arguments.
type argSpec struct {
	name     string
	help     string
	optional bool
	multiple bool
}

func (a argSpec) usage() string {
	s := "<" + a.name + ">"
	if a.optional {
		s = "[" + s + "]"
	}
	if a.multiple {
		s += "..."
	}
	return s
}

// optSpec is one option, in declaration order, for Options.
type optSpec struct {
	long, short, help string
	// valued options take a value: `--repo=<text>`.
	valued bool
}

func (o optSpec) term(name func(string) string, muted func(string) string) string {
	s := ""
	if o.short != "" {
		s = name("-"+o.short) + ", "
	}
	s += name("--" + o.long)
	if o.valued {
		s += "=" + muted("<text>")
	}
	return s
}

// cmdSpec is what help shows of one command, as Clikt laid it out.
type cmdSpec struct {
	help string
	args []argSpec
	opts []optSpec
}

var specs = map[*cobra.Command]*cmdSpec{}

func specOf(cmd *cobra.Command) *cmdSpec {
	if s, ok := specs[cmd]; ok {
		return s
	}
	s := &cmdSpec{}
	specs[cmd] = s
	return s
}

// boolFlag declares a flag and records it for help.
func boolFlag(cmd *cobra.Command, fs *pflag.FlagSet, p *bool, long, short, help string) {
	fs.BoolVarP(p, long, short, false, help)
	specOf(cmd).opts = append(specOf(cmd).opts, optSpec{long: long, short: short, help: help})
}

// stringFlag declares an option taking a value and records it for help.
func stringFlag(cmd *cobra.Command, fs *pflag.FlagSet, p *string, long, short, value, help string) {
	fs.StringVarP(p, long, short, value, help)
	specOf(cmd).opts = append(specOf(cmd).opts, optSpec{long: long, short: short, help: help, valued: true})
}

// stringsFlag declares a repeatable option and records it for help.
func stringsFlag(cmd *cobra.Command, fs *pflag.FlagSet, p *[]string, long, short, help string) {
	fs.StringArrayVarP(p, long, short, nil, help)
	specOf(cmd).opts = append(specOf(cmd).opts, optSpec{long: long, short: short, help: help, valued: true})
}

// helpFlag is -h/--help, last in every command's options.
func helpFlag(cmd *cobra.Command) {
	var help bool
	boolFlag(cmd, cmd.Flags(), &help, "help", "h", "Show this message and exit")
}

// helpWidth is the width help wraps to: the terminal's, else 79.
func helpWidth() int {
	if platform.IsStdoutTty() {
		if cols := platform.TerminalColumns(); cols > 0 {
			return cols
		}
	}
	return 79
}

// wrap is text as lines no wider than width, whitespace kept as written
// (indentation, aligned columns); a line too long breaks at its last space
// that fits, and goes on at the start of the next line.
func wrap(text string, width int) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		var current strings.Builder
		cur := 0
		rest := line
		for rest != "" {
			// One segment: the spaces before a word, and the word.
			i := 0
			for i < len(rest) && rest[i] == ' ' {
				i++
			}
			j := i
			for j < len(rest) && rest[j] != ' ' {
				j++
			}
			spaces, word := rest[:i], rest[i:j]
			rest = rest[j:]
			n := utf8.RuneCountInString(spaces) + utf8.RuneCountInString(word)
			if cur > 0 && cur+n > width && word != "" {
				out = append(out, strings.TrimRight(current.String(), " "))
				current.Reset()
				current.WriteString(word)
				cur = utf8.RuneCountInString(word)
				continue
			}
			current.WriteString(spaces + word)
			cur += n
		}
		out = append(out, strings.TrimRight(current.String(), " "))
	}
	return out
}

// definitionList is terms (styled) and their descriptions, the
// descriptions in one column after the widest term.
func definitionList(b *strings.Builder, terms, plainTerms, descs []string, width int) {
	termWidth := 0
	for _, t := range plainTerms {
		termWidth = max(termWidth, utf8.RuneCountInString(t))
	}
	col := 2 + termWidth + 2
	for i, term := range terms {
		b.WriteString("  " + term)
		if descs[i] == "" {
			b.WriteString("\n")
			continue
		}
		b.WriteString(strings.Repeat(" ", termWidth-utf8.RuneCountInString(plainTerms[i])+2))
		for k, line := range wrap(descs[i], max(width-col, 1)) {
			if k > 0 {
				b.WriteString(strings.Repeat(" ", col))
			}
			b.WriteString(line + "\n")
		}
	}
}

// usageLine is `Usage: loadout <command> [<options>] <args>`.
func usageLine(cmd *cobra.Command) string {
	s := Style
	if !cmd.HasParent() {
		return s.helpTitle("Usage:") + " loadout " + s.helpMuted("[<options>]") + " " + s.helpMuted("<command> [<args>]...")
	}
	line := s.helpTitle("Usage:") + " loadout " + cmd.Name() + " " + s.helpMuted("[<options>]")
	for _, a := range specOf(cmd).args {
		line += " " + s.helpMuted(a.usage())
	}
	return line
}

// renderHelp is cmd's --help, laid out as Clikt's MordantHelpFormatter
// did: usage, description, Options, then Arguments or Commands, each
// command listed with its FULL help (the structured arg/flag lines too).
func renderHelp(cmd *cobra.Command) string {
	s := Style
	width := helpWidth()
	spec := specOf(cmd)
	var b strings.Builder
	b.WriteString(usageLine(cmd) + "\n\n")
	for _, line := range wrap(spec.help, width-2) {
		b.WriteString("  " + line + "\n")
	}

	b.WriteString("\n" + s.helpTitle("Options:") + "\n")
	var terms, plain, descs []string
	for _, o := range spec.opts {
		terms = append(terms, o.term(s.helpName, s.helpMuted))
		plain = append(plain, o.term(func(x string) string { return x }, func(x string) string { return x }))
		descs = append(descs, o.help)
	}
	definitionList(&b, terms, plain, descs, width)

	if !cmd.HasParent() {
		terms, plain, descs = nil, nil, nil
		for _, sub := range cmd.Commands() {
			if sub.Hidden {
				continue
			}
			terms = append(terms, s.helpName(sub.Name()))
			plain = append(plain, sub.Name())
			descs = append(descs, specOf(sub).help)
		}
		if len(terms) > 0 {
			b.WriteString("\n" + s.helpTitle("Commands:") + "\n")
			definitionList(&b, terms, plain, descs, width)
		}
	} else if len(spec.args) > 0 {
		terms, plain, descs = nil, nil, nil
		for _, a := range spec.args {
			terms = append(terms, s.helpName("<"+a.name+">"))
			plain = append(plain, "<"+a.name+">")
			descs = append(descs, a.help)
		}
		b.WriteString("\n" + s.helpTitle("Arguments:") + "\n")
		definitionList(&b, terms, plain, descs, width)
	}
	return b.String()
}
