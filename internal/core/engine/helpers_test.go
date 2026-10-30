package engine

import (
	"strings"
	"testing"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/exec"
)

var s = func(v string) *string { return &v }

var repoFrame = exec.NewCommandFrame("/repo", nil, nil)

func must[T any](t *testing.T) func(T, error) T {
	return func(v T, err error) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
}

func contains(t *testing.T, message string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(message, want) {
			t.Errorf("%q not in:\n%s", want, message)
		}
	}
}

// refused is err's message, which must be a T.
func refused[T error](t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("no refusal")
	}
	if _, ok := err.(T); !ok {
		t.Fatalf("%T: %v", err, err)
	}
	return err.Error()
}

type cs = coremodel.ProgramState
