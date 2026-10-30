package tui

import (
	"fmt"
	"image/color"
	osexec "os/exec"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/diff"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/hclconf/hcltest"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/tui/style"
	"github.com/josemiguelo/loadout/internal/tui/term"
)

const manifestSrc = `
program "git" {
  install_via = [dnf]
}
program "kitty" {
  install_via = [dnf]
}

script "dotfiles" {
  run   = "true"
  check = "true"
}
script "bootstrap" {
  run        = "true"
  setup_only = true
}

machine "m1" {
  via "dnf" {
    install = [program.git, program.kitty]
  }
  run = [script.dotfiles, script.bootstrap]
}
`

var system = coremodel.SystemInfo{Machine: "m1", Os: coremodel.Linux, Distro: ptr("fedora"), Arch: "x86_64"}

func manifestFor(t *testing.T) model.Manifest { return hcltest.ManifestOf(t, manifestSrc) }

func update(name, current, candidate string, source ...string) app.UpdateRow {
	row := app.UpdateRow{Name: name, Current: current, Candidate: candidate, Source: "dnf"}
	if len(source) > 0 {
		row.Source = source[0]
	}
	return row
}

func machineState(scripts ...model.Entry[coremodel.ScriptState]) *coremodel.MachineState {
	return &coremodel.MachineState{
		Machine: "m1", Os: "linux", Distro: ptr("fedora"), Arch: "x86_64", ToolVersion: "0.0.0", UpdatedAt: "now",
		Programs: model.MapOf(
			model.E("git", coremodel.ProgramState{Status: coremodel.Installed, Version: ptr("2.55.0")}),
			model.E("kitty", coremodel.ProgramState{Status: coremodel.Missing}),
		),
		Scripts: model.MapOf(scripts...),
	}
}

func script(name string, status coremodel.ScriptStatus) model.Entry[coremodel.ScriptState] {
	return model.E(name, coremodel.ScriptState{Status: status})
}

func sectionNamed(t *testing.T, sections []HomeSection, subject string) HomeSection {
	t.Helper()
	for _, s := range sections {
		if s.Subject == subject {
			return s
		}
	}
	t.Fatalf("no %q row in %v", subject, sections)
	return HomeSection{}
}

func subjects(sections []HomeSection) []string {
	var out []string
	for _, s := range sections {
		out = append(out, s.Subject)
	}
	return out
}

func eq[T any](t *testing.T, want, got T, what ...string) {
	t.Helper()
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("%s\nwant %#v\n got %#v", strings.Join(what, " "), want, got)
	}
}

func truth(t *testing.T, ok bool, what ...string) {
	t.Helper()
	if !ok {
		t.Fatal(strings.Join(what, " "))
	}
}

func setOf(keys ...string) map[string]bool { return with[string](nil, keys...) }

func message(m *HomeModel) string { return m.message() }

// --------------------------------------------------------------- sections

func TestEachSubjectOffersTheVerbThatResolvesIt(t *testing.T) {
	sections := sectionsOf(manifestFor(t), system, machineState(script("dotfiles", coremodel.Pending)), nil, nil, sectionOpts{})
	eq(t, []string{"programs", "scripts", "remote", "fleet"}, subjects(sections))

	programs := sectionNamed(t, sections, "programs")
	eq(t, app.ActionInstallMissing, programs.Action)
	eq(t, Severe, programs.Severity)

	scripts := sectionNamed(t, sections, "scripts")
	eq(t, app.ActionRunScripts, scripts.Action)
	eq(t, Attention, scripts.Severity)
}

func TestSettledSubjectsOfferNothing(t *testing.T) {
	sections := sectionsOf(manifestFor(t), system, machineState(script("dotfiles", coremodel.Done)), nil, nil, sectionOpts{})
	scripts := sectionNamed(t, sections, "scripts")
	// Settled, but still openable: ticking a done script is how you force it.
	eq(t, app.ActionRunScripts, scripts.Action)
	eq(t, Settled, scripts.Severity)
	// No state files to compare: the fleet row can't act either.
	eq(t, app.ActionNone, sectionNamed(t, sections, "fleet").Action)
}

func TestTheConfigsRowIsThereOnlyForARepoWithConfigs(t *testing.T) {
	manifest := manifestFor(t)
	observed := machineState()
	observed.Configs = model.MapOf(
		model.E("tmux", coremodel.ConfigState{Status: coremodel.ConfigApplied}),
		model.E("zsh", coremodel.ConfigState{Status: coremodel.ConfigDrifted, Files: []string{".config/zsh/.zshrc"}}),
	)
	truth(t, !strings.Contains(strings.Join(subjects(sectionsOf(manifest, system, observed, nil, nil, sectionOpts{})), " "), "configs"))

	sections := sectionsOf(manifest, system, observed, nil, nil, sectionOpts{withConfigs: true})
	eq(t, []string{"programs", "scripts", "configs", "remote", "fleet"}, subjects(sections))
	configs := sectionNamed(t, sections, "configs")
	eq(t, "1 applied · 1 drifted", configs.Summary)
	eq(t, "apply what's drifted", configs.Verb)
	eq(t, app.ActionApplyConfigs, configs.Action)
	eq(t, Attention, configs.Severity)

	// chezmoi couldn't answer: its reason is the verb, never "nothing drifted".
	down := machineState()
	down.Configs = model.MapOf(model.E("zsh", coremodel.ConfigState{Status: coremodel.ConfigUnknown, Reason: ptr("chezmoi is not on PATH")}))
	unchecked := sectionNamed(t, sectionsOf(manifest, system, down, nil, nil, sectionOpts{withConfigs: true}), "configs")
	eq(t, "chezmoi is not on PATH", unchecked.Verb)
	eq(t, Attention, unchecked.Severity)
}

func TestDriftedConfigsStartTickedAndTheFleetCountsThem(t *testing.T) {
	observed := machineState()
	observed.Configs = model.MapOf(
		model.E("zsh", coremodel.ConfigState{Status: coremodel.ConfigDrifted, Files: []string{".zshrc"}}),
		model.E("kitty", coremodel.ConfigState{Status: coremodel.ConfigApplied}),
		model.E("nvim", coremodel.ConfigState{Status: coremodel.ConfigUnknown, Reason: ptr("x")}),
	)
	items := configItemsOf(observed)
	var names []string
	for _, item := range items {
		names = append(names, item.Name)
	}
	eq(t, []string{"kitty", "nvim", "zsh"}, names)
	eq(t, setOf("zsh"), preselectConfigs(items))

	fleet := &diff.DiffReport{
		Machines: []string{"a", "b"},
		Configs: []diff.ConfigRow{{Unit: "zsh", PerMachine: model.MapOf(
			model.E("a", diff.ConfigCell{Kind: diff.ConfigDrifted, Files: 1}),
			model.E("b", diff.ConfigCell{Kind: diff.ConfigApplied}),
		)}},
	}
	row := sectionNamed(t, sectionsOf(manifestFor(t), system, machineState(), fleet, nil, sectionOpts{}), "fleet")
	eq(t, "1 config(s) drifted across 2 machines", row.Summary)
	eq(t, Attention, row.Severity)
	drifted := driftedRows(HomeState{Fleet: fleet})
	eq(t, 1, len(drifted))
	eq(t, "zsh", drifted[0].Name())
}

func TestTheRemoteRowFollowsTheAnswerAsItArrives(t *testing.T) {
	manifest := manifestFor(t)
	remote := func(status RemoteStatus) HomeSection {
		return sectionNamed(t, sectionsOf(manifest, system, machineState(), nil, status, sectionOpts{}), "remote")
	}
	// Unknown until answered — never a green tick for "haven't asked".
	truth(t, remote(nil).Neutral)
	truth(t, remote(Asking{}).Neutral)
	truth(t, remote(Unavailable{"offline"}).Neutral)

	answered := remote(&Answered{Updates: []app.UpdateRow{update("kitty", "0.48.2", "0.49.0"), update("loadout", "0.9.1", "0.9.2")}})
	eq(t, "2 updates · dnf 2", answered.Summary)
	eq(t, Attention, answered.Severity)

	clean := remote(&Answered{})
	eq(t, "everything up to date", clean.Summary)
	eq(t, Settled, clean.Severity)

	// A broken oracle is worse than an outdated package: it hides them.
	broken := remote(&Answered{Updates: []app.UpdateRow{update("kitty", "1", "2")}, FailedSources: 1})
	eq(t, Severe, broken.Severity)
}

// ---------------------------------------------------------- remote summary

// The remote row's line answers "where is the work", so a tool with none is
// not news — the live mac shipped "brew 0 · 42 pins", naming the only thing
// with nothing to do and leaving the 42 that did anonymous.

type summaryCase struct {
	brew          *int
	failedSources int
	counts        []model.Entry[int]
}

// liveShape is the live repo's shape: brew, plus five custom sources.
var liveShape = []model.Entry[int]{
	model.E("nvim-plugins", 15), model.E("asdf-tools", 10), model.E("antidote-plugins", 9),
	model.E("asdf-plugins", 7), model.E("antidote", 1),
}

func summaryAnswered(c summaryCase) *Answered {
	answered := &Answered{
		FailedSources: c.failedSources,
		Tools:         []ToolUpdates{{Tool: "brew", Installers: []string{"brew"}, Total: c.brew, Command: ptr("brew upgrade")}},
		Sources:       map[string]bool{},
	}
	for _, e := range c.counts {
		for i := 1; i <= e.Value; i++ {
			answered.Updates = append(answered.Updates, app.UpdateRow{Name: "item" + string(rune('0'+i)), Current: "1", Candidate: "2", Source: e.Key})
		}
		answered.Sources[e.Key] = true
	}
	return answered
}

func TestAnIdleToolIsLeftOutAndTheWorkIsNamed(t *testing.T) {
	line := remoteSummary(summaryAnswered(summaryCase{brew: ptr(0), counts: liveShape}))
	eq(t, "42 updates · nvim-plugins 15 · +4 more", line)
	truth(t, !strings.Contains(line, "brew"), "a tool with nothing outdated is not news")
	truth(t, runes(line) <= summaryWidth)
}

