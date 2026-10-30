package engine

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/exec/fakeexec"
	"github.com/josemiguelo/loadout/internal/model"
)

// gated holds every command containing match until gate closes.
type gated struct {
	exec.ProcessRunner
	match string
	gate  chan struct{}
}

func (g gated) Capture(c exec.ShellCommand) (exec.ExecResult, error) {
	if strings.Contains(c.Line, g.match) {
		<-g.gate
	}
	return g.ProcessRunner.Capture(c)
}

func TestEachPartLandsOnItsOwnWithoutWaitingForTheOthers(t *testing.T) {
	inner := fakeexec.New().
		OnCommand("git --version", fakeexec.Stdout("git version 2.55.0")).
		OnCommand("test -d $HOME/.dotfiles")
	runner := gated{ProcessRunner: inner, match: "test -d", gate: make(chan struct{})}
	engine := NewStatusEngine(NewVersionChecker(runner, repoFrame), runner, repoFrame, nil)

	var mu sync.Mutex
	var parts []Part
	programsIn := make(chan struct{})
	done := make(chan coremodel.MachineState)
	go func() {
		state, err := engine.RefreshParts(statusManifest(t), laptop, nil, model.Map[coremodel.ScriptState]{}, func(p Part) {
			mu.Lock()
			parts = append(parts, p)
			mu.Unlock()
			if p.Kind == PartPrograms {
				close(programsIn)
			}
		})
		if err != nil {
			t.Error(err)
		}
		done <- state
	}()

	// The scripts' check is held: programs must land anyway.
	select {
	case <-programsIn:
	case <-time.After(5 * time.Second):
		t.Fatal("programs waited for the scripts")
	}
	mu.Lock()
	eq(t, 1, len(parts))
	eq(t, PartPrograms, parts[0].Kind)
	eq(t, true, parts[0].Programs.Has("git"))
	mu.Unlock()

	close(runner.gate)
	state := <-done
	mu.Lock()
	defer mu.Unlock()
	eq(t, 2, len(parts)) // programs and scripts, once each (no configs here)
	eq(t, PartScripts, parts[1].Kind)
	eq(t, coremodel.Done, parts[1].Scripts.Value("dotfiles").Status)
	eq(t, coremodel.Done, state.Scripts.Value("dotfiles").Status) // the whole observation is still returned
}
