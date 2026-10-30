package cli

import (
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

// UsageError is a command line loadout can't run: printed under the
// command's usage line as `Error: <message>` on stderr, exit 1, as Clikt
// did. Cmd is the command whose usage to show; nil (a check a command made
// once running, like "Give at least one program") shows the root's, which
// is what Clikt printed for those.
type UsageError struct {
	Cmd     *cobra.Command
	Message string
}

func (e *UsageError) Error() string { return e.Message }

// Render is the error as printed: the usage line, a blank line, the error.
func (e *UsageError) Render() string {
	cmd := e.Cmd
	if cmd == nil {
		cmd = rootOf
	}
	return usageLine(cmd) + "\n\n" + Style.helpDanger("Error:") + " " + e.Message
}

// usageErr is a UsageError found while running: the root's usage line.
func usageErr(message string) error { return &UsageError{Message: message} }

// ExitError ends loadout with Code, saying nothing more (Clikt's
// ProgramResult): the command already said why.
type ExitError struct{ Code int }

func (e *ExitError) Error() string { return "exit " + strconv.Itoa(e.Code) }

func exitWith(code int) error { return &ExitError{Code: code} }

var (
	unknownFlag      = regexp.MustCompile(`^unknown flag: (\S+)`)
	unknownShorthand = regexp.MustCompile(`^unknown shorthand flag: '(.)' in `)
	needsArgLong     = regexp.MustCompile(`^flag needs an argument: (--\S+)`)
	needsArgShort    = regexp.MustCompile(`^flag needs an argument: '(.)' in `)
)

// flagError turns pflag's messages into Clikt's.
func flagError(cmd *cobra.Command, err error) error {
	msg := err.Error()
	if m := unknownFlag.FindStringSubmatch(msg); m != nil {
		return noSuchOption(cmd, m[1])
	}
	if m := unknownShorthand.FindStringSubmatch(msg); m != nil {
		return noSuchOption(cmd, "-"+m[1])
	}
	if m := needsArgLong.FindStringSubmatch(msg); m != nil {
		return &UsageError{cmd, "option " + Style.helpName(m[1]) + " requires a value"}
	}
	if m := needsArgShort.FindStringSubmatch(msg); m != nil {
		return &UsageError{cmd, "option " + Style.helpName("-"+m[1]) + " requires a value"}
	}
	return &UsageError{cmd, msg}
}

func noSuchOption(cmd *cobra.Command, name string) error {
	var names []string
	for _, o := range specOf(cmd).opts {
		names = append(names, "--"+o.long)
	}
	return &UsageError{cmd, "no such option " + Style.helpName(name) + suggest(name, names, "options")}
}

func noSuchSubcommand(cmd *cobra.Command, name string) error {
	var names []string
	for _, sub := range cmd.Commands() {
		if !sub.Hidden {
			names = append(names, sub.Name())
		}
	}
	return &UsageError{cmd, "no such subcommand " + name + suggest(name, names, "subcommands")}
}

// suggest is Clikt's "did you mean": the names similar to name (Jaro-Winkler
// above 0.8), most similar first.
func suggest(name string, names []string, what string) string {
	type scored struct {
		name  string
		score float64
	}
	var close []scored
	for _, n := range names {
		if s := jaroWinkler(name, n); s > 0.8 {
			close = append(close, scored{n, s})
		}
	}
	sort.SliceStable(close, func(i, j int) bool { return close[i].score > close[j].score })
	switch len(close) {
	case 0:
		return ""
	case 1:
		return ". Did you mean " + close[0].name + "?"
	}
	var list []string
	for _, c := range close {
		list = append(list, c.name)
	}
	return ". (Possible " + what + ": " + strings.Join(list, ", ") + ")"
}

// jaroWinkler is Clikt's similarity: Jaro, plus 0.1 per character of common
// prefix (uncapped, unlike textbook Jaro-Winkler).
func jaroWinkler(s1, s2 string) float64 {
	a, b := []rune(s1), []rune(s2)
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	sim := jaro(a, b)
	return sim + float64(prefix)*0.1*(1-sim)
}

func jaro(a, b []rune) float64 {
	switch {
	case len(a) == 0 && len(b) == 0:
		return 1
	case len(a) == 0 || len(b) == 0:
		return 0
	case len(a) == 1 && len(b) == 1:
		if a[0] == b[0] {
			return 1
		}
		return 0
	}
	searchRange := max(len(a), len(b))/2 - 1
	consumed := make([]bool, len(b))
	matches, transpositions, matchIndex := 0.0, 0, 0
	for i, c := range a {
		for j := max(0, i-searchRange); j <= min(len(b)-1, i+searchRange); j++ {
			if c != b[j] || consumed[j] {
				continue
			}
			consumed[j] = true
			matches++
			if j < matchIndex {
				transpositions++
			}
			matchIndex = j
			break
		}
	}
	if matches == 0 {
		return 0
	}
	return (matches/float64(len(a)) + matches/float64(len(b)) + (matches-float64(transpositions))/matches) / 3
}

// argsAtMost refuses more positional arguments than n, as Clikt did.
func argsAtMost(n int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) <= n {
			return nil
		}
		extra := args[n:]
		word := "argument"
		if len(extra) > 1 {
			word = "arguments"
		}
		return &UsageError{cmd, "got unexpected extra " + word + " (" + strings.Join(extra, " ") + ")"}
	}
}