func TestAToolWithWorkLeadsAndItsCountStaysItsOwn(t *testing.T) {
	// One keystroke fixes brew's 3; the other 42 are 42 decisions. A single
	// "45 behind" would say they're the same kind of work, and ranking brew
	// purely by size would bury the cheapest win.
	line := remoteSummary(summaryAnswered(summaryCase{brew: ptr(3), counts: liveShape}))
	eq(t, "brew 3 · 42 more · nvim-plugins 15", line)
	truth(t, runes(line) <= summaryWidth)
}

func TestNothingOutdatedReadsAsSettledEvenWhileToolsExist(t *testing.T) {
	eq(t, "everything up to date", remoteSummary(summaryAnswered(summaryCase{brew: ptr(0)})))
}

func TestACrashedSourceOutranksTheGroupNames(t *testing.T) {
	// It's the one item here that means the rest of the line understates the
	// work, so it must survive the width, plural and all.
	eq(t, "42 updates · 1 source failed", remoteSummary(summaryAnswered(summaryCase{brew: ptr(0), failedSources: 1, counts: liveShape})))
	truth(t, strings.Contains(remoteSummary(summaryAnswered(summaryCase{brew: ptr(0), failedSources: 2, counts: liveShape})), "2 sources failed"))
}

func TestAnUnaskableToolKeepsAskingRatherThanReadingAsClean(t *testing.T) {
	// No batch oracle can say — which is not the same as "nothing to do".
	truth(t, strings.HasPrefix(remoteSummary(summaryAnswered(summaryCase{counts: liveShape})), "brew ?"))
}

func TestTheBinaryOwnRowIsCalledLoadoutNotItsChannel(t *testing.T) {
	line := remoteSummary(&Answered{Updates: []app.UpdateRow{update("loadout", "0.12.0", "0.13.0", "release")}})
	eq(t, "1 update · loadout 1", line)
}

func TestLongSourceNamesLoseTheMarkerNotTheColumn(t *testing.T) {
	line := remoteSummary(summaryAnswered(summaryCase{brew: ptr(0), counts: []model.Entry[int]{
		model.E("some-very-long-source-name", 3), model.E("another-long-one", 2),
	}}))
	truth(t, runes(line) <= summaryWidth, "spilling the column clips mid-word: "+line)
	eq(t, "5 updates · some-very-long-source-name 3", line)
}

// ------------------------------------------------------------------- keys

// modelOf is a HomeModel over sections with no repo behind it: the reducers
// are pure over state. The main pane has the focus.
func modelOf(sections []HomeSection) *HomeModel {
	m := newHomeModel(nil, true)
	m.setStateForTest(HomeState{Sections: sections, Focus: FocusMain, Dark: true})
	return m
}

// withState replaces m's state, keeping the main pane focused.
func withState(m *HomeModel, s HomeState) *HomeModel {
	if s.Focus == FocusSidebar {
		s.Focus = FocusMain
	}
	s.Dark = true
	m.setStateForTest(s)
	return m
}

func press(m *HomeModel, keys ...HomeKey) {
	for _, k := range keys {
		m.handleKey(k)
	}
}

// current is the main list's row under the cursor, as an Item.
func current(m *HomeModel) Item {
	items := listOf(m.state, m.state.subject())
	at := snap(items, m.state.Cursors[m.state.subject()])
	if at < 0 {
		return Item{Index: -1}
	}
	return items[at]
}

// remoteRowOf is the remote line under the cursor.
func remoteRowOf(m *HomeModel) RemoteLine {
	return remoteLines(m.state.Remote.(*Answered), m.state.Collapsed)[current(m).Index]
}

func remoteKinds(lines []RemoteLine) []string {
	var out []string
	for _, l := range lines {
		out = append(out, l.Kind.String())
	}
	return out
}

func toastKind(m *HomeModel) style.ToastKind {
	kind, _ := m.toasts.Message()
	return kind
}

var subjectsAll = []HomeSection{
	{Subject: SubjectPrograms}, {Subject: SubjectScripts}, {Subject: SubjectConfigs},
	{Subject: SubjectRemote}, {Subject: SubjectFleet},
}

func TestTheSidebarPicksTheSubjectTheMainPaneShows(t *testing.T) {
	m := modelOf(subjectsAll)
	m.state.Focus = FocusSidebar
	press(m, KeyDown, KeyDown)
	eq(t, SubjectConfigs, m.state.subject(), "moving in the sidebar switches the main pane at once")
	press(m, KeyUp)
	eq(t, SubjectScripts, m.state.subject())
	press(m, KeySubject5)
	eq(t, SubjectFleet, m.state.subject(), "1–5 jump")
	press(m, KeySubject1, KeyUp)
	eq(t, SubjectPrograms, m.state.subject(), "the first subject is the end of the road")
	press(m, KeyOpen)
	eq(t, FocusMain, m.state.Focus, "l goes into the list")
	press(m, KeyEsc)
	eq(t, FocusSidebar, m.state.Focus, "esc backs out to the sidebar")
}

func TestTabCyclesTheAreasAndTheTerminalOnlyWhileARunShows(t *testing.T) {
	m := modelOf(subjectsAll)
	m.state.Focus = FocusSidebar
	press(m, KeyTab)
	eq(t, FocusMain, m.state.Focus)
	press(m, KeyTab)
	eq(t, FocusSidebar, m.state.Focus, "no run panel: two areas")
	press(m, KeyShiftTab)
	eq(t, FocusMain, m.state.Focus)

	f := runSomething(t, m)
	eq(t, FocusTerminal, m.state.Focus, "a run starts focused")
	truth(t, f.focused)
	press(m, KeyLeave)
	eq(t, FocusMain, m.state.Focus, "ctrl+] leaves the terminal to the main pane")
	truth(t, !f.focused, "and the terminal stops taking keys")
	press(m, KeyTab)
	eq(t, FocusTerminal, m.state.Focus, "tab goes back in")
	truth(t, f.focused)
}

func TestEscNeverQuitsOnlyQDoes(t *testing.T) {
	m := modelOf(subjectsAll)
	press(m, KeyEsc, KeyEsc, KeyEsc)
	eq(t, false, m.state.Exit, "esc closes, never quits")
	truth(t, strings.Contains(message(m), "q quits"), message(m))
	press(m, KeyInterrupt)
	eq(t, false, m.state.Exit, "ctrl+c by reflex doesn't kill the screen")
	eq(t, "q quits", message(m))
	press(m, KeyQuit)
	truth(t, m.state.Exit)
}

func TestTheFilterNarrowsTheListAndUnderlinesTheMatch(t *testing.T) {
	m := withState(modelOf(nil), HomeState{Sections: subjectsAll, Subject: 1, Scripts: []ScriptRow{
		{Name: "pull"}, {Name: "keychron-access"}, {Name: "dotfiles"},
	}})
	press(m, KeyFilter)
	truth(t, m.state.Filtering && m.typing())
	m.handleText("kc")
	items := listOf(m.state, SubjectScripts)
	eq(t, 1, len(items))
	eq(t, "keychron-access", items[0].Name)
	eq(t, []int{0, 3}, items[0].Matches, "a fuzzy match, matched runes underlined")
	press(m, KeyBackspace)
	eq(t, []string{"keychron-access"}, mapNames(listOf(m.state, SubjectScripts), func(i Item) string { return i.Name }), "backspace widens it again")
	press(m, KeyEnter)
	truth(t, !m.state.Filtering, "enter keeps the filter and gives the keys back")
	eq(t, "k", m.state.Filters[SubjectScripts])
	press(m, KeyEsc)
	eq(t, "", m.state.Filters[SubjectScripts], "esc clears it")
	eq(t, FocusMain, m.state.Focus, "and only that")
	eq(t, []string{"pull"}, mapNames(listOf(HomeState{Scripts: m.state.Scripts, Filters: map[string]string{SubjectScripts: "pl"}}, SubjectScripts), func(i Item) string { return i.Name }))
}

func TestTheRemoteFilterKeepsAMatchingRowsHeading(t *testing.T) {
	answered := &Answered{
		Updates:          []app.UpdateRow{update("kitty", "1", "2"), update("bat", "1", "2"), update("ruby", "a", "b", "asdf-tools")},
		Tools:            []ToolUpdates{{Tool: "dnf", Installers: []string{"dnf"}, Total: ptr(2), Declared: []string{"kitty", "bat"}, Command: ptr("dnf upgrade")}},
		MechanismOf:      map[string]string{"kitty": "dnf", "bat": "dnf"},
		ToolOf:           map[string]string{"dnf": "dnf"},
		MechanismsOfTool: map[string][]string{"dnf": {"dnf"}},
		Sources:          map[string]bool{"asdf-tools": true},
	}
	s := HomeState{Remote: answered, Filters: map[string]string{SubjectRemote: "kit"}}
	eq(t, []string{"dnf", "kitty"}, mapNames(listOf(s, SubjectRemote), func(i Item) string { return i.Name }))
	s.Filters[SubjectRemote] = "asdf"
	eq(t, []string{"asdf-tools", "ruby"}, mapNames(listOf(s, SubjectRemote), func(i Item) string { return i.Name }),
		"a matching heading keeps its rows")
}

func TestTheConfigsPickerTicksOneConfigOrAllAndNeverRunsNothing(t *testing.T) {
	m := newHomeModel(app.New("/repo", "", false), true)
	withState(m, HomeState{Sections: []HomeSection{{Subject: SubjectConfigs}},
		Configs:  []ConfigItem{{Name: "kitty", Status: coremodel.ConfigApplied}, {Name: "zsh", Status: coremodel.ConfigDrifted, Files: []string{".zshrc"}}},
		Applying: setOf("zsh")})
	press(m, KeySelect)
	eq(t, setOf("zsh", "kitty"), m.state.Applying)
	press(m, KeySelectNone)
	truth(t, len(m.state.Applying) == 0)
	press(m, KeyEnter)
	truth(t, strings.HasPrefix(message(m), "nothing ticked"), message(m))
	truth(t, m.state.Dialog == nil)

	// A repo whose configs can't be read says so and stays: no dialog, no run.
	press(m, KeySelectAll, KeyEnter)
	truth(t, m.state.Dialog == nil)
	truth(t, m.active == nil)
	eq(t, style.ToastError, toastKind(m))
}

