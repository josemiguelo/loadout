package tui

import (
	"sync"

	tea "charm.land/bubbletea/v2"
)

// jobs runs the screen's background work: each job is a tea.Cmd on a
// goroutine of its own, and what it returns is queued as a message for the
// model. Only the Bubble Tea program's Update goroutine takes the queue and
// applies it, so every state write happens in one place, in order.
//
// The first refresh starts before the program does, so the jobs run here,
// not on the program: a job's message waits in the queue for whoever applies
// next, and notify (set while the program runs) wakes its Update.
//
// While a command runs in the run panel the jobs are HELD: nothing starts
// beside it (`brew outdated` next to `brew upgrade`) or writes the state
// file after it. A job asked for meanwhile is deferred to release, in order.
type jobs struct {
	mu       sync.Mutex
	queue    []tea.Msg
	running  int
	held     bool
	deferred []tea.Cmd
	notify   func()
}

func newJobs() *jobs { return &jobs{} }

// start runs cmd in the background, or defers it while the jobs are held.
func (j *jobs) start(cmd tea.Cmd) {
	j.mu.Lock()
	if j.held {
		j.deferred = append(j.deferred, cmd)
		j.mu.Unlock()
		return
	}
	j.running++
	j.mu.Unlock()
	go func() {
		msg := cmd()
		j.mu.Lock()
		j.queue = append(j.queue, msg)
		j.running--
		notify := j.notify
		j.mu.Unlock()
		if notify != nil {
			notify()
		}
	}()
}

// post queues msg from inside a running job, before its own answer: a job
// with several answers (the refresh's parts) lands each as it comes. The
// job's final message always queues after everything it posted.
func (j *jobs) post(msg tea.Msg) {
	j.mu.Lock()
	j.queue = append(j.queue, msg)
	notify := j.notify
	j.mu.Unlock()
	if notify != nil {
		notify()
	}
}

// busy says a job is still running (deferred ones don't count).
func (j *jobs) busy() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.running > 0
}

// hold stops new jobs from starting; the running ones finish.
func (j *jobs) hold() {
	j.mu.Lock()
	j.held = true
	j.mu.Unlock()
}

// release lets jobs start again, the deferred ones first.
func (j *jobs) release() {
	j.mu.Lock()
	j.held = false
	deferred := j.deferred
	j.deferred = nil
	j.mu.Unlock()
	for _, cmd := range deferred {
		j.start(cmd)
	}
}

// isHeld says the jobs are held.
func (j *jobs) isHeld() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.held
}

// take is every message queued so far, in the order the jobs finished.
func (j *jobs) take() []tea.Msg {
	j.mu.Lock()
	defer j.mu.Unlock()
	queue := j.queue
	j.queue = nil
	return queue
}

// setNotify is what a finished job calls, nil for nothing.
func (j *jobs) setNotify(notify func()) {
	j.mu.Lock()
	j.notify = notify
	j.mu.Unlock()
}
