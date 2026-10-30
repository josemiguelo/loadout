package cli

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/josemiguelo/loadout/internal/core/platform"
)

// Where commands write; tests swap them.
var (
	stdout io.Writer = os.Stdout
	stderr io.Writer = os.Stderr
	stdin            = bufio.NewReader(os.Stdin)
	// outMu keeps the spinner's frames from landing inside a line.
	outMu sync.Mutex
)

// echo prints text and a newline on stdout, as Clikt's echo did.
func echo(text string) {
	outMu.Lock()
	defer outMu.Unlock()
	fmt.Fprintln(stdout, text)
}

// echoNoNewline prints text on stdout without a newline (a prompt).
func echoNoNewline(text string) {
	outMu.Lock()
	defer outMu.Unlock()
	fmt.Fprint(stdout, text)
}

// echoErr prints text and a newline on stderr.
func echoErr(text string) {
	outMu.Lock()
	defer outMu.Unlock()
	fmt.Fprintln(stderr, text)
}

// readLine is one line from stdin, trimmed; false at end of input.
func readLine() (string, bool) {
	line, err := stdin.ReadString('\n')
	if err != nil && line == "" {
		return "", false
	}
	return strings.TrimSpace(line), true
}

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// spinning runs work under a braille spinner line (TTY only — piped output
// sees nothing), clearing the line when done. Wrap every step slow enough
// to look like a hang (checks, state writes, git) in this.
func spinning[T any](message string, work func() (T, error)) (T, error) {
	tty := platform.IsStdoutTty()
	var wg sync.WaitGroup
	done := make(chan struct{})
	if tty {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ticker := time.NewTicker(120 * time.Millisecond)
			defer ticker.Stop()
			for frame := 0; ; frame++ {
				echoNoNewline("\r" + spinnerFrames[frame%len(spinnerFrames)] + " " + message)
				select {
				case <-done:
					return
				case <-ticker.C:
				}
			}
		}()
	}
	result, err := work()
	close(done)
	wg.Wait()
	// The erase is its own write: a shorter line printed next would keep the
	// spinner line's tail.
	if tty {
		echoNoNewline("\r\x1b[K")
	}
	return result, err
}

// spin is spinning for work with no result.
func spin(message string, work func() error) error {
	_, err := spinning(message, func() (struct{}, error) { return struct{}{}, work() })
	return err
}