func TestNothingFiresWhileAnAnswerIsStillComing(t *testing.T) {
	// Enter used to dispatch `outdated` over the ask already running.
	m := modelOf([]HomeSection{{Subject: SubjectRemote, Busy: true}})
	m.state.Remote = Asking{}
	press(m, KeyEnter)
	truth(t, m.state.Dialog == nil)
	truth(t, strings.Contains(message(m), "still asking"))
}

func TestNoRowEverLeavesTheScreen(t *testing.T) {
	m := withState(modelOf(nil), HomeState{
		Sections: []HomeSection{{Subject: SubjectRemote}, {Subject: SubjectFleet}},
		Remote:   Unavailable{"offline"},
	})
	press(m, KeyEnter)
	eq(t, false, m.state.Exit)
	truth(t, strings.Contains(message(m), "r tries again"))
	press(m, KeySubject2, KeyEnter)
	truth(t, strings.Contains(message(m), "nothing to run"))
	eq(t, false, m.state.Exit)
}

// Keys on the Update goroutine, answers from many jobs at once: every job's
// message lands, in order, on the state as it is — none is lost and none
// puts back a copy read before another write.
func TestAnswersFromManyJobsAreNeverLost(t *testing.T) {
	m := modelOf(nil)
	var started sync.WaitGroup
	var got []string
	for i := range 1000 {
		started.Add(1)
		m.jobs.start(func() tea.Msg {
			started.Done()
			return sayMsg{style.ToastHey, fmt.Sprint(i)}
		})
	}
	for range 1000 {
		press(m, KeyTheme)
		for _, msg := range m.jobs.take() {
			m.apply(msg)
			got = append(got, message(m))
		}
	}
	started.Wait()
	for m.jobs.busy() {
		time.Sleep(time.Millisecond)
	}
	for _, msg := range m.jobs.take() {
		m.apply(msg)
		got = append(got, message(m))
	}
	eq(t, 1000, len(got), "every job's answer lands")
	truth(t, m.state.Dark, "an even number of flips ends where it started")
}

func TestHeldJobsWaitForTheRunAndStartAfterIt(t *testing.T) {
	j := newJobs()
	j.hold()
	ran := make(chan struct{}, 1)
	j.start(func() tea.Msg { ran <- struct{}{}; return nil })
	truth(t, !j.busy(), "nothing starts beside a run")
	select {
	case <-ran:
		t.Fatal("a held job ran")
	case <-time.After(20 * time.Millisecond):
	}
	j.release()
	select {
	case <-ran:
	case <-time.After(time.Second):
		t.Fatal("the deferred job never ran")
	}
}

// ---------------------------------------------------------------- dialogs

func TestTheConfirmAsksAndEscChangesNothing(t *testing.T) {
	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectScripts}},
		Scripts: []ScriptRow{{Name: "brew", Command: "sh setup-brew.sh"}, {Name: "pull", Command: "sh pull"}}})
	m.startScripts(setOf("brew", "pull"))
	d := m.state.Dialog
	truth(t, d != nil && d.asking())
	eq(t, []PaneItem{{Name: "brew"}, {Name: "pull"}}, d.Items)
	eq(t, &app.Handoff{Kind: app.PaneScripts, Args: []string{"brew", "pull"}}, d.Closed.Handoff)
	// q on the question backs out like esc: it never leaves the screen.
	press(m, KeyQuit)
	truth(t, m.state.Dialog == nil)
	eq(t, false, m.state.Exit)
	truth(t, m.active == nil, "nothing ran")
}

func TestTheConfirmsButtonsWorkLikeGums(t *testing.T) {
	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectScripts}}, Scripts: []ScriptRow{{Name: "pull"}}})
	var ran []app.Closed
	m.runCommand = func(c app.Closed) (*osexec.Cmd, error) { ran = append(ran, c); return osexec.Command("true"), nil }
	m.newTerm = func(w, h int) terminal { return &fakeTerm{id: 1, w: w, h: h} }
	m.startScripts(setOf("pull"))
	eq(t, false, m.state.Dialog.CancelFocused, "Run is focused first: enter keeps meaning yes")
	press(m, KeyClose)
	truth(t, m.state.Dialog.CancelFocused)
	press(m, KeyTab)
	eq(t, false, m.state.Dialog.CancelFocused)
	press(m, KeyOpen, KeyEnter)
	truth(t, m.state.Dialog == nil, "enter on Cancel closes the question")
	eq(t, 0, len(ran), "and runs nothing")
	m.startScripts(setOf("pull"))
	press(m, KeyNo)
	truth(t, m.state.Dialog == nil)
	m.startScripts(setOf("pull"))
	press(m, KeyClose, KeyYes)
	eq(t, 1, len(ran), "y runs whatever is focused")
	eq(t, &app.Handoff{Kind: app.PaneScripts, Args: []string{"pull"}}, ran[0].Handoff)
}

func TestAListRowInTheConfirmOpensItsList(t *testing.T) {
	m := modelOf(nil)
	m.ask(app.Handoff{Kind: app.PaneUpgrade, Args: []string{"dnf"}}, []PaneItem{
		{Name: "dnf", Text: "all 3 packages · 1 in your loadout"},
		{Text: "⋯ 2 more not in your loadout", List: []string{"kernel", "glibc"}},
	})
	press(m, KeyDown)
	eq(t, 1, m.state.Dialog.Row, "only the list row is a stop")
	press(m, KeyEnter)
	eq(t, DialogList, m.state.Dialog.Kind)
	eq(t, []string{"kernel", "glibc"}, m.state.Dialog.Lines)
	press(m, KeyEsc)
	eq(t, DialogConfirm, m.state.Dialog.Kind, "closing the list comes back to the question")
	press(m, KeyUp)
	eq(t, -1, m.state.Dialog.Row, "back on the buttons")
}

func TestThePaletteFiltersAndRunsACommand(t *testing.T) {
	m := modelOf(subjectsAll)
	press(m, KeyPalette)
	eq(t, DialogPalette, m.state.Dialog.Kind)
	truth(t, m.typing(), "the palette's query takes typed text")
	m.handleText("fleet")
	shown, _ := paletteShown(m.state, m.state.Dialog.Query)
	eq(t, "Go to fleet", shown[0].Title)
	press(m, KeyEnter)
	truth(t, m.state.Dialog == nil)
	eq(t, SubjectFleet, m.state.subject())

	press(m, KeyPalette)
	m.handleText("theme")
	press(m, KeyEnter)
	eq(t, false, m.state.Dark, "toggle theme ran")
	press(m, KeyPalette, KeyEsc)
	truth(t, m.state.Dialog == nil)
}

func TestHelpIsADialog(t *testing.T) {
	m := modelOf(subjectsAll)
	press(m, KeyHelp)
	eq(t, DialogHelp, m.state.Dialog.Kind)
	press(m, KeyHelp)
	truth(t, m.state.Dialog == nil, "ctrl+g closes it again")
}

func TestMachineWideVerbsAskFirst(t *testing.T) {
	for k, action := range map[HomeKey]app.HomeAction{KeySync: app.ActionSync, KeyUpgrade: app.ActionUpgrade, KeyConverge: app.ActionSetup} {
		m := modelOf(subjectsAll)
		press(m, k)
		d := m.state.Dialog
		truth(t, d != nil && d.asking(), "the key asks")
		eq(t, action, d.Closed.Action)
		eq(t, false, m.state.Exit)
	}
}

// ---------------------------------------------------------------- pickers

func TestTheProgramsListShowsEveryProgramAndTicksOnlyTheMissing(t *testing.T) {
	rows := programRowsOf(manifestFor(t), system, machineState())
	eq(t, []string{"kitty", "git"}, mapNames(rows, func(p ProgramRow) string { return p.Name }), "the missing first")
	eq(t, coremodel.Missing, rows[0].Status)
	eq(t, "2.55.0", rows[1].Version)
	missing := missingRowsOf(manifestFor(t), system, machineState())
	eq(t, 1, len(missing))
	eq(t, "sudo dnf install -y kitty", missing[0].Command)

	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectPrograms}}, Programs: rows, Missing: missing, Chosen: setOf("kitty")})
	press(m, KeySelect)
	truth(t, len(m.state.Chosen) == 0)
	press(m, KeyEnter)
	truth(t, m.state.Dialog == nil)
	truth(t, strings.Contains(message(m), "nothing ticked"))
	press(m, KeyDown, KeySelect)
	truth(t, strings.Contains(message(m), "isn't missing"), message(m))
	truth(t, len(m.state.Chosen) == 0)
	press(m, KeySelectAll)
	eq(t, setOf("kitty"), m.state.Chosen, "a ticks what's missing")
}

func TestEnterOnTheSidebarGoesIntoTheListAndOnlyTheListActs(t *testing.T) {
	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectScripts}}, Picked: setOf("pull"), Scripts: []ScriptRow{
		{Name: "pull", Command: "sh pull", Status: coremodel.Pending},
	}})
	m.focus(FocusSidebar)
	press(m, KeyEnter)
	eq(t, FocusMain, m.state.Focus, "enter on a subject opens its list")
	truth(t, m.state.Dialog == nil, "and asks nothing: the ticks weren't in view")
	press(m, KeyEnter)
	truth(t, m.state.Dialog != nil, "enter in the list acts on its ticks")
	eq(t, []PaneItem{{Name: "pull"}}, m.state.Dialog.Items)
}

func TestTheScriptsPickerTicksOneScriptAtATimeAndEnterAsks(t *testing.T) {
	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectScripts}}, Picked: setOf("pull"), Scripts: []ScriptRow{
		{Name: "pull", Command: "sh pull", Status: coremodel.Pending},
		{Name: "apply", Command: "sh apply", Status: coremodel.Done},
	}})
	// space on a done script ticks it: that is the force.
	press(m, KeyDown, KeySelect)
	eq(t, setOf("pull", "apply"), m.state.Picked)
	press(m, KeySelectNone)
	truth(t, len(m.state.Picked) == 0, "u clears")
	press(m, KeySelectAll, KeyEnter)
	d := m.state.Dialog
	eq(t, app.PaneScripts, d.Pane)
	eq(t, []PaneItem{{Name: "pull"}, {Name: "apply"}}, d.Items, "in run order, not tick order")
	press(m, KeyEsc)
	eq(t, setOf("pull", "apply"), m.state.Picked, "esc leaves the picks for another go")
}

func TestTheArrowsMoveTheListAndTheWindowFollows(t *testing.T) {
	var scripts []ScriptRow
	for i := range 30 {
		scripts = append(scripts, ScriptRow{Name: fmt.Sprintf("s%02d", i)})
	}
	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectScripts}}, Scripts: scripts})
	m.width, m.height = 140, 30
	view := m.listHeight()
	press(m, KeyUp)
	eq(t, 0, current(m).Index, "the top is the end of the road")
	press(m, KeyPageDown)
	eq(t, view, current(m).Index)
	eq(t, 1, m.state.Offsets[SubjectScripts], "just enough to show the cursor")
	for range 10 {
		press(m, KeyPageDown)
	}
	eq(t, 29, current(m).Index)
	// Every list keeps its own place.
	press(m, KeySubject1)
	press(m, KeySubject1)
	m.state.Subject = 0
	eq(t, 29, m.state.Cursors[SubjectScripts])
}

func TestCtrlDAndCtrlUMoveHalfAPage(t *testing.T) {
	var scripts []ScriptRow
	for i := range 60 {
		scripts = append(scripts, ScriptRow{Name: fmt.Sprintf("s%02d", i)})
	}
	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectScripts}}, Scripts: scripts})
	m.width, m.height = 140, 30
	m.focus(FocusMain)
	half := m.listHeight() / 2
	truth(t, half > 1)
	press(m, KeyHalfDown)
	eq(t, half, current(m).Index, "ctrl+d goes down half a page")
	press(m, KeyHalfDown)
	eq(t, 2*half, current(m).Index)
	press(m, KeyHalfUp)
	eq(t, half, current(m).Index, "ctrl+u goes back up half a page")
	press(m, KeyHalfUp, KeyHalfUp)
	eq(t, 0, current(m).Index, "the top is the end of the road")

	// The inspector scrolls the same way.
	m.state.Inspect = &Inspector{Name: "s00"}
	press(m, KeyHalfDown)
	eq(t, half, m.state.Inspect.Scroll)
	press(m, KeyHalfUp, KeyHalfUp)
	eq(t, 0, m.state.Inspect.Scroll)
}

func TestTheHalfPageKeysAreBound(t *testing.T) {
	for _, c := range []struct {
		msg  tea.KeyPressMsg
		want HomeKey
	}{
		{tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl}, KeyHalfDown},
		{tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl}, KeyHalfUp},
	} {
		got, ok := homeKeyOf(c.msg)
		truth(t, ok, c.msg.String())
		eq(t, c.want, got, c.msg.String())
	}
}

func TestTheRemoteTreeFoldsAndTicksByWhatWillAct(t *testing.T) {
	answered := &Answered{
		Updates: []app.UpdateRow{update("kitty", "1", "2"), update("ruby", "3.4.8", "3.4.10", "asdf-tools")},
		Tools: []ToolUpdates{
			{Tool: "dnf", Installers: []string{"dnf"}, Total: ptr(14), Declared: []string{"kitty"}, Others: []string{"kernel", "glibc"}, Command: ptr("sudo dnf upgrade -y")},
			{Tool: "flatpak", Installers: []string{"flatpak"}, Total: ptr(0), Command: ptr("flatpak --user update -y")},
		},
		MechanismOf:      map[string]string{"kitty": "dnf"},
		ToolOf:           map[string]string{"dnf": "dnf", "flatpak": "flatpak"},
		MechanismsOfTool: map[string][]string{"dnf": {"dnf"}, "flatpak": {"flatpak"}},
		Sources:          map[string]bool{"asdf-tools": true},
	}
	lines := remoteLines(answered, nil)
	eq(t, []string{"Tool", "Program", "Others", "Gap", "Tool", "Gap", "Source", "Item"}, remoteKinds(lines))
	eq(t, "tool:dnf", lines[0].Key)
	eq(t, "tool:dnf", lines[1].Key, "a program under its tool ticks the tool")
	eq(t, "item:asdf-tools/ruby", lines[7].Key)
	truth(t, lines[0].Foldable && !lines[4].Foldable, "a clean tool hides nothing")

	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectRemote}}, Remote: answered})
	press(m, KeyDown, KeyDown)
	eq(t, RemoteOthers, remoteRowOf(m).Kind, "the cost line is a stop")
	press(m, KeyEnter)
	eq(t, DialogList, m.state.Dialog.Kind, "enter on it lists the packages")
	eq(t, []string{"kernel", "glibc"}, m.state.Dialog.Lines)
	press(m, KeyEnter)
	truth(t, m.state.Dialog == nil)
	press(m, KeyDown)
	eq(t, "flatpak", current(m).Name, "the gap is skipped")
	press(m, KeyDown)
	eq(t, RemoteSource, remoteRowOf(m).Kind)
	press(m, KeySelect)
	eq(t, setOf("item:asdf-tools/ruby"), m.state.Selection, "the heading ticks every item under it")
	press(m, KeySelect)
	truth(t, len(m.state.Selection) == 0, "and clears them when they all are")

	// h folds the group under the cursor and lands on its heading.
	press(m, KeyUp, KeyUp)
	eq(t, RemoteOthers, remoteRowOf(m).Kind)
	press(m, KeyClose)
	eq(t, setOf("tool:dnf"), m.state.Collapsed)
	eq(t, RemoteTool, remoteRowOf(m).Kind)
	eq(t, "dnf", current(m).Name)
	eq(t, FocusMain, m.state.Focus)
	press(m, KeyOpen)
	truth(t, len(m.state.Collapsed) == 0, "l unfolds")
	// On a clean tool there is nothing to fold: h goes back to the sidebar.
	press(m, KeyNextHeading)
	eq(t, "flatpak", current(m).Name, "] jumps over the rows to the next group")
	press(m, KeyClose)
	truth(t, len(m.state.Collapsed) == 0)
	eq(t, FocusSidebar, m.state.Focus)
	m.state.Focus = FocusMain
	press(m, KeyPrevHeading)
	eq(t, "dnf", current(m).Name)
	press(m, KeySelect)
	eq(t, setOf("tool:dnf"), m.state.Selection, "one key, one mechanism")
	press(m, KeyEnter)
	truth(t, m.state.Dialog == nil || m.state.Dialog.Kind == DialogConfirm)
}

func TestKOpensTheRowsPageOnlyWhenItsSourceGaveOne(t *testing.T) {
	rows := []app.UpdateRow{
		{Name: "golang", Current: "a", Candidate: "b", Source: "asdf-plugins", Link: ptr("https://github.com/x/y/compare/a...b")},
		{Name: "nodejs", Current: "a", Candidate: "b", Source: "asdf-plugins"},
	}
	answered := &Answered{Updates: rows, Sources: map[string]bool{"asdf-plugins": true}}
	eq(t, "https://github.com/x/y/compare/a...b", remoteLines(answered, nil)[1].Link())
	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectRemote}}, Remote: answered})
	press(m, KeyDown, KeyDown, KeyOpenLink)
	truth(t, strings.Contains(message(m), "no page"))
}

func TestARowWithNoMechanismSaysSoInsteadOfTicking(t *testing.T) {
	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectRemote}},
		Remote: &Answered{Updates: []app.UpdateRow{update("oracle", "a", "b")}}})
	press(m, KeyDown, KeySelect)
	truth(t, len(m.state.Selection) == 0)
	truth(t, strings.Contains(message(m), "can't update"))
}

func TestTheSameNameInTwoSourcesIsTwoRows(t *testing.T) {
	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectRemote}}, Remote: &Answered{
		Updates: []app.UpdateRow{update("python", "3.14.1", "3.14.2", "asdf-tools"), update("python", "d4caa7d", "abc2a03", "asdf-plugins")},
		Sources: map[string]bool{"asdf-tools": true, "asdf-plugins": true},
	}})
	press(m, KeyDown, KeySelect)
	eq(t, setOf("item:asdf-tools/python"), m.state.Selection)
	press(m, KeyDown, KeySelect)
	eq(t, setOf("item:asdf-tools/python", "item:asdf-plugins/python"), m.state.Selection)
}

// -------------------------------------------------------------- inspector

func TestTheInspectorExplainsTheRowWithThisMachineAndTheFleet(t *testing.T) {
	fleet := &diff.DiffReport{Machines: []string{"m1", "m2"}, Rows: []diff.ProgramRow{{Program: "git", PerMachine: model.MapOf(
		model.E("m1", diff.InstallState{Kind: diff.Installed, Version: ptr("2.55.0")}),
		model.E("m2", diff.InstallState{Kind: diff.Missing}),
	)}}}
	rows := programRowsOf(manifestFor(t), system, machineState())
	m := withState(modelOf(nil), HomeState{Sections: []HomeSection{{Subject: SubjectPrograms}}, Programs: rows, Fleet: fleet})
	var asked []string
	m.explain = func(names []string) ([]app.ExplainedName, error) {
		asked = names
		return []app.ExplainedName{{Name: names[0], Items: []app.Explained{{Kind: "program", Name: names[0],
			Rows: []app.ExplainRow{{Label: "install.dnf", Value: "sudo dnf install -y git", Machine: "m1"}}}}}}, nil
	}
	press(m, KeyDown, KeyInspect)
	eq(t, []string{"git"}, asked, "explain answers for the row under the cursor")
	in := m.state.Inspect
	eq(t, "git", in.Name)
	eq(t, "program", in.Items[0].Kind)
	eq(t, []app.ExplainRow{{Label: "program", Value: "installed 2.55.0"}}, in.Machine)
	eq(t, []app.ExplainRow{{Label: "m1", Value: "2.55.0"}, {Label: "m2", Value: "missing"}, {Label: "verdict", Value: "missing somewhere"}}, in.Fleet)
	lines := m.inspectorLines(style.Dark(), *in, 80)
	joined := ansi.Strip(strings.Join(lines, "\n"))
	truth(t, strings.Contains(joined, "← m1"), joined)
	truth(t, strings.Contains(joined, "This machine") && strings.Contains(joined, "Fleet"), joined)
	press(m, KeyDown)
	eq(t, 1, m.state.Inspect.Scroll, "the arrows scroll it")
	press(m, KeyEsc)
	truth(t, m.state.Inspect == nil, "esc goes back to the list")

	// A remote tool line is no program: i says what it inspects.
	m.explain = func([]string) ([]app.ExplainedName, error) {
		return nil, &app.NoSuchItemError{Message: "no program or script named 'x'"}
	}
	withState(m, HomeState{Sections: []HomeSection{{Subject: SubjectRemote}}, Remote: &Answered{
		Updates: []app.UpdateRow{update("kitty", "1", "2")}, Tools: []ToolUpdates{{Tool: "dnf", Installers: []string{"dnf"}, Total: ptr(1), Declared: []string{"kitty"}, Command: ptr("x")}},
		MechanismOf: map[string]string{"kitty": "dnf"}, ToolOf: map[string]string{"dnf": "dnf"}, MechanismsOfTool: map[string][]string{"dnf": {"dnf"}}}})
	press(m, KeyInspect)
	truth(t, m.state.Inspect == nil)
	truth(t, strings.Contains(message(m), "i inspects"))
	press(m, KeyDown, KeyInspect)
	eq(t, "no program or script named 'x'", m.state.Inspect.Err, "a program row is explained, or why not")
}

// -------------------------------------------------------------------- runs

// fakeTerm is the run panel's terminal without a pseudo-terminal: the test
// delivers its exit.
type fakeTerm struct {
	id              int64
	w, h            int
	cmd             *osexec.Cmd
	focused, closed bool
	keys            []tea.Msg
	interrupts      int
	plain           string
	fg, bg          color.Color
	at              string
	// view is the output its first row shows.
	view string
}

func (f *fakeTerm) ID() int64                     { return f.id }
func (f *fakeTerm) Start(cmd *osexec.Cmd) tea.Cmd { f.cmd = cmd; return nil }
func (f *fakeTerm) Update(msg tea.Msg) tea.Cmd    { f.keys = append(f.keys, msg); return nil }
func (f *fakeTerm) View() string {
	rows := strings.Split(strings.TrimSuffix(strings.Repeat(strings.Repeat(" ", f.w)+"\n", f.h), "\n"), "\n")
	if f.view != "" {
		rows[0] = style.Fit(f.view, f.w)
	}
	return strings.Join(rows, "\n")
}
func (f *fakeTerm) Cursor() *tea.Cursor          { return tea.NewCursor(2, 1) }
func (f *fakeTerm) Size() (int, int)             { return f.w, f.h }
func (f *fakeTerm) Resize(w, h int)              { f.w, f.h = w, h }
func (f *fakeTerm) Focus()                       { f.focused = true }
func (f *fakeTerm) Blur()                        { f.focused = false }
func (f *fakeTerm) Running() bool                { return !f.closed }
func (f *fakeTerm) Interrupt()                   { f.interrupts++ }
func (f *fakeTerm) Close() error                 { f.closed = true; return nil }
func (f *fakeTerm) ScrollUp(int)                 {}
func (f *fakeTerm) ScrollDown(int)               {}
func (f *fakeTerm) PageUp()                      {}
func (f *fakeTerm) PageDown()                    {}
func (f *fakeTerm) Top()                         { f.at = "top" }
func (f *fakeTerm) Bottom()                      { f.at = "bottom" }
func (f *fakeTerm) Scrolled() int                { return 0 }
func (f *fakeTerm) SetColors(fg, bg color.Color) { f.fg, f.bg = fg, bg }
func (f *fakeTerm) Plain() string                { return f.plain }

// runSomething confirms a script run on m and returns its terminal.
func runSomething(t *testing.T, m *HomeModel) *fakeTerm {
	t.Helper()
	var f *fakeTerm
	m.runCommand = func(c app.Closed) (*osexec.Cmd, error) { return osexec.Command("loadout"), nil }
	m.newTerm = func(w, h int) terminal { f = &fakeTerm{id: int64(len(m.runs) + 1), w: w, h: h}; return f }
	m.confirm(app.Closed{Action: app.ActionHandOff, Handoff: &app.Handoff{Kind: app.PaneScripts, Args: []string{"pull"}}})
	truth(t, f != nil, "a terminal was made")
	return f
}

func TestARunStartsInThePanelAndEndsWithAToast(t *testing.T) {
	m := modelOf(subjectsAll)
	m.state.Dark = true
	f := runSomething(t, m)
	truth(t, m.active != nil && m.shown == m.active)
	eq(t, "loadout run pull --force", m.active.Command)
	eq(t, "run pull", m.active.Label)
	truth(t, f.cmd != nil, "the command started in the terminal")
	eq(t, style.Dark().BgBase, f.bg, "the terminal answers colour queries with the theme")
	truth(t, m.jobs.isHeld(), "no background check runs beside the command")
	w, h := m.layout(true).termSize()
	eq(t, [2]int{w, h}, [2]int{f.w, f.h}, "the emulator is the panel's size")
	truth(t, m.terminalTakesKeys())

	// One run at a time; q refused while it runs.
	m.confirm(app.Closed{Action: app.ActionSync})
	truth(t, strings.Contains(message(m), "a command is running"))
	press(m, KeyLeave, KeyQuit)
	eq(t, false, m.state.Exit)
	truth(t, strings.Contains(message(m), "ctrl+c stops it"), message(m))
	press(m, KeyInterrupt)
	eq(t, 1, f.interrupts, "ctrl+c on the dashboard stops the command")

	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	truth(t, m.active == nil)
	eq(t, m.runs[0], m.shown, "the run stays in the panel")
	eq(t, FocusMain, m.state.Focus, "focus leaves the finished terminal")
	eq(t, style.ToastOK, toastKind(m))
	eq(t, "run pull done", message(m))
	truth(t, !m.jobs.isHeld(), "the checks are back")
	truth(t, !f.closed, "the newest run keeps its emulator")
	press(m, KeyTab)
	eq(t, FocusTerminal, m.state.Focus)
	press(m, KeyEsc)
	truth(t, m.shown == nil, "esc dismisses a finished run")
	truth(t, f.closed, "and closes its emulator; its text stays for the Runs list")
	eq(t, 1, len(m.runs))
}

func TestEscClosesAFinishedRunFromAnyArea(t *testing.T) {
	// The finished run keeps the focus; from the list, esc closes it too.
	m := modelOf(subjectsAll)
	f := runSomething(t, m)
	press(m, KeyLeave, KeyEsc)
	truth(t, m.shown != nil, "esc never closes a running command's panel")
	m.focus(FocusTerminal) // watching the output when it ends
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	eq(t, FocusTerminal, m.state.Focus, "the finished run keeps the focus")
	truth(t, !f.focused, "but its emulator is blurred: keys are the screen's now")
	m.focus(FocusMain)
	truth(t, slices.ContainsFunc(m.shortHelp(), func(b key.Binding) bool { return b.Help().Desc == "close run" }), "the help line says esc closes it")
	press(m, KeyEsc)
	truth(t, m.shown == nil, "esc on the list closes the finished run")
	truth(t, f.closed)
	eq(t, FocusMain, m.state.Focus, "and the focus stays on the list")

	// A filter clears first; the next esc closes the run.
	m = modelOf(subjectsAll)
	f = runSomething(t, m)
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	m.focus(FocusMain) // a filter is the list's
	m.state.Filters = withValue(m.state.Filters, m.state.subject(), "x")
	press(m, KeyEsc)
	truth(t, m.shown != nil, "the filter clears first")
	eq(t, "", m.state.Filters[m.state.subject()])
	press(m, KeyEsc)
	truth(t, m.shown == nil)

	// The sidebar.
	m = modelOf(subjectsAll)
	f = runSomething(t, m)
	m.runExited(term.ExitMsg{ID: f.id, Code: 1})
	m.focus(FocusSidebar)
	press(m, KeyEsc)
	truth(t, m.shown == nil, "esc on the sidebar closes the finished run")
	press(m, KeyEsc)
	truth(t, strings.Contains(message(m), "nothing to close"), message(m))
}

func TestARunOpenedFromTheSidebarGivesTheFocusBackToItsEntry(t *testing.T) {
	m := modelOf(subjectsAll)
	f := runSomething(t, m)
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	press(m, KeyEsc) // close it from the list
	truth(t, m.shown == nil)

	// The sidebar's cursor goes past the subjects onto the run, enter opens it.
	m.focus(FocusSidebar)
	for range m.state.Sections {
		press(m, KeyDown)
	}
	eq(t, 0, m.state.SideRun, "the cursor is on the run")
	press(m, KeyEnter)
	truth(t, m.shown == m.runs[0])
	eq(t, FocusTerminal, m.state.Focus)

	// h leaves the panel open and goes back to the entry.
	press(m, KeyClose)
	eq(t, FocusSidebar, m.state.Focus, "h goes back to the sidebar")
	eq(t, 0, m.state.SideRun, "on the run's entry")
	truth(t, m.shown != nil)

	// esc closes it and goes back to the entry.
	press(m, KeyEnter, KeyEsc)
	truth(t, m.shown == nil)
	eq(t, FocusSidebar, m.state.Focus, "esc goes back to the sidebar, not the list")
	eq(t, 0, m.state.SideRun, "on the run's entry")

	// A run started from the list still gives the focus back to the list.
	m = modelOf(subjectsAll)
	f = runSomething(t, m)
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	m.focus(FocusTerminal)
	press(m, KeyEsc)
	eq(t, FocusMain, m.state.Focus)
}

func TestEachSidebarRowSettlesWhenItsOwnChecksLand(t *testing.T) {
	manifest := manifestFor(t)
	m := modelOf(nil)
	m.manifest, m.system = &manifest, &system
	// The refresh under way, as refresh() leaves it: every subject checking.
	m.state.Checking = map[string]bool{SubjectPrograms: true, SubjectScripts: true}
	m.partial = &coremodel.MachineState{Machine: "m1"}
	m.state.Sections = sectionsOf(manifest, system, nil, nil, nil, sectionOpts{checking: m.state.Checking})
	busy := func(subject string) bool {
		for _, sec := range m.state.Sections {
			if sec.Subject == subject {
				return sec.Busy
			}
		}
		t.Fatalf("no %s row", subject)
		return false
	}
	truth(t, busy(SubjectPrograms) && busy(SubjectScripts), "both spin while their checks run")

	m.apply(partMsg{part: engine.Part{Kind: engine.PartScripts, Scripts: model.MapOf(
		model.E("dotfiles", coremodel.ScriptState{Status: coremodel.Done}))}})
	truth(t, !busy(SubjectScripts), "scripts stop the moment their own checks are in")
	truth(t, busy(SubjectPrograms), "programs keep spinning: theirs aren't")
	eq(t, map[string]bool{SubjectPrograms: true}, m.state.Checking)

	m.apply(partMsg{part: engine.Part{Kind: engine.PartPrograms, Programs: model.MapOf(
		model.E("git", coremodel.ProgramState{Status: coremodel.Installed}),
		model.E("kitty", coremodel.ProgramState{Status: coremodel.Missing}))}})
	truth(t, !busy(SubjectPrograms), "and programs stop when theirs are")
	for _, sec := range m.state.Sections {
		if sec.Subject == SubjectPrograms {
			eq(t, "1 installed · 1 missing", sec.Summary, "with their fresh answer")
		}
	}

	// A part that failed leaves its row to the refresh's own message.
	m.state.Checking = map[string]bool{SubjectScripts: true}
	m.apply(partMsg{part: engine.Part{Kind: engine.PartScripts, Err: fmt.Errorf("boom")}})
	eq(t, map[string]bool{SubjectScripts: true}, m.state.Checking)
}

func TestRulesSetTheAreasApart(t *testing.T) {
	m := modelOf(subjectsAll)
	m.width, m.height = 140, 40
	frame := func() []string {
		lines := m.screenLines(0)
		for i := range lines {
			lines[i] = ansi.Strip(lines[i])
		}
		return lines
	}
	edge := 1 + sidebarWidth + 1 // the gutter's middle column
	at := func(line string, col int) string {
		r := []rune(line)
		if col < len(r) {
			return string(r[col])
		}
		return ""
	}
	lines := frame()
	for y, line := range lines[:len(lines)-1] {
		eq(t, "│", at(line, edge), fmt.Sprintf("row %d has the sidebar's edge", y))
	}
	truth(t, !strings.Contains(strings.Join(lines, "\n"), "├"), "no panel, no rule across")

	f := runSomething(t, m)
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	l := m.layout(true)
	lines = frame()
	eq(t, "├", at(lines[l.panelY-1], edge), "the rule above the run panel meets the edge")
	truth(t, strings.Count(lines[l.panelY-1], "─") >= l.mainW, "and runs across the main pane")

	m.state.Maximized = true
	lines = frame()
	truth(t, !strings.Contains(strings.Join(lines, "\n"), "├"), "a zoomed panel needs no rule")
}

func TestZoomGivesTheRunTheWholeHeightOfTheMainPane(t *testing.T) {
	m := modelOf(subjectsAll)
	m.width, m.height = 140, 40
	f := runSomething(t, m)
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	m.focus(FocusTerminal)
	half := f.h
	press(m, KeyZoom)
	l := m.layout(true)
	eq(t, l.titleY, l.panelY, "zoomed, the panel starts at the top")
	eq(t, l.statusY-l.titleY-1, f.h, "and its terminal fills every row down to the help line")
	truth(t, f.h > half)
	press(m, KeyZoom)
	eq(t, half, f.h, "z again gives the list its half back")
}

func TestOnlyTheFocusedAreasTitleIsHighlighted(t *testing.T) {
	m := modelOf(subjectsAll)
	m.width, m.height = 140, 40
	f := runSomething(t, m)
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	l := m.layout(true)
	const fill = "48;2;107;80;255"
	titles := func() (main, run bool) {
		lines := m.screenLines(0)
		return strings.Contains(lines[l.titleY], fill), strings.Contains(lines[l.panelY], fill)
	}
	m.focus(FocusTerminal)
	mainLit, runLit := titles()
	truth(t, runLit && !mainLit, "tab onto the terminal lights the run's title, like a selected row")
	m.focus(FocusMain)
	mainLit, runLit = titles()
	truth(t, mainLit && !runLit, "on the list, its title")
	m.focus(FocusSidebar)
	mainLit, runLit = titles()
	truth(t, !mainLit && !runLit, "on the sidebar, its own selected entry and no title")
}

func TestHomeGgEndAndGJumpThroughAFinishedRunsOutput(t *testing.T) {
	m := modelOf(subjectsAll)
	f := runSomething(t, m)
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	m.focus(FocusTerminal)
	press(m, KeyTop)
	eq(t, "top", f.at, "home goes to the start")
	press(m, KeyBottom)
	eq(t, "bottom", f.at, "end (and G) to the end")
	press(m, KeyG)
	eq(t, "bottom", f.at, "one g alone does nothing yet")
	press(m, KeyG)
	eq(t, "top", f.at, "gg goes to the start")
	press(m, KeyBottom, KeyG, KeyDown, KeyG)
	eq(t, "bottom", f.at, "a key between the two g's disarms the first")
	press(m, KeyG)
	eq(t, "top", f.at, "and the next pair works")

	for _, c := range []struct {
		msg  tea.KeyPressMsg
		want HomeKey
	}{
		{tea.KeyPressMsg{Code: tea.KeyHome}, KeyTop},
		{tea.KeyPressMsg{Code: tea.KeyEnd}, KeyBottom},
		{tea.KeyPressMsg{Code: 'g', Mod: tea.ModShift, Text: "G"}, KeyBottom},
		{tea.KeyPressMsg{Code: 'g', Text: "g"}, KeyG},
	} {
		got, ok := homeKeyOf(c.msg)
		truth(t, ok, c.msg.String())
		eq(t, c.want, got, c.msg.String())
	}
}

func TestARunReopenedFromRunsFillsTheZoomedPanelToo(t *testing.T) {
	m := modelOf(subjectsAll)
	m.width, m.height = 140, 40
	f := runSomething(t, m)
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	press(m, KeyEsc) // closes the panel: the run's emulator is released, its text kept
	truth(t, m.shown == nil && f.closed)

	m.focus(FocusSidebar)
	for range m.state.Sections {
		press(m, KeyDown)
	}
	press(m, KeyEnter) // the run again, from the sidebar's Runs
	truth(t, m.shown == m.runs[0])
	press(m, KeyZoom)
	l := m.layout(true)
	eq(t, l.statusY-l.titleY-1, f.h, "the reopened run fills the zoomed panel")
	press(m, KeyZoom)
	_, h := m.layout(true).termSize()
	eq(t, h, f.h, "and goes back to the half panel")
}

func TestAFailedOrInterruptedRunSaysSo(t *testing.T) {
	m := modelOf(subjectsAll)
	f := runSomething(t, m)
	m.runExited(term.ExitMsg{ID: f.id, Code: 130, Interrupted: true})
	eq(t, style.ToastWarning, toastKind(m))
	eq(t, "run pull interrupted", message(m))
	eq(t, "interrupted", m.runs[0].status())

	f = runSomething(t, m)
	truth(t, m.runs[0].closed, "an older run gives its emulator back")
	m.runExited(term.ExitMsg{ID: f.id, Code: 3})
	eq(t, style.ToastError, toastKind(m))
	eq(t, "run pull: exit 3", message(m))
	eq(t, []string{"failed", "interrupted"}, mapNames(m.runsNewestFirst(), func(r *Run) string { return r.status() }))
}

func TestAnUpgradeThatSucceededClearsItsTicks(t *testing.T) {
	m := modelOf(subjectsAll)
	m.state.Selection = setOf("tool:dnf")
	upgrade := app.Closed{Action: app.ActionHandOff, Handoff: &app.Handoff{Kind: app.PaneUpgrade, Args: []string{"dnf"}}}
	m.followUp(upgrade, false)
	eq(t, setOf("tool:dnf"), m.state.Selection, "a failed upgrade keeps its ticks for another go")
	m.followUp(upgrade, true)
	truth(t, len(m.state.Selection) == 0)
}

func TestARunWaitsForTheChecksStillRunning(t *testing.T) {
	m := modelOf(subjectsAll)
	release := make(chan struct{})
	m.jobs.start(func() tea.Msg { <-release; return sayMsg{style.ToastHey, "checked"} })
	var f *fakeTerm
	m.runCommand = func(c app.Closed) (*osexec.Cmd, error) { return osexec.Command("loadout"), nil }
	m.newTerm = func(w, h int) terminal { f = &fakeTerm{id: 9, w: w, h: h}; return f }
	m.confirm(app.Closed{Action: app.ActionSync})
	truth(t, f == nil, "nothing starts while a check runs")
	truth(t, m.waiting != nil)
	close(release)
	for m.jobs.busy() {
		time.Sleep(time.Millisecond)
	}
	for _, msg := range m.jobs.take() {
		m.apply(msg)
	}
	m.afterJobs()
	truth(t, f != nil && m.active != nil, "the run starts once the checks are done")
}

func TestSelfUpgradeEndsTheScreenWithItsOutput(t *testing.T) {
	m := modelOf(subjectsAll)
	var f *fakeTerm
	m.runCommand = func(c app.Closed) (*osexec.Cmd, error) { return osexec.Command("loadout"), nil }
	m.newTerm = func(w, h int) terminal { f = &fakeTerm{id: 4, w: w, h: h, plain: "installed 9.9.9"}; return f }
	m.confirm(app.Closed{Action: app.ActionUpgrade})
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	truth(t, m.state.Exit, "the binary on disk changed: the screen ends")
	truth(t, strings.HasPrefix(m.ended.Message, "installed 9.9.9"), m.ended.Message)
	truth(t, strings.Contains(m.ended.Message, "run loadout again"))
	eq(t, 0, m.ended.Code)
}

func TestKeysGoToTheRunningCommandExceptCtrlBracket(t *testing.T) {
	m := modelOf(subjectsAll)
	f := runSomething(t, m)
	m.key(tea.KeyPressMsg{Code: 'q', Text: "q"})
	eq(t, false, m.state.Exit, "q is the command's")
	m.key(tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl})
	eq(t, 2, len(f.keys), "ctrl+c too: the terminal sends it to the command")
	m.key(tea.KeyPressMsg{Code: ']', Mod: tea.ModCtrl})
	eq(t, FocusMain, m.state.Focus, "ctrl+] is the screen's")
	eq(t, 2, len(f.keys))
	truth(t, m.terminalCursor() == nil, "no cursor once the dashboard has the keys")
	press(m, KeyTab)
	c := m.terminalCursor()
	l := m.layout(true)
	eq(t, [2]int{2 + l.mainX, 1 + l.panelY + 1}, [2]int{c.X, c.Y}, "the command's cursor, where the panel is")
}

// ------------------------------------------------------------------ frame

func TestTheFrameIsExactlyTheScreenInBothLayouts(t *testing.T) {
	sections := sectionsOf(manifestFor(t), system, machineState(script("dotfiles", coremodel.Pending)), nil, nil, sectionOpts{})
	for _, size := range [][2]int{{140, 40}, {100, 30}, {100, 12}, {99, 30}, {80, 24}, {60, 20}, {200, 50}} {
		m := withState(modelOf(nil), HomeState{Sections: sections, Machine: "m1", System: "linux/fedora · x86_64",
			Programs: programRowsOf(manifestFor(t), system, machineState())})
		m.width, m.height = size[0], size[1]
		m.hey(strings.Repeat("long ", 60))
		for _, open := range []bool{false, true} {
			if open {
				runSomething(t, m)
				panel := ansi.Strip(strings.Join(m.screenLines(0), "\n"))
				// (A short screen's toast may cover the panel's title.)
				truth(t, size[1] < 20 || strings.Contains(panel, "loadout run pull --force"), "the run panel names the command: "+panel)
				m.state.Dialog = &Dialog{Kind: DialogConfirm, Pane: app.PaneScripts, Row: -1, Items: []PaneItem{{Name: "pull", Text: "Pull the dotfiles repo"}}}
			}
			lines := m.screenLines(0)
			eq(t, size[1], len(lines), "one line per row")
			for _, line := range lines {
				eq(t, size[0], ansi.StringWidth(line), "every row exactly the width: "+ansi.Strip(line))
			}
			joined := ansi.Strip(strings.Join(lines, "\n"))
			if open {
				truth(t, strings.Contains(joined, "These scripts will run, in order:"), joined)
				truth(t, strings.Contains(joined, "Run") && strings.Contains(joined, "Cancel"), joined)
			}
			if wide := size[0] >= wideMinWidth; !open {
				edge := []rune(ansi.Strip(lines[1]))[1+sidebarWidth+1]
				eq(t, wide, edge == '│', "the sidebar's edge only side by side: "+ansi.Strip(lines[1]))
				eq(t, !wide, strings.HasPrefix(ansi.Strip(lines[0]), " loadout › "), "the breadcrumb only stacked: "+ansi.Strip(lines[0]))
			}
		}
	}
}

func TestAnObsoleteSudoOnAScriptStillLoads(t *testing.T) {
	manifest := hcltest.ManifestOf(t, `
script "hid" {
  run        = "true"
  needs_sudo = true
}
script "plain" {
  run = "true"
}
machine "m1" {
  run = [script.hid, script.plain]
}
`)
	var names []string
	for _, row := range scriptRowsOf(manifest, system, nil) {
		names = append(names, row.Name)
	}
	eq(t, []string{"hid", "plain"}, names)
}

func TestTheUpgradeQuestionSaysWhatMovesNotWhichCommandRuns(t *testing.T) {
	// Rows say how much moves and how much is yours, not the command.
	answered := &Answered{
		Updates: []app.UpdateRow{
			update("brave", "1.82.1", "1.82.3", "omarchy-aur"),
			update("kitty", "0.48.2", "0.48.3", "omarchy-pkg"),
			update("chezmoi", "2.72.1", "2.72.2", "brew"),
			update("ruby", "3.4.8", "3.4.10", "asdf-tools"),
		},
		Tools: []ToolUpdates{
			{Tool: "omarchy", Installers: []string{"omarchy-pkg", "omarchy-aur"}, Total: ptr(168), Declared: []string{"brave", "kitty"}, Command: ptr("omarchy update -y")},
			{Tool: "brew", Installers: []string{"brew", "brew-cask"}, Total: ptr(8), Declared: []string{"chezmoi"}, Command: ptr("brew upgrade")},
		},
		MechanismOf: map[string]string{"brave": "omarchy-aur", "kitty": "omarchy-pkg", "chezmoi": "brew"},
		Sources:     map[string]bool{"asdf-tools": true},
	}
	step := func(tool string, installers ...string) engine.UpgradeStep {
		return engine.UpgradeStep{Installers: installers, Command: "a very long command", Sweep: true, Tool: ptr(tool)}
	}
	eq(t, PaneItem{Name: "omarchy", Text: "all 168 packages · 2 in your loadout"}, upgradeItem(step("omarchy", "omarchy-aur", "omarchy-pkg"), answered))
	// brew's formulae and casks upgrade by two commands: the tool's total
	// can't say how much each one moves.
	eq(t, PaneItem{Name: "brew", Text: "every package it manages · 1 in your loadout"}, upgradeItem(step("brew", "brew"), answered))
	ruby := engine.UpgradeStep{Installers: []string{"asdf-tools"}, Command: "x", Covers: []string{"ruby"}}
	eq(t, PaneItem{Name: "asdf-tools", Text: "ruby 3.4.8 → 3.4.10"}, upgradeItem(ruby, answered))
}

// A source's item may be named like a mapped program: the live repo has a
// `tpack` tmux plugin AND a `tpack` brew cask. The row belongs to its source
// either way — filed under brew, ticking it ran `brew upgrade`, which cannot
// fast-forward a git clone, so the row came back outdated after every
// refresh.
func TestASourceRowNamedLikeAProgramIsNeverTheProgram(t *testing.T) {
	row := app.UpdateRow{Name: "tpack", Current: "27172d5", Candidate: "1f8b694", Source: "tmux-plugins", Note: "156 commit(s) behind"}
	answered := func(upgradable bool) *Answered {
		return &Answered{
			Updates:          []app.UpdateRow{row},
			Tools:            []ToolUpdates{{Tool: "brew", Installers: []string{"brew-cask"}, Total: ptr(0), Command: ptr("brew upgrade")}},
			MechanismOf:      map[string]string{"tpack": "brew-cask"},
			ToolOf:           map[string]string{"brew-cask": "brew"},
			MechanismsOfTool: map[string][]string{"brew": {"brew-cask"}},
			Sources:          map[string]bool{"tmux-plugins": upgradable},
		}
	}

	// Upgradable: its own item, under its own source.
	own := answered(true)
	eq(t, []string{"Tool", "Gap", "Source", "Item"}, remoteKinds(remoteLines(own, nil)))
	eq(t, "source:tmux-plugins", remoteLines(own, nil)[3].Group)
	eq(t, "item:tmux-plugins/tpack", selectionKey(own, row))

	// Read-only: still its source's row — NOT a brew program. This is the
	// case the old name lookup got wrong, because only upgradable sources
	// were kept out of the tool groups.
	readOnly := answered(false)
	eq(t, []string{"Tool", "Gap", "Source", "Item"}, remoteKinds(remoteLines(readOnly, nil)))
	eq(t, "source:tmux-plugins", remoteLines(readOnly, nil)[3].Group)
	eq(t, "", selectionKey(readOnly, row), "nothing loadout can move — never brew's sweep")
	eq(t, "tmux-plugins can't update its items from loadout", remoteLines(readOnly, nil)[3].Refusal())
}

func TestTheScriptsPickerListsMaintenanceScriptsWithTheirLastVerdicts(t *testing.T) {
	manifest := manifestFor(t)
	rows := scriptRowsOf(manifest, system, machineState(script("dotfiles", coremodel.Pending)))
	// bootstrap is setup-only: converge's, never the picker's.
	eq(t, 1, len(rows))
	eq(t, "dotfiles", rows[0].Name)
	eq(t, coremodel.Pending, rows[0].Status)
	eq(t, "true", rows[0].Command)
	// Never observed = unproven, not done — and so ticked.
	unseen := scriptRowsOf(manifest, system, machineState())
	eq(t, coremodel.ScriptStatus(""), unseen[0].Status)
	eq(t, setOf("dotfiles"), preselect(unseen))
	eq(t, map[string]bool{}, preselect(scriptRowsOf(manifest, system, machineState(script("dotfiles", coremodel.Done)))))
}

func TestAProgramWithItsOwnUpgradeTicksAloneAndHandsOffByName(t *testing.T) {
	row := update("claude", "1.0.0", "1.2.0", "script")
	answered := &Answered{Updates: []app.UpdateRow{row}, ProgramUpgrades: map[string]bool{"claude": true}}
	eq(t, "prog:claude", selectionKey(answered, row))
	step := engine.UpgradeStep{Installers: []string{"claude"}, Command: "sh 'outdated.sh' update", Covers: []string{"claude"}, Program: true}
	eq(t, PaneItem{Name: "claude", Text: "claude 1.0.0 → 1.2.0"}, upgradeItem(step, answered))
}

// ---------------------------------------------------------------- stacked

// stackedAt is a model at w × h on the home page, with programs to list.
func stackedAt(t *testing.T, w, h int) *HomeModel {
	t.Helper()
	sections := sectionsOf(manifestFor(t), system, machineState(script("dotfiles", coremodel.Pending)), nil, nil, sectionOpts{})
	m := withState(modelOf(nil), HomeState{Sections: sections, Machine: "m1", System: "linux/fedora · x86_64",
		Programs: programRowsOf(manifestFor(t), system, machineState()), Missing: missingRowsOf(manifestFor(t), system, machineState())})
	m.width, m.height = w, h
	m.focus(FocusSidebar)
	return m
}

// frameOf is m's frame as plain text, checked to be exactly the screen.
func frameOf(t *testing.T, m *HomeModel) []string {
	t.Helper()
	lines := m.screenLines(0)
	eq(t, m.height, len(lines), "one line per row")
	for i, line := range lines {
		eq(t, m.width, ansi.StringWidth(line), "every row exactly the width: "+ansi.Strip(line))
		lines[i] = ansi.Strip(line)
	}
	return lines
}

func TestStackedOnePageFillsTheScreen(t *testing.T) {
	for _, size := range [][2]int{{99, 30}, {80, 24}, {60, 20}, {100, 30}} {
		m := stackedAt(t, size[0], size[1])
		wide := size[0] >= wideMinWidth
		eq(t, !wide, m.stacked(), fmt.Sprint(size))
		at := fmt.Sprintf("%dx%d", size[0], size[1])

		home := strings.Join(frameOf(t, m), "\n")
		truth(t, strings.Contains(home, "Machine ─") && strings.Contains(home, "programs"), at+" the home page: "+home)
		eq(t, wide, strings.Contains(home, "kitty"), at+" no list on the home page, unless side by side: "+home)

		press(m, KeyEnter)
		subject := frameOf(t, m)
		joined := strings.Join(subject, "\n")
		truth(t, strings.Contains(joined, "kitty") && strings.Contains(joined, "> filter"), at+" the subject page: "+joined)
		eq(t, wide, strings.Contains(joined, "Machine ─"), at+" no sidebar on the subject page, unless side by side")
		if !wide {
			eq(t, strings.Repeat("─", size[0]-2), strings.TrimSpace(subject[1]), at+" a rule under the breadcrumb")
			truth(t, !strings.Contains(joined, "│ "), at+" and no vertical one")
		}

		f := runSomething(t, m)
		f.view = "hello from pull"
		run := strings.Join(frameOf(t, m), "\n")
		truth(t, strings.Contains(run, "hello from pull"), at+" the run page: "+run)
		eq(t, wide, strings.Contains(run, "kitty"), at+" no list on the run page, unless side by side")
		if !wide {
			w, h := f.Size()
			eq(t, [2]int{size[0] - 2, size[1] - 4}, [2]int{w, h}, at+" the run fills the page under its title")
		}
		m.hey(strings.Repeat("long ", 60))
		m.state.Dialog = &Dialog{Kind: DialogConfirm, Pane: app.PaneScripts, Row: -1, Items: []PaneItem{{Name: "pull", Text: strings.Repeat("Pull the dotfiles repo ", 8)}}}
		joined = strings.Join(frameOf(t, m), "\n")
		truth(t, strings.Contains(joined, "Run") && strings.Contains(joined, "Cancel"), at+" the dialog fits: "+joined)
		for _, kind := range []DialogKind{DialogHelp, DialogPalette, DialogList} {
			m.state.Dialog = &Dialog{Kind: kind, Title: "Not in your loadout", Lines: []string{strings.Repeat("x", 120)}}
			frameOf(t, m)
		}
	}
}

func TestTheBreadcrumbSaysWhichPage(t *testing.T) {
	m := stackedAt(t, 80, 24)
	crumb := func() string { return strings.Join(strings.Fields(frameOf(t, m)[0]), " ") }
	truth(t, strings.HasPrefix(crumb(), "loadout › m1 "), crumb())
	settled, open := m.verdictCounts()
	truth(t, strings.HasSuffix(crumb(), fmt.Sprintf("✓%d ●%d", settled, open)), "the verdict counts at the right: "+crumb())
	press(m, KeyEnter)
	truth(t, strings.HasPrefix(crumb(), "loadout › programs ✓"), crumb())
	press(m, KeyInspect)
	truth(t, strings.HasPrefix(crumb(), "loadout › programs › inspect › kitty "), crumb())
	press(m, KeyEsc)
	f := runSomething(t, m)
	truth(t, strings.HasPrefix(crumb(), "loadout › programs › run ✓"), "a running command's own page names no ⟳: "+crumb())
	press(m, KeyLeave)
	truth(t, strings.HasPrefix(crumb(), "loadout › programs ⟳ run pull ✓"), "behind the list, it says it's still going: "+crumb())
	press(m, KeyEsc)
	eq(t, FocusSidebar, m.state.Focus)
	truth(t, strings.HasPrefix(crumb(), "loadout › m1 ⟳ run pull"), crumb())
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	truth(t, !strings.Contains(crumb(), "⟳"), "done: "+crumb())
	press(m, KeyDown, KeyDown, KeyDown, KeyDown, KeyDown)
	eq(t, 0, m.state.SideRun)
	press(m, KeyEnter)
	truth(t, strings.HasPrefix(crumb(), "loadout › m1 › run "), "opened from Runs: "+crumb())
}

func TestStackedPagesPushAndPop(t *testing.T) {
	m := stackedAt(t, 80, 24)
	press(m, KeyEnter)
	eq(t, FocusMain, m.state.Focus, "enter pushes the subject page")
	press(m, KeyEsc)
	eq(t, FocusSidebar, m.state.Focus, "esc pops home")
	press(m, KeyOpen)
	eq(t, FocusMain, m.state.Focus, "l pushes it too")
	press(m, KeyInspect)
	truth(t, m.state.Inspect != nil, "i pushes the inspector")
	press(m, KeyClose)
	truth(t, m.state.Inspect == nil, "h pops back to the list")
	eq(t, FocusMain, m.state.Focus)
	m.state.Filters = withValue(m.state.Filters, SubjectPrograms, "kit")
	press(m, KeyEsc)
	eq(t, FocusMain, m.state.Focus, "esc clears a filter first")
	eq(t, "", m.state.Filters[SubjectPrograms])
	press(m, KeyClose)
	eq(t, FocusSidebar, m.state.Focus, "h pops home")

	for _, k := range []HomeKey{KeyTab, KeyShiftTab} {
		press(m, k)
		eq(t, FocusSidebar, m.state.Focus, "tab does nothing: one page shows")
	}
	press(m, KeyEnter, KeyTab)
	eq(t, FocusMain, m.state.Focus)

	press(m, KeyEsc, KeySubject2)
	eq(t, FocusMain, m.state.Focus, "a subject key shows the subject's page from home")
	eq(t, SubjectScripts, m.state.subject())
	press(m, KeySubject1)
	eq(t, SubjectPrograms, m.state.subject())
	truth(t, slices.ContainsFunc(m.shortHelp(), func(b key.Binding) bool { return b.Help().Key == "esc" && b.Help().Desc == "back" }), "the list's help says esc goes back")
	for _, b := range fullHelp(true) {
		for _, h := range b {
			truth(t, h.Help().Key != "tab" && h.Help().Key != "z", "stacked, the full help has no tab and no zoom: "+h.Help().Key)
		}
	}
}

func TestAStackedRunHasItsOwnPage(t *testing.T) {
	m := stackedAt(t, 80, 24)
	press(m, KeyEnter)
	f := runSomething(t, m)
	eq(t, FocusTerminal, m.state.Focus, "a confirmed run pushes the run page")
	truth(t, m.terminalTakesKeys(), "keys go to the command")
	l := m.layout(true)
	c := m.terminalCursor()
	eq(t, [2]int{2 + l.mainX, 1 + l.panelY + 1}, [2]int{c.X, c.Y}, "the command's cursor, on its page")
	press(m, KeyLeave)
	eq(t, FocusMain, m.state.Focus, "ctrl+] pops back to the list while it runs")
	press(m, KeyEsc)
	eq(t, FocusSidebar, m.state.Focus, "esc on the list pops home: the panel isn't on this page")
	truth(t, m.shown != nil)
	press(m, KeyEnter, KeyTab)
	eq(t, FocusMain, m.state.Focus, "tab can't get back to a hidden terminal")
	m.focus(FocusTerminal)

	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	eq(t, FocusTerminal, m.state.Focus, "finished, it stays on its output")
	eq(t, "run pull done", message(m))
	press(m, KeyZoom)
	eq(t, false, m.state.Maximized, "z means nothing: the run page is already full")
	press(m, KeyEsc)
	truth(t, m.shown == nil, "esc closes the finished run")
	eq(t, FocusMain, m.state.Focus, "and pops back to the list it came from")

	// Opened from the home page's Runs, esc pops back to that entry.
	press(m, KeyEsc, KeyDown, KeyDown, KeyDown, KeyDown, KeyDown)
	eq(t, 0, m.state.SideRun)
	press(m, KeyEnter)
	eq(t, FocusTerminal, m.state.Focus, "enter on a run pushes its page")
	press(m, KeyEsc)
	eq(t, FocusSidebar, m.state.Focus)
	eq(t, 0, m.state.SideRun, "on the run's entry")

	// Home never closes a run it doesn't show.
	press(m, KeyEnter, KeyClose)
	eq(t, FocusSidebar, m.state.Focus, "h pops too, keeping the run")
	truth(t, m.shown != nil)
	press(m, KeyEsc)
	truth(t, m.shown != nil, "esc on home closes nothing hidden")
	truth(t, strings.Contains(message(m), "nothing to close"), message(m))
}

func TestResizingAcrossTheBreakpointKeepsTheFocus(t *testing.T) {
	m := stackedAt(t, 140, 40)
	press(m, KeyEnter)
	f := runSomething(t, m)
	m.runExited(term.ExitMsg{ID: f.id, Code: 0})
	m.focus(FocusTerminal)
	for _, w := range []int{80, 140, 99, 100} {
		m.resize(w, 30)
		eq(t, FocusTerminal, m.state.Focus, fmt.Sprint(w))
		fw, fh := f.Size()
		tw, th := m.layout(true).termSize()
		eq(t, [2]int{tw, th}, [2]int{fw, fh}, "the emulator follows the layout")
	}
	m.resize(80, 24)
	truth(t, strings.Contains(strings.Join(frameOf(t, m), "\n"), "Run"), "stacked, its page")
}

func TestStackedClicksHitTheVisiblePage(t *testing.T) {
	m := stackedAt(t, 80, 24)
	l := m.layout(false)
	// The home page: machine, system, blank, Machine ─, blank, then the subjects.
	m.click(tea.Mouse{Button: tea.MouseLeft, X: 5, Y: l.pageY + sideHead(false) + 1})
	eq(t, FocusMain, m.state.Focus, "a subject opens its page")
	eq(t, 1, m.state.Subject)
	press(m, KeySubject1)
	m.click(tea.Mouse{Button: tea.MouseLeft, X: 5, Y: l.listY + 1})
	eq(t, 1, m.state.Cursors[SubjectPrograms], "a list row selects")
	m.wheel(tea.Mouse{Button: tea.MouseWheelUp, X: 5, Y: l.listY + 1})
	eq(t, 0, m.state.Cursors[SubjectPrograms], "the wheel scrolls the page shown")
}
