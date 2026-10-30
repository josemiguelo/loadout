// Package tui is the home screen (bare `loadout` on a TTY): HomeModel holds
// ALL its state and logic, pure and unit-tested; the Bubble Tea program
// feeds it keys and background answers as messages, and view.go draws it.
package tui

import (
	"fmt"
	osexec "os/exec"
	"slices"
	"sort"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/josemiguelo/loadout/internal/app"
	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/diff"
	"github.com/josemiguelo/loadout/internal/core/engine"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/model"
	"github.com/josemiguelo/loadout/internal/tui/style"
	"github.com/josemiguelo/loadout/internal/tui/term"
)

// PaneItem is one row of a confirm dialog: a name, and what it means. List
// is a list row's lines ("N more not in your loadout"): enter on it opens
// them in a list dialog.
type PaneItem struct {
	Name, Text string
	List       []string
}

// ProgramRow is one program this machine maps, as the programs list shows
// it: what would install it, and its last verdict.
type ProgramRow struct {
	Name       string
	InstallKey string
	Command    string
	// Status is the last observed verdict; "" = never observed here.
	Status coremodel.ProgramStatus
	// Version is the version last observed, "" when none.
	Version string
}

// ScriptRow is one of this machine's maintenance scripts, as the scripts row lists it.
type ScriptRow struct {
	Name string
	// Command is the script itself, machine args applied.
	Command string
	// Description is what it's for, from the manifest — what the question shows next to its name.
	Description string
	// Status is the last observed verdict; "" = never observed here.
	Status coremodel.ScriptStatus
}

// ConfigItem is one config unit, as the configs row lists it.
type ConfigItem struct {
	Name string
	// Status is the last observed verdict; "" = never observed here.
	Status coremodel.ConfigStatus
	// Files is the files apply would change (drifted).
	Files []string
}

// ToolUpdates is one tool as the remote table shows it: app.ToolUpdates,
// with a Total that may be unknown (nil) — a tool no batch oracle described
// still heads its programs.
type ToolUpdates struct {
	Tool       string
	Installers []string
	// Total is every outdated package the tool reported; nil when no batch oracle can say.
	Total    *int
	Declared []string
	Others   []string
	Command  *string
}

func toolUpdatesOf(t app.ToolUpdates) ToolUpdates {
	total := t.Total
	return ToolUpdates{t.Tool, t.Installers, &total, t.Declared, t.Others, t.Command}
}

// RemoteStatus is what the remotes have said so far — they're asked on
// open, not on demand: nil (not asked), Asking, *Answered or Unavailable.
type RemoteStatus interface{ isRemoteStatus() }

// Asking is the remotes still being asked.
type Asking struct{}

// Unavailable is the remotes that couldn't be asked, and why.
type Unavailable struct{ Reason string }

// Answered is the remotes' answer.
type Answered struct {
	Updates       []app.UpdateRow
	FailedSources int
	// Tools is the doctor's view: every tool asked, with everything it reported, declared or not.
	Tools []ToolUpdates
	// MechanismOf is row name to the mechanism that can upgrade it. Upgrades
	// are whole-mechanism, so picking a row means picking its installer.
	// PROGRAM rows only — a custom source's row is never in here, however
	// its item happens to be named (see Sources).
	MechanismOf map[string]string
	// ToolOf is mechanism to the TOOL it drives (its probe binary): brew and
	// brew-cask are both "brew", dnf/dnf-repo/dnf-copr are all "dnf".
	// Selecting a row selects its tool — you upgrade brew, not formulae but
	// not casks.
	ToolOf map[string]string
	// MechanismsOfTool is tool to every mechanism it covers, for handing the engine names.
	MechanismsOfTool map[string][]string
	// Sources is EVERY custom source, mapped to whether it can update ONE of
	// its items (`upgrade` declared). Rows from an upgradable one tick
	// individually — a pin in a file has nothing in common with the next
	// pin. Keyed by SOURCE, not by row name: the same name can appear in two
	// sources (python is an asdf tool and an asdf plugin).
	//
	// Read-only sources are in here too, because what a row IS comes from
	// where it came from, never from its name. A source's item may share a
	// name with a mapped program — the live repo has a `tpack` tmux plugin
	// and a `tpack` brew cask — and a name lookup filed it under that
	// program's tool, so ticking it ran `brew upgrade`, which cannot move a
	// git clone, and the row came back outdated forever. One field, so "is a
	// source" and "can be upgraded" can never drift apart.
	Sources map[string]bool
	// ProgramUpgrades is the programs this machine maps that declare their
	// own `upgrade`: each is upgraded alone (`loadout upgrade <name>`),
	// whatever installer its variant names.
	ProgramUpgrades map[string]bool
}

func (Asking) isRemoteStatus()      {}
func (Unavailable) isRemoteStatus() {}
func (*Answered) isRemoteStatus()   {}

func (a *Answered) isSource(source string) bool { _, ok := a.Sources[source]; return ok }

// toolOfRow is the tool behind row's mechanism, "" when it has none.
func (a *Answered) toolOfRow(name string) string {
	mechanism, ok := a.MechanismOf[name]
	if !ok {
		return ""
	}
	return a.ToolOf[mechanism]
}

// Severity is how a subject line reads: settled, needs attention, severe.
type Severity int

const (
	Settled Severity = iota
	Attention
	Severe
)

// HomeSection is one subject line: its verdict, and the single verb that resolves it.
type HomeSection struct {
	Subject string
	Summary string
	// Short is the summary in a few cells, for the sidebar ("67/69", "2 drifted").
	Short    string
	Verb     string
	Action   app.HomeAction
	Severity Severity
	// Neutral says nothing has been asked yet, so neither settled nor a problem.
	Neutral bool
	// Busy says this subject is being (re)checked right now — the row spins.
	Busy bool
}

// FocusArea is where the keyboard is: the sidebar's subjects (and runs),
// the main pane's list, or the run panel's terminal.
type FocusArea int

const (
	FocusSidebar FocusArea = iota
	FocusMain
	// FocusTerminal exists only while the run panel shows: every key goes to
	// the command except ctrl+] (back to the main pane).
	FocusTerminal
)

// HomeState is everything the screen shows and decides from.
type HomeState struct {
	Machine  string
	System   string
	Sections []HomeSection
	// Subject is the subject the main pane shows: an index into Sections.
	Subject int
	// Focus is the focused area.
	Focus FocusArea
	// SideRun is the Runs entry the sidebar's cursor is on (an index into
	// the runs, newest first), -1 when it is on the subjects.
	SideRun int
	// RunFromSidebar says the panel's run was opened from the sidebar's Runs:
	// leaving or closing it puts the focus back there, on that entry.
	RunFromSidebar bool
	// Cursors is each subject's cursor in its own list (a position in the
	// list as shown, filter applied); Offsets its first visible row.
	Cursors map[string]int
	Offsets map[string]int
	// Filters is each subject's filter text; Filtering says the filter
	// input has the keyboard.
	Filters   map[string]string
	Filtering bool
	// Inspect is the inspector the main pane shows instead of its list.
	Inspect *Inspector
	// Checking is the subjects (programs, scripts, configs) whose checks are
	// still running: each row spins until its OWN part lands.
	Checking map[string]bool
	// Stale says the verdicts are the last `status`'s, not this moment's.
	Stale  bool
	Remote RemoteStatus
	// Fleet is the fleet comparison, kept for the fleet table and the inspector.
	Fleet *diff.DiffReport
	// Selection is the remote rows ticked for upgrading, by selection key.
	Selection map[string]bool
	// Collapsed is the remote tree's groups folded shut (`tool:<probe>` / `source:<name>`).
	Collapsed map[string]bool
	// Programs is every program this machine maps, with its last verdict:
	// missing ones first (the work), then the rest in manifest order.
	Programs []ProgramRow
	// Missing is the missing programs, in manifest order: what can be ticked to install.
	Missing []ProgramRow
	// Chosen is the missing programs ticked to install. All of them, after every re-check: missing IS the work.
	Chosen map[string]bool
	// Scripts is this machine's maintenance scripts, in run order, with their last verdicts.
	Scripts []ScriptRow
	// Picked is the scripts ticked to run. Follows the verdicts: not done = ticked, after every re-check.
	Picked map[string]bool
	// Configs is this machine's config units with their last verdicts; empty without `repo { configs }`.
	Configs []ConfigItem
	// Applying is the configs ticked to apply. Follows the verdicts: drifted = ticked, after every re-check.
	Applying map[string]bool
	// Dialog is the dialog up, if any: it owns the keyboard.
	Dialog *Dialog
	// Maximized says the run panel takes the whole main pane.
	Maximized bool
	Dark      bool
	Exit      bool
}

// HomeModel is the home screen: one place that says what needs working on,
// and runs each kind of work as the command that already does it.
//
// It owns NO domain logic — StatusEngine observes, diff compares, explain
// explains, and every action is a real subcommand, run in the run panel's
// terminal. Its state changes only on the Bubble Tea program's Update
// goroutine: background work runs as a tea.Cmd on the jobs runner and lands
// as a message, so no write can put back a state copied before another
// landed.
type HomeModel struct {
	app   *app.AppContext
	state HomeState
	jobs  *jobs

	manifest *model.Manifest
	system   *coremodel.SystemInfo
	stored   *coremodel.MachineState
	// partial is the refresh under way: stored, with each subject's fresh
	// part replacing its own as it lands; partToolsDown the programs part's.
	partial       *coremodel.MachineState
	partToolsDown []engine.ToolDown
	// gArmed says the last key was a lone g: another one makes gg.
	gArmed bool

	// width and height are the terminal's size, from the program.
	width, height int
	toasts        style.Toasts
	// cmds is what reducers asked the program to run (toast expiries, the
	// terminal's messages); the program takes them after every update.
	cmds []tea.Cmd

	// runs is this session's runs, oldest first; active is the one running,
	// shown the one in the run panel (nil: no panel); waiting is a confirmed
	// action held until the background checks finish.
	runs    []*Run
	active  *Run
	shown   *Run
	waiting *app.Closed
	nextRun int
	// ended is what the screen ends with after a run replaced loadout's binary.
	ended *app.Ended

	// Seams for tests: the command a confirmed action runs, the terminal it
	// runs in, explain.
	runCommand func(app.Closed) (*osexec.Cmd, error)
	newTerm    func(w, h int) terminal
	explain    func(names []string) ([]app.ExplainedName, error)
	now        func() time.Time
}

func newHomeModel(a *app.AppContext, dark bool) *HomeModel {
	m := &HomeModel{app: a, state: HomeState{Dark: dark, SideRun: -1}, jobs: newJobs(), width: 120, height: 40, now: time.Now}
	m.newTerm = func(w, h int) terminal { return realTerm{term.New(w, h)} }
	if a != nil {
		m.runCommand = a.RunCommand
		m.explain = a.Explain
	}
	return m
}

func (m *HomeModel) setStateForTest(s HomeState) {
	if s.SideRun == 0 && len(m.runs) == 0 {
		s.SideRun = -1
	}
	m.state = s
}

// withConfigs says the repo has `repo { configs = … }`: the configs subject is there.
func (m *HomeModel) withConfigs() bool { return m.app != nil && m.app.HasConfigs() }

// theme is the screen's palette now.
func (m *HomeModel) theme() style.Theme { return style.For(m.state.Dark) }

// setRows is every subject's rows from observed, ticks following the verdicts.
func (m *HomeModel) setRows(manifest model.Manifest, sys coremodel.SystemInfo, observed *coremodel.MachineState) {
	s := &m.state
	s.Programs = programRowsOf(manifest, sys, observed)
	s.Missing = missingRowsOf(manifest, sys, observed)
	s.Chosen = namesOf(s.Missing, func(p ProgramRow) string { return p.Name })
	s.Scripts = scriptRowsOf(manifest, sys, observed)
	s.Picked = preselect(s.Scripts)
	s.Configs = configItemsOf(observed)
	s.Applying = preselectConfigs(s.Configs)
}

// load puts the stored verdicts on screen immediately. Call before the
// screen shows; an error is the screen's.
func (m *HomeModel) load() error {
	manifest, err := m.app.LoadManifest()
	if err != nil {
		return err
	}
	sys := m.app.DetectSystem()
	m.manifest = &manifest
	m.system = &sys
	store, err := m.app.StateStore()
	if err != nil {
		return err
	}
	stored := store.Read(sys.Machine)
	m.stored = stored
	report := m.fleet()
	s := &m.state
	s.Machine = sys.Machine
	distro := ""
	if sys.Distro != nil {
		distro = "/" + *sys.Distro
	}
	s.System = string(sys.Os) + distro + " · " + sys.Arch
	s.Sections = sectionsOf(manifest, sys, stored, report, nil, sectionOpts{withConfigs: m.withConfigs()})
	s.Subject = min(s.Subject, len(s.Sections)-1)
	s.Fleet = report
	m.setRows(manifest, sys, stored)
	s.Stale = stored != nil
	if warnings := store.LastWarnings(); len(warnings) > 0 {
		m.warn(warnings[0])
	}
	return nil
}

// refreshedMsg is the machine's own checks, landed.
type refreshedMsg struct {
	fresh       *coremodel.MachineState
	err         error
	known       *coremodel.MachineState
	remotes     bool
	toolsDown   []engine.ToolDown
	configsDown *string
}

// partMsg is one subject of the refresh, landed before the others.
type partMsg struct{ part engine.Part }

// remoteMsg is the remotes' answer, landed.
type remoteMsg struct {
	remote    RemoteStatus
	toolsDown []engine.ToolDown
}

// sayMsg is a background job's one line for a toast.
type sayMsg struct {
	kind    style.ToastKind
	message string
}

// refresh asks two questions at once: the machine's own checks (~3s) and
// the remotes (~4s). The remote query starts IMMEDIATELY against the stored
// state rather than queueing behind the refresh — waiting seconds to start
// asking is the thing this screen exists to avoid. Each lands as it
// finishes. remotes = false re-checks the machine only, keeping the answers
// already on screen.
func (m *HomeModel) refresh(remotes bool) {
	if m.manifest == nil || m.system == nil || len(m.state.Checking) > 0 {
		return
	}
	manifest, sys := *m.manifest, *m.system
	// Recompute the rows too: "asking…" has to show the moment we start,
	// not when the first answer lands.
	remote := m.state.Remote
	if remotes {
		remote = Asking{}
	}
	m.state.Checking = map[string]bool{SubjectPrograms: true, SubjectScripts: true}
	if m.withConfigs() {
		m.state.Checking[SubjectConfigs] = true
	}
	m.partial, m.partToolsDown = nil, nil
	if m.stored != nil {
		partial := *m.stored
		m.partial = &partial
	}
	m.state.Sections = sectionsOf(manifest, sys, m.stored, m.fleet(), remote,
		sectionOpts{checking: m.state.Checking, withConfigs: m.withConfigs()})
	m.state.Remote = remote

	known := m.stored
	if remotes && known != nil {
		m.askRemotes(*known)
	}
	a, post := m.app, m.jobs.post
	m.jobs.start(func() tea.Msg {
		// Each subject lands as its own checks finish; the state file is
		// written once, after the last.
		fresh, err := a.RefreshAndWriteStateParts(manifest, sys, model.Map[coremodel.ScriptState]{},
			func(p engine.Part) { post(partMsg{part: p}) })
		msg := refreshedMsg{err: err, known: known, remotes: remotes,
			toolsDown: a.LastToolsDown(), configsDown: a.LastConfigsDown()}
		if err == nil {
			msg.fresh = &fresh
		}
		return msg
	})
}

func (m *HomeModel) refreshed(msg refreshedMsg) {
	if m.manifest == nil || m.system == nil {
		return
	}
	manifest, sys := *m.manifest, *m.system
	observed := msg.fresh
	if observed == nil {
		observed = msg.known
	}
	if observed != nil {
		m.stored = observed
	}
	report := m.fleet()
	s := &m.state
	s.Checking = nil
	m.partial, m.partToolsDown = nil, nil
	s.Stale = msg.err != nil
	s.Fleet = report
	s.Sections = sectionsOf(manifest, sys, observed, report, s.Remote,
		sectionOpts{toolsDown: msg.toolsDown, withConfigs: m.withConfigs()})
	m.setRows(manifest, sys, observed)
	// A tool the checks go through wasn't there: one sentence, in a toast
	// where a person reads — not only a count in a row.
	switch {
	case msg.err != nil:
		m.fail(firstLine(msg.err.Error()))
	case len(msg.toolsDown) > 0:
		m.warn(msg.toolsDown[0].Message() + " · r re-checks once it is fixed")
	case msg.configsDown != nil:
		m.warn("configs not checked: " + *msg.configsDown)
	}
	// A machine with no state file yet couldn't be asked about above.
	if msg.remotes && msg.known == nil && observed != nil {
		m.askRemotes(*observed)
	}
}

// partLanded is one subject of the refresh, in: its row stops spinning
// and shows its fresh answer while the others still check. A part that
// failed waits for the refresh's own message, which says why.
func (m *HomeModel) partLanded(msg partMsg) {
	if m.manifest == nil || m.system == nil || len(m.state.Checking) == 0 || msg.part.Err != nil {
		return
	}
	manifest, sys := *m.manifest, *m.system
	if m.partial == nil {
		m.partial = &coremodel.MachineState{Machine: sys.Machine}
	}
	p := msg.part
	subject := ""
	switch p.Kind {
	case engine.PartPrograms:
		m.partial.Programs, m.partToolsDown, subject = p.Programs, p.ToolsDown, SubjectPrograms
	case engine.PartScripts:
		m.partial.Scripts, subject = p.Scripts, SubjectScripts
	case engine.PartConfigs:
		m.partial.Configs, subject = p.Configs, SubjectConfigs
	}
	checking := map[string]bool{}
	for k, v := range m.state.Checking {
		if k != subject {
			checking[k] = v
		}
	}
	m.state.Checking = checking
	m.state.Sections = sectionsOf(manifest, sys, m.partial, m.state.Fleet, m.state.Remote,
		sectionOpts{checking: checking, toolsDown: m.partToolsDown, withConfigs: m.withConfigs()})
	m.setRows(manifest, sys, m.partial)
}

// askRemotesAgain asks the remotes only: the machine's own rows are already current.
func (m *HomeModel) askRemotesAgain() {
	if m.manifest == nil || m.system == nil || m.stored == nil {
		return
	}
	m.state.Remote = Asking{}
	m.state.Sections = sectionsOf(*m.manifest, *m.system, m.stored, m.state.Fleet, Asking{},
		sectionOpts{withConfigs: m.withConfigs()})
	m.askRemotes(*m.stored)
}

// reload is the rows again from the state file a command just wrote; the remotes' answer stays.
func (m *HomeModel) reload() {
	if m.manifest == nil || m.system == nil || m.app == nil {
		return
	}
	manifest, sys := *m.manifest, *m.system
	observed := m.stored
	if store, err := m.app.StateStore(); err == nil {
		if read := store.Read(sys.Machine); read != nil {
			observed = read
		}
	}
	m.stored = observed
	report := m.fleet()
	s := &m.state
	s.Sections = sectionsOf(manifest, sys, observed, report, s.Remote, sectionOpts{withConfigs: m.withConfigs()})
	s.Fleet = report
	m.setRows(manifest, sys, observed)
	s.Stale = false
}

// askRemotes starts the remotes' question against observed.
func (m *HomeModel) askRemotes(observed coremodel.MachineState) {
	if m.manifest == nil || m.system == nil {
		return
	}
	manifest, sys, a := *m.manifest, *m.system, m.app
	m.jobs.start(func() tea.Msg {
		// Cached self-check: this screen opens constantly and GitHub's
		// unauthenticated API is rate-limited. `outdated` asks fresh.
		r, err := a.OutdatedReport(manifest, sys, observed, false)
		if err != nil {
			return remoteMsg{remote: Unavailable{Reason: firstLineOr(err.Error(), "unreachable")}, toolsDown: a.LastToolsDown()}
		}
		return remoteMsg{remote: answeredOf(manifest, sys.Machine, r), toolsDown: a.LastToolsDown()}
	})
}

// answeredOf is the report r as the remote row keeps it.
func answeredOf(manifest model.Manifest, machine string, r app.OutdatedReport) *Answered {
	mapping := manifest.Machines.Value(machine).PM
	used := engine.UpgradableInstallers(manifest, machine)
	answered := &Answered{
		Updates:          r.Updates,
		FailedSources:    len(r.Errors),
		MechanismOf:      map[string]string{},
		ToolOf:           map[string]string{},
		MechanismsOfTool: map[string][]string{},
		Sources:          map[string]bool{},
		ProgramUpgrades:  map[string]bool{},
	}
	for _, t := range r.Tools {
		answered.Tools = append(answered.Tools, toolUpdatesOf(t))
	}
	for _, row := range r.Updates {
		// A custom source's row is its source's, whatever it is called —
		// never the program of that name.
		if manifest.Outdated.Has(row.Source) || row.Source == "release" {
			continue
		}
		key, ok := mapping.Get(row.Name)
		if !ok {
			continue
		}
		if with := manifest.ResolveInstall(row.Name, key).UpgradeWith; with != nil {
			answered.MechanismOf[row.Name] = with.Installer
		}
	}
	// ONLY mechanisms this machine's mapping uses. Grouping every installer
	// that shares a probe would reach the built-in `brew` from a repo that
	// never maps it — and then upgrade the real Homebrew.
	for _, mechanism := range used.Keys() {
		tool := mechanism
		if installer, ok := manifest.Installers.Get(mechanism); ok && installer.Probe != nil {
			tool = *installer.Probe
		}
		answered.ToolOf[mechanism] = tool
		answered.MechanismsOfTool[tool] = append(answered.MechanismsOfTool[tool], mechanism)
	}
	for name, source := range manifest.Outdated.All() {
		answered.Sources[name] = source.Upgrade != nil
	}
	for _, name := range mapping.Keys() {
		if program, ok := manifest.Programs.Get(name); ok && program.Outdated != nil && program.Outdated.Upgrade != nil {
			answered.ProgramUpgrades[name] = true
		}
	}
	return answered
}

func (m *HomeModel) remoteLanded(msg remoteMsg) {
	m.state.Remote = msg.remote
	if m.manifest == nil || m.system == nil {
		return
	}
	observed := m.stored
	if len(m.state.Checking) > 0 && m.partial != nil {
		observed = m.partial
	}
	m.state.Sections = sectionsOf(*m.manifest, *m.system, observed, m.fleet(), msg.remote,
		sectionOpts{checking: m.state.Checking, toolsDown: msg.toolsDown, withConfigs: m.withConfigs()})
}

// apply is a background job's message landing on the state.
func (m *HomeModel) apply(msg tea.Msg) {
	switch msg := msg.(type) {
	case partMsg:
		m.partLanded(msg)
	case refreshedMsg:
		m.refreshed(msg)
	case remoteMsg:
		m.remoteLanded(msg)
	case sayMsg:
		m.say(msg.kind, msg.message)
	}
}

func (m *HomeModel) fleet() *diff.DiffReport {
	if m.manifest == nil || m.app == nil {
		return nil
	}
	states, err := m.app.FleetStates()
	if err != nil || states.Len() == 0 {
		return nil
	}
	report := diff.Diff(*m.manifest, slices.Collect(states.Values()))
	return &report
}

// startUpgrade asks about upgrading the ticked tools and source items,
// then hands off to `loadout upgrade`. Planned with the same engine, so
// refusals show before the screen closes.
func (m *HomeModel) startUpgrade(answered *Answered, selection map[string]bool) {
	if m.manifest == nil || m.system == nil || m.state.Dialog != nil {
		return
	}
	manifest, machine := *m.manifest, m.system.Machine
	// Tools sweep; source items go one at a time, in the order shown.
	var installers, programs []string
	items := map[string][]string{}
	for key := range selection {
		switch {
		case strings.HasPrefix(key, "tool:"):
			installers = append(installers, answered.MechanismsOfTool[strings.TrimPrefix(key, "tool:")]...)
		case strings.HasPrefix(key, "prog:"):
			programs = append(programs, strings.TrimPrefix(key, "prog:"))
		case strings.HasPrefix(key, "item:"):
			source, item, _ := strings.Cut(strings.TrimPrefix(key, "item:"), "/")
			items[source] = append(items[source], item)
		}
	}
	sort.Strings(installers)
	sort.Strings(programs)
	var sources []string
	for _, row := range answered.Updates {
		if _, ok := items[row.Source]; ok && !slices.Contains(sources, row.Source) {
			sources = append(sources, row.Source)
		}
	}
	for source := range items {
		if !slices.Contains(sources, source) {
			sources = append(sources, source)
		}
	}
	plan, err := engine.PlanUpgrade(manifest, machine, installers)
	if err == nil {
		var more []engine.UpgradeStep
		more, err = engine.PlanProgramUpgrades(manifest, machine, programs)
		plan = append(plan, more...)
	}
	args := append(slices.Clone(installers), programs...)
	for _, source := range sources {
		if err != nil {
			break
		}
		rows := slices.Sorted(slices.Values(items[source]))
		var more []engine.UpgradeStep
		more, err = engine.PlanSourceItems(manifest, source, rows)
		plan = append(plan, more...)
		for _, row := range rows {
			args = append(args, "--item", source+"/"+row)
		}
	}
	if err != nil {
		m.fail(firstLine(err.Error()))
		return
	}
	if len(plan) == 0 {
		return
	}
	var rows []PaneItem
	for _, step := range plan {
		rows = append(rows, upgradeItem(step, answered))
		// The sweep's cost, in full: a list row opens every package it moves
		// that loadout doesn't declare.
		if step.Sweep {
			for _, tool := range answered.Tools {
				if len(tool.Others) > 0 && slices.ContainsFunc(tool.Installers, func(i string) bool { return slices.Contains(step.Installers, i) }) {
					rows = append(rows, PaneItem{Text: fmt.Sprintf("%s %d more not in your loadout", style.GlyphMore, len(tool.Others)), List: tool.Others})
				}
			}
		}
	}
	m.ask(app.Handoff{Kind: app.PaneUpgrade, Args: args}, rows)
}

// startInstalls asks about installing the ticked missing programs, then
// hands off to `loadout install <names>`. Planned with InstallEngine like
// the command (dependencies first, refusals before the screen closes).
func (m *HomeModel) startInstalls(chosen map[string]bool) {
	if m.state.Dialog != nil {
		return
	}
	var names []string
	for _, p := range m.state.Missing {
		if chosen[p.Name] {
			names = append(names, p.Name)
		}
	}
	if len(names) == 0 {
		m.hey("nothing ticked — space ticks a program, a ticks them all")
		return
	}
	if m.manifest == nil || m.system == nil || m.app == nil {
		return
	}
	a := m.app
	frame, err := a.Frame(*m.system)
	if err != nil {
		m.fail(firstLine(err.Error()))
		return
	}
	installs := engine.NewInstallEngine(a.Runner, engine.NewVersionChecker(a.Runner, frame), frame)
	var current model.Map[coremodel.ProgramState]
	if m.stored != nil {
		current = m.stored.Programs
	}
	plan, err := installs.Plan(*m.manifest, m.system.Machine, names, current, a.BinaryAvailable)
	if err != nil {
		m.fail(firstLine(err.Error()))
		return
	}
	steps := engine.Installs(plan)
	if len(steps) == 0 {
		m.hey("already installed — r re-checks")
		return
	}
	// The installer, and which programs are unticked dependencies.
	rows := make([]PaneItem, len(steps))
	for i, step := range steps {
		text := "via " + step.InstallKey
		if !slices.Contains(names, step.Program) {
			text += " · needed first"
		}
		rows[i] = PaneItem{Name: step.Program, Text: text}
	}
	m.ask(app.Handoff{Kind: app.PaneInstall, Args: names}, rows)
}

// startScripts asks about running the ticked scripts, then hands off to
// `loadout run <names> --force` (a ticked script runs even when done). `run`
// records each one and re-asks its check.
func (m *HomeModel) startScripts(picked map[string]bool) {
	if m.state.Dialog != nil {
		return
	}
	var names []string
	var rows []PaneItem
	for _, step := range m.state.Scripts {
		if picked[step.Name] {
			names = append(names, step.Name)
			rows = append(rows, PaneItem{Name: step.Name, Text: step.Description})
		}
	}
	if len(names) == 0 {
		m.hey("nothing ticked — space ticks a script, a ticks them all")
		return
	}
	m.ask(app.Handoff{Kind: app.PaneScripts, Args: names}, rows)
}

// startConfigs asks about writing the ticked configs, then hands off to
// `loadout apply <names>`. A file edited on this machine would stop `apply`,
// so it stops here, before the screen closes, naming the file: which
// version wins is the user's call, made in a terminal (`chezmoi re-add`, or
// `loadout apply --force`).
func (m *HomeModel) startConfigs(picked map[string]bool) {
	if m.state.Dialog != nil {
		return
	}
	var chosen []ConfigItem
	for _, config := range m.state.Configs {
		if picked[config.Name] {
			chosen = append(chosen, config)
		}
	}
	if len(chosen) == 0 {
		m.hey("nothing ticked — space ticks a config, a ticks them all")
		return
	}
	edited, err := func() ([]string, error) {
		if m.app == nil {
			return nil, fmt.Errorf("no repo")
		}
		configs, err := m.app.Configs()
		if err != nil || configs == nil {
			return nil, err
		}
		units, err := configs.Units()
		if err != nil {
			return nil, err
		}
		targets := []string{}
		for _, unit := range units {
			if slices.ContainsFunc(chosen, func(c ConfigItem) bool { return c.Name == unit.Name }) {
				targets = append(targets, unit.Targets...)
			}
		}
		return configs.Edited(targets)
	}()
	if err != nil {
		m.fail(firstLine(err.Error()))
		return
	}
	// A refusal with a list: the toast says what happened, the dialog lists
	// the files.
	if len(edited) > 0 {
		m.fail("edited on this machine: " + strings.Join(edited, ", ") + " — keep with chezmoi re-add, or run loadout apply --force")
		m.state.Dialog = &Dialog{
			Kind:    DialogList,
			Title:   "Edited here",
			Lines:   edited,
			Summary: "Keep them with chezmoi re-add, or overwrite them with loadout apply --force, in a terminal.",
		}
		return
	}
	names := make([]string, len(chosen))
	rows := make([]PaneItem, len(chosen))
	for i, config := range chosen {
		names[i] = config.Name
		text := "not checked"
		switch config.Status {
		case coremodel.ConfigDrifted:
			text = strings.Join(config.Files, ", ")
		case coremodel.ConfigApplied:
			text = "already applied · written again"
		}
		rows[i] = PaneItem{Name: config.Name, Text: text}
	}
	m.ask(app.Handoff{Kind: app.PaneConfigs, Args: names}, rows)
}

// openInBrowser hands url to the desktop (xdg-open, else open) off the
// Update goroutine and says how it went: the opener's own last line when
// it fails — a Qt "could not connect to display" was once a silent core
// dump behind "opened …" — with the URL kept on screen to copy by hand.
func (m *HomeModel) openInBrowser(url string) {
	if m.app == nil {
		return
	}
	runner := m.app.Runner
	m.jobs.start(func() tea.Msg {
		result, err := runner.Capture(exec.Line(
			`sh -c 'command -v xdg-open >/dev/null 2>&1 && exec xdg-open "$1" || exec open "$1"' sh `+app.ShQuote(url)+" </dev/null", ""))
		if err != nil {
			return sayMsg{style.ToastError, fmt.Sprintf("could not open a browser (%s) — %s", firstLine(err.Error()), url)}
		}
		if result.Success() {
			return sayMsg{style.ToastOK, "opened " + url}
		}
		said := ""
		for _, line := range strings.Split(result.Stderr+result.Stdout, "\n") {
			if t := strings.TrimSpace(line); t != "" {
				said = t
			}
		}
		if said == "" {
			said = fmt.Sprintf("exit %d", result.ExitCode)
		}
		return sayMsg{style.ToastError, fmt.Sprintf("could not open a browser (%s) — %s", said, url)}
	})
}

// upgradeItem is the question's row for one upgrade step. A sweep says how
// much moves and how much of it is yours ("all 168 packages · 2 in your
// loadout"); a source item gives its version change.
func upgradeItem(step engine.UpgradeStep, answered *Answered) PaneItem {
	if step.Program {
		name := step.Covers[0]
		for _, row := range answered.Updates {
			if row.Name == name && !answered.isSource(row.Source) {
				return PaneItem{Name: name, Text: name + " " + row.Current + " → " + row.Candidate}
			}
		}
		return PaneItem{Name: name, Text: name}
	}
	if !step.Sweep {
		source, item := step.Installers[0], step.Covers[0]
		for _, row := range answered.Updates {
			if row.Source == source && row.Name == item {
				return PaneItem{Name: source, Text: item + " " + row.Current + " → " + row.Candidate}
			}
		}
		return PaneItem{Name: source, Text: item}
	}
	// A custom source's row never counts toward a mechanism, even when named like a program.
	mine := 0
	for _, row := range answered.Updates {
		if mechanism, ok := answered.MechanismOf[row.Name]; ok && !answered.isSource(row.Source) && slices.Contains(step.Installers, mechanism) {
			mine++
		}
	}
	yours := fmt.Sprintf("%d in your loadout", mine)
	if mine == 0 {
		yours = "none in your loadout"
	}
	// A total only when this step covers the whole tool: a tool split over
	// two commands (formulae and casks) can't divide its total between them.
	var tools []ToolUpdates
	for _, tool := range answered.Tools {
		if slices.ContainsFunc(tool.Installers, func(i string) bool { return slices.Contains(step.Installers, i) }) {
			tools = append(tools, tool)
		}
	}
	whole := len(tools) > 0
	total := 0
	for _, tool := range tools {
		if tool.Total == nil || !allIn(tool.Installers, step.Installers) {
			whole = false
		}
		if tool.Total != nil {
			total += *tool.Total
		}
	}
	if whole {
		return PaneItem{Name: step.Label(), Text: fmt.Sprintf("all %d package%s · %s", total, plural(total), yours)}
	}
	return PaneItem{Name: step.Label(), Text: "every package it manages · " + yours}
}

// scriptRowsOf is the scripts row's picker — this machine's opted-in
// maintain-mode scripts in run order, each with the verdict the last
// observation wrote down (never observed = "", which is unproven, not done).
func scriptRowsOf(manifest model.Manifest, system coremodel.SystemInfo, observed *coremodel.MachineState) []ScriptRow {
	machine, ok := manifest.Machines.Get(system.Machine)
	if !ok {
		return nil
	}
	enabled := machine.ScriptArgs()
	var rows []ScriptRow
	for _, name := range assemble.ScriptOrder(manifest, enabled.Keys()) {
		args, ok := enabled.Get(name)
		step, declared := manifest.Scripts.Get(name)
		if !ok || !declared || !step.RunsIn("maintain") {
			continue
		}
		row := ScriptRow{Name: name, Command: engine.CommandFor(step, args), Description: step.Description}
		if observed != nil {
			if verdict, ok := observed.Scripts.Get(name); ok {
				row.Status = verdict.Status
			}
		}
		rows = append(rows, row)
	}
	return rows
}

// missingRowsOf is the programs row's picker — every mapped program the
// last observation found missing, in manifest order, with the command its
// mapped variant would run (dependencies are the engine's business when
// the ticks are planned).
func missingRowsOf(manifest model.Manifest, system coremodel.SystemInfo, observed *coremodel.MachineState) []ProgramRow {
	mapping := manifest.Machines.Value(system.Machine).PM
	var rows []ProgramRow
	for _, name := range manifest.Programs.Keys() {
		key, mapped := mapping.Get(name)
		if !mapped || observed == nil {
			continue
		}
		if state, ok := observed.Programs.Get(name); !ok || state.Status != coremodel.Missing {
			continue
		}
		command := ""
		if c := manifest.ResolveInstall(name, key).Command; c != nil {
			command = *c
		}
		rows = append(rows, ProgramRow{Name: name, InstallKey: key, Command: command, Status: coremodel.Missing})
	}
	return rows
}

// programRowsOf is the programs list — every program this machine maps,
// with its last verdict: missing ones first (in manifest order, as
// missingRowsOf), then the rest.
func programRowsOf(manifest model.Manifest, system coremodel.SystemInfo, observed *coremodel.MachineState) []ProgramRow {
	mapping := manifest.Machines.Value(system.Machine).PM
	rows := missingRowsOf(manifest, system, observed)
	for _, name := range manifest.Programs.Keys() {
		key, mapped := mapping.Get(name)
		if !mapped {
			continue
		}
		row := ProgramRow{Name: name, InstallKey: key}
		if c := manifest.ResolveInstall(name, key).Command; c != nil {
			row.Command = *c
		}
		if observed != nil {
			if state, ok := observed.Programs.Get(name); ok {
				if state.Status == coremodel.Missing {
					continue
				}
				row.Status = state.Status
				if state.Version != nil {
					row.Version = *state.Version
				}
			}
		}
		rows = append(rows, row)
	}
	return rows
}

// preselect ticks anything not known-done: that IS the work.
func preselect(rows []ScriptRow) map[string]bool {
	picked := map[string]bool{}
	for _, row := range rows {
		if row.Status != coremodel.Done {
			picked[row.Name] = true
		}
	}
	return picked
}

// configItemsOf is the configs row's picker — every unit the last observation saw, by name.
func configItemsOf(observed *coremodel.MachineState) []ConfigItem {
	if observed == nil {
		return nil
	}
	var items []ConfigItem
	for _, name := range slices.Sorted(slices.Values(observed.Configs.Keys())) {
		config := observed.Configs.Value(name)
		items = append(items, ConfigItem{name, config.Status, config.Files})
	}
	return items
}

// preselectConfigs ticks drifted configs; an unchecked one can't promise anything to write.
func preselectConfigs(rows []ConfigItem) map[string]bool {
	applying := map[string]bool{}
	for _, row := range rows {
		if row.Status == coremodel.ConfigDrifted {
			applying[row.Name] = true
		}
	}
	return applying
}

// RemoteKind is what one line of the remote table is.
type RemoteKind int

const (
	// RemoteTool is a tool line (dnf, brew…) with everything it reported.
	RemoteTool RemoteKind = iota
	// RemoteProgram is a declared program under its tool.
	RemoteProgram
	// RemoteOthers is what the sweep touches that loadout doesn't declare — enter lists them all.
	RemoteOthers
	// RemoteSource is a custom source's heading. Its items tick one at a
	// time, and the heading ticks all of them at once (ItemKeys; empty =
	// read-only source).
	RemoteSource
	// RemoteGap is breathing room between groups.
	RemoteGap
	// RemoteItem is one of a custom source's items.
	RemoteItem
)

var remoteKindNames = [...]string{"Tool", "Program", "Others", "Source", "Gap", "Item"}

func (k RemoteKind) String() string { return remoteKindNames[k] }

// RemoteLine is one line of the remote table. The table is grouped by what
// will ACT: a tool line with everything it reported, its declared programs
// under it, a note for what it would touch beyond them; then each custom
// source with its items. Key is what ticking selects ("" = can't).
type RemoteLine struct {
	Kind RemoteKind
	Key  string
	// Group is the group this line belongs to — what h folds and l unfolds; "" = none.
	Group string
	// Foldable says folding this heading would hide anything. A clean tool
	// heads no rows, so a chevron on it promises content that doesn't exist
	// — and folding is filtered by group, which can't tell "folded, nothing
	// hidden" from "folded, rows hidden" once the rows are gone.
	Foldable bool
	// Info is a Tool line's tool.
	Info ToolUpdates
	// Row is a Program or Item line's row.
	Row app.UpdateRow
	// Tool and Names are an Others line's tool and package names.
	Tool  string
	Names []string
	// Name and ItemKeys are a Source heading's source and its items' keys.
	Name     string
	ItemKeys []string
}

// Focusable says the line is a cursor stop.
func (l RemoteLine) Focusable() bool { return l.Kind != RemoteGap }

// Heading says the line stays when its group is folded.
func (l RemoteLine) Heading() bool { return l.Kind == RemoteTool || l.Kind == RemoteSource }

// Refusal is why ticking does nothing, when it does nothing ("" = it ticks).
func (l RemoteLine) Refusal() string {
	switch l.Kind {
	case RemoteTool:
		if l.Key == "" {
			return l.Info.Tool + " declares no upgrade command"
		}
	case RemoteProgram:
		if l.Key == "" {
			return l.Row.Name + " has no mechanism loadout can upgrade"
		}
	case RemoteOthers:
		return "nothing to tick — enter lists them"
	case RemoteSource:
		if len(l.ItemKeys) == 0 {
			return l.Name + " can't update its items from loadout"
		}
	case RemoteItem:
		if l.Key == "" {
			return l.Row.Source + " can't update its items from loadout"
		}
	}
	return ""
}

// Link is a page about this row's change, when its source printed one.
func (l RemoteLine) Link() string {
	if l.Kind == RemoteItem && l.Row.Link != nil {
		return *l.Row.Link
	}
	return ""
}

// remoteLines is the remote table as lines — tools first (every one asked,
// clean ones too), then sources. A group in collapsed keeps only its heading.
func remoteLines(answered *Answered, collapsed map[string]bool) []RemoteLine {
	var lines []RemoteLine
	placed := map[int]bool{}
	// A tool no batch oracle described (per-package oracles only) still heads
	// its programs — it just can't say how many others it would move.
	described := map[string]bool{}
	for _, t := range answered.Tools {
		described[t.Tool] = true
	}
	var undescribed []ToolUpdates
	for _, row := range answered.Updates {
		tool := answered.toolOfRow(row.Name)
		if tool == "" || described[tool] {
			continue
		}
		i := slices.IndexFunc(undescribed, func(t ToolUpdates) bool { return t.Tool == tool })
		if i < 0 {
			undescribed = append(undescribed, ToolUpdates{Tool: tool, Installers: answered.MechanismsOfTool[tool], Command: ptr("")})
			i = len(undescribed) - 1
		}
		undescribed[i].Declared = append(undescribed[i].Declared, row.Name)
	}
	// A blank line between groups, except between two QUIET ones — up to
	// date, or folded: one-liners read better stacked.
	previousQuiet := true
	gap := func(quiet bool) {
		if len(lines) > 0 && !(previousQuiet && quiet) {
			lines = append(lines, RemoteLine{Kind: RemoteGap})
		}
		previousQuiet = quiet
	}
	for _, tool := range append(slices.Clone(answered.Tools), undescribed...) {
		group := "tool:" + tool.Tool
		gap((tool.Total != nil && *tool.Total == 0) || collapsed[group])
		key := ""
		if _, ok := answered.MechanismsOfTool[tool.Tool]; tool.Command != nil && ok {
			key = group
		}
		// Its rows, before its heading: the heading has to say whether it
		// heads anything. Sources keep their own rows — read-only included.
		var rows []int
		for i, row := range answered.Updates {
			if !placed[i] && !answered.isSource(row.Source) && row.Source != "release" &&
				(answered.toolOfRow(row.Name) == tool.Tool || slices.Contains(tool.Declared, row.Name)) {
				rows = append(rows, i)
			}
		}
		lines = append(lines, RemoteLine{Kind: RemoteTool, Info: tool, Key: key, Group: group,
			Foldable: len(rows) > 0 || len(tool.Others) > 0})
		for _, i := range rows {
			lines = append(lines, RemoteLine{Kind: RemoteProgram, Row: answered.Updates[i], Key: key, Group: group})
			placed[i] = true
		}
		if len(tool.Others) > 0 {
			lines = append(lines, RemoteLine{Kind: RemoteOthers, Tool: tool.Tool, Names: tool.Others, Group: group})
		}
	}
	// Everything else, grouped by source: the binary's own row, custom
	// sources, and programs whose mechanism no tool line claimed.
	var sources []string
	bySource := map[string][]app.UpdateRow{}
	for i, row := range answered.Updates {
		if placed[i] {
			continue
		}
		if _, seen := bySource[row.Source]; !seen {
			sources = append(sources, row.Source)
		}
		bySource[row.Source] = append(bySource[row.Source], row)
	}
	for _, source := range sources {
		rows := bySource[source]
		group := "source:" + source
		gap(collapsed[group])
		var keys []string
		for _, row := range rows {
			if key := selectionKey(answered, row); key != "" {
				keys = append(keys, key)
			}
		}
		// A source exists only because it has rows.
		lines = append(lines, RemoteLine{Kind: RemoteSource, Name: source, ItemKeys: keys, Group: group, Foldable: true})
		for _, row := range rows {
			lines = append(lines, RemoteLine{Kind: RemoteItem, Row: row, Key: selectionKey(answered, row), Group: group})
		}
	}
	return slices.DeleteFunc(lines, func(l RemoteLine) bool {
		return !l.Heading() && l.Group != "" && collapsed[l.Group]
	})
}

// selectionKey is what ticking row selects. A package row selects the TOOL
// behind it (dnf, brew — the sweep upgrades all of it); a custom source's
// row selects just that row, because its items are independent. "" =
// loadout can't upgrade it at all.
func selectionKey(answered *Answered, row app.UpdateRow) string {
	if row.Source == "release" {
		return ""
	}
	// A program with its own upgrade moves alone, never through its installer's sweep.
	if answered.ProgramUpgrades[row.Name] && !answered.isSource(row.Source) {
		return "prog:" + row.Name
	}
	// A source's row ticks itself or nothing at all. It never falls through
	// to a tool: sharing a name with a mapped program would otherwise tick
	// that program's sweep, which cannot move what the source tracks.
	if upgradable, ok := answered.Sources[row.Source]; ok {
		if upgradable {
			return "item:" + row.Source + "/" + row.Name
		}
		return ""
	}
	tool := answered.toolOfRow(row.Name)
	if tool == "" {
		return ""
	}
	return "tool:" + tool
}

// FleetLine is one row of the fleet table: a drifting program (Program
// set), or a config drifted somewhere (Config set).
type FleetLine struct {
	Program *diff.ProgramRow
	Config  *diff.ConfigRow
}

// Name is the program's or the config unit's.
func (l FleetLine) Name() string {
	if l.Program != nil {
		return l.Program.Program
	}
	return l.Config.Unit
}

// driftedRows is the drifting half of the fleet comparison — the only part
// the table shows. Programs, then configs.
func driftedRows(s HomeState) []FleetLine {
	if s.Fleet == nil {
		return nil
	}
	var rows []FleetLine
	for i := range s.Fleet.Rows {
		if row := &s.Fleet.Rows[i]; row.Drift() || row.Incomplete() {
			rows = append(rows, FleetLine{Program: row})
		}
	}
	for i := range s.Fleet.Configs {
		if row := &s.Fleet.Configs[i]; row.Drifted() {
			rows = append(rows, FleetLine{Config: row})
		}
	}
	return rows
}

// summaryWidth is all a subject line gets for its answer, so the summary can fit itself.
const summaryWidth = 41

const sep = " · "

// remoteSummary is the remote row's one line, ordered by what the reader
// can do about it: a tool is ONE command for every package it has, so it
// leads; everything else takes an update each, counted and then named
// biggest-group-first while the width lasts.
//
// A tool with nothing outdated is left OUT — naming it spent the line
// saying there was no work ("brew 0 · 42 pins"), while the 42 that did have
// work stayed anonymous. Counts of different kinds of work never merge into
// one total either: "brew 3" is one keystroke, "42 more" is forty-two.
func remoteSummary(remote *Answered) string {
	// A nil total is "no batch oracle can say", which is not the same as
	// idle — keep asking with a "?" rather than claiming it's clean.
	var head []string
	for _, tool := range remote.Tools {
		switch {
		case tool.Total == nil:
			head = append(head, tool.Tool+" ?")
		case *tool.Total > 0:
			head = append(head, fmt.Sprintf("%s %d", tool.Tool, *tool.Total))
		}
	}
	tools := len(head)
	var singles []app.UpdateRow
	for _, row := range remote.Updates {
		if _, mapped := remote.MechanismOf[row.Name]; remote.isSource(row.Source) || row.Source == "release" || !mapped {
			singles = append(singles, row)
		}
	}
	switch {
	case len(singles) == 0:
	// "more" only reads right after a count it adds to.
	case tools > 0:
		head = append(head, fmt.Sprintf("%d more", len(singles)))
	case len(singles) == 1:
		head = append(head, "1 update")
	default:
		head = append(head, fmt.Sprintf("%d updates", len(singles)))
	}
	// A crashed source outranks the group names: it's the one thing on this
	// line that means the rest of the line may be understating the work.
	switch remote.FailedSources {
	case 0:
	case 1:
		head = append(head, "1 source failed")
	default:
		head = append(head, fmt.Sprintf("%d sources failed", remote.FailedSources))
	}
	if len(head) == 0 {
		return "everything up to date"
	}

	counts := map[string]int{}
	var labels []string
	for _, row := range singles {
		label := groupLabel(row)
		if counts[label] == 0 {
			labels = append(labels, label)
		}
		counts[label]++
	}
	sort.SliceStable(labels, func(i, j int) bool {
		if counts[labels[i]] != counts[labels[j]] {
			return counts[labels[i]] > counts[labels[j]]
		}
		return labels[i] < labels[j]
	})
	line := strings.Join(head, sep)
	shown := 0
	for _, label := range labels {
		candidate := line + sep + fmt.Sprintf("%s %d", label, counts[label])
		if runes(candidate) > summaryWidth {
			break
		}
		line = candidate
		shown++
	}
	// The marker counts the groups left, which the total can't say — but it
	// never costs a named group, since the total already implies "and more".
	if shown >= 1 && shown < len(labels) {
		if marker := fmt.Sprintf("%s+%d more", sep, len(labels)-shown); runes(line)+runes(marker) <= summaryWidth {
			line += marker
		}
	}
	return line
}

// remoteShort is the remote row in a few cells: how many updates in all
// (a tool's every package, plus each single row), or that none is waiting.
func remoteShort(remote *Answered) string {
	total := 0
	unknown := false
	for _, tool := range remote.Tools {
		if tool.Total == nil {
			unknown = true
		} else {
			total += *tool.Total
		}
	}
	for _, row := range remote.Updates {
		if _, mapped := remote.MechanismOf[row.Name]; remote.isSource(row.Source) || row.Source == "release" || !mapped {
			total++
		}
	}
	short := ""
	switch {
	case total > 0:
		short = fmt.Sprint(total)
	case unknown:
		short = "?"
	default:
		short = "up to date"
	}
	if remote.FailedSources > 0 {
		short += fmt.Sprintf(" · %d failed", remote.FailedSources)
	}
	return short
}

// groupLabel is where a row came from, as the reader knows it — not as the code keys it.
func groupLabel(row app.UpdateRow) string {
	if row.Source == "release" {
		return "loadout"
	}
	return row.Source
}

// sectionOpts is sectionsOf's optional inputs.
type sectionOpts struct {
	// checking is the subjects whose checks are running: those rows spin.
	checking  map[string]bool
	toolsDown []engine.ToolDown
	// withConfigs says the repo has `layout configs`.
	withConfigs bool
}

// sectionsOf is the subject lines for a machine's observed state —
// programs, scripts, configs (withConfigs: the repo has `layout configs`),
// remote, fleet.
func sectionsOf(
	manifest model.Manifest,
	system coremodel.SystemInfo,
	observed *coremodel.MachineState,
	fleet *diff.DiffReport,
	remote RemoteStatus,
	opts sectionOpts,
) []HomeSection {
	var programs model.Map[coremodel.ProgramState]
	var scripts model.Map[coremodel.ScriptState]
	var configs model.Map[coremodel.ConfigState]
	if observed != nil {
		programs, scripts, configs = observed.Programs, observed.Scripts, observed.Configs
	}
	missing, installed := 0, 0
	// Checks that couldn't run (their tool wasn't there): neither installed
	// nor missing, and nothing to install — the machine has to be fixed first.
	var unchecked []coremodel.ProgramState
	for state := range programs.Values() {
		switch {
		case state.Status == coremodel.Missing:
			missing++
		case state.Status == coremodel.Installed:
			installed++
		case state.Status == coremodel.Unknown && state.Reason != nil:
			unchecked = append(unchecked, state)
		}
	}
	unfinished, done := 0, 0
	for state := range scripts.Values() {
		if state.Status == coremodel.Done {
			done++
		} else {
			unfinished++
		}
	}
	// The picker lists maintain-mode scripts; a machine with none has
	// nothing to open, whatever setup-only scripts are pending (C for those).
	pickable := len(scriptRowsOf(manifest, system, observed)) > 0
	mapped := manifest.Machines.Value(system.Machine).PM.Len()
	drifted, configsDrifted := 0, 0
	if fleet != nil {
		for _, row := range fleet.Rows {
			if row.Drift() || row.Incomplete() {
				drifted++
			}
		}
		for _, row := range fleet.Configs {
			if row.Drifted() {
				configsDrifted++
			}
		}
	}
	configsOff, configsUnchecked := 0, 0
	var firstUnchecked *coremodel.ConfigState
	for state := range configs.Values() {
		switch state.Status {
		case coremodel.ConfigDrifted:
			configsOff++
		case coremodel.ConfigUnknown:
			configsUnchecked++
			if firstUnchecked == nil {
				firstUnchecked = &state
			}
		}
	}
	var sections []HomeSection

	// While the checks run the row is only the spinner, like the remote
	// row: a stale count next to it reads as the answer.
	checking := opts.checking[SubjectPrograms]
	programsRow := HomeSection{Subject: "programs", Action: app.ActionNone, Neutral: checking, Busy: checking}
	switch {
	case checking:
	case observed == nil:
		programsRow.Summary = fmt.Sprintf("%d mapped — not observed yet", mapped)
		programsRow.Short = fmt.Sprintf("%d mapped", mapped)
	case len(unchecked) == 0:
		programsRow.Summary = fmt.Sprintf("%d installed · %d missing", installed, missing)
	default:
		programsRow.Summary = fmt.Sprintf("%d installed · %d missing · %d not checked", installed, missing, len(unchecked))
	}
	if observed != nil && !checking {
		programsRow.Short = fmt.Sprintf("%d/%d", installed, mapped)
	}
	switch {
	case checking:
	case missing > 0:
		programsRow.Verb = "install what's missing"
	// Say what's wrong, not "nothing missing": the checks that failed never
	// answered. In loadout's words when the refresh asked the tool itself;
	// the shell's line otherwise (a stored state has no tools-down list).
	case len(unchecked) > 0:
		if len(opts.toolsDown) > 0 {
			if down := opts.toolsDown[0]; down.OnPath {
				programsRow.Verb = down.Tool + " checks fail"
			} else {
				programsRow.Verb = down.Tool + " is not on PATH"
			}
		} else {
			programsRow.Verb = *unchecked[0].Reason
		}
	default:
		programsRow.Verb = "nothing missing"
	}
	if missing > 0 {
		programsRow.Action = app.ActionInstallMissing
		programsRow.Severity = Severe
	} else if len(unchecked) > 0 {
		programsRow.Severity = Attention
	}
	sections = append(sections, programsRow)

	checking = opts.checking[SubjectScripts]
	scriptsRow := HomeSection{Subject: "scripts", Action: app.ActionNone, Neutral: checking, Busy: checking}
	switch {
	case checking:
	case observed == nil:
		scriptsRow.Summary = "not observed yet"
	default:
		scriptsRow.Summary = fmt.Sprintf("%d done · %d pending", done, unfinished)
		scriptsRow.Short = fmt.Sprintf("%d/%d", done, done+unfinished)
	}
	switch {
	case checking:
	case unfinished == 0:
		scriptsRow.Verb = "nothing pending"
	default:
		scriptsRow.Verb = "run what's pending"
	}
	if pickable {
		scriptsRow.Action = app.ActionRunScripts
	}
	if unfinished > 0 {
		scriptsRow.Severity = Attention
	}
	sections = append(sections, scriptsRow)

	checking = opts.checking[SubjectConfigs]
	if opts.withConfigs {
		configsRow := HomeSection{Subject: "configs", Action: app.ActionApplyConfigs, Neutral: checking, Busy: checking}
		switch {
		case checking:
		case configs.Len() == 0:
			configsRow.Summary = "not observed yet"
		case configsUnchecked > 0:
			configsRow.Summary = fmt.Sprintf("%d applied · %d drifted · %d not checked",
				configs.Len()-configsOff-configsUnchecked, configsOff, configsUnchecked)
		default:
			configsRow.Summary = fmt.Sprintf("%d applied · %d drifted", configs.Len()-configsOff, configsOff)
		}
		switch {
		case checking || configs.Len() == 0:
		case configsOff > 0:
			configsRow.Short = fmt.Sprintf("%d drifted", configsOff)
		case configsUnchecked > 0:
			configsRow.Short = fmt.Sprintf("%d not checked", configsUnchecked)
		default:
			configsRow.Short = fmt.Sprintf("%d applied", configs.Len())
		}
		switch {
		case checking:
		case configsOff > 0:
			configsRow.Verb = "apply what's drifted"
		case configsUnchecked > 0:
			configsRow.Verb = "not checked"
			if firstUnchecked.Reason != nil {
				configsRow.Verb = *firstUnchecked.Reason
			}
		default:
			configsRow.Verb = "nothing drifted"
		}
		if configs.Len() == 0 {
			configsRow.Action = app.ActionNone
		}
		if configsOff > 0 || configsUnchecked > 0 {
			configsRow.Severity = Attention
		}
		sections = append(sections, configsRow)
	}

	remoteRow := HomeSection{Subject: "remote", Verb: "review them", Action: app.ActionReviewOutdated}
	switch r := remote.(type) {
	case nil:
		remoteRow.Summary = "not asked yet"
		remoteRow.Short = "not asked"
		remoteRow.Neutral = true
	// Empty on purpose: the row shows the spinner instead.
	case Asking:
		remoteRow.Verb = ""
		remoteRow.Neutral = true
		remoteRow.Busy = true
	case Unavailable:
		remoteRow.Summary = "unavailable — " + r.Reason
		remoteRow.Short = "unavailable"
		remoteRow.Neutral = true
	case *Answered:
		remoteRow.Summary = remoteSummary(r)
		remoteRow.Short = remoteShort(r)
		outdated := len(r.Updates) > 0 || slices.ContainsFunc(r.Tools, func(t ToolUpdates) bool { return t.Total != nil && *t.Total > 0 })
		switch {
		case r.FailedSources > 0:
			remoteRow.Severity = Severe
		case outdated:
			remoteRow.Severity = Attention
		}
	}
	sections = append(sections, remoteRow)

	fleetRow := HomeSection{Subject: "fleet", Verb: "compare the fleet", Action: app.ActionShowDiff}
	switch {
	case fleet == nil:
		fleetRow.Summary = "no state files yet"
	case drifted == 0 && configsDrifted == 0:
		fleetRow.Summary = fmt.Sprintf("%d machine(s) in sync", len(fleet.Machines))
	case configsDrifted == 0:
		fleetRow.Summary = fmt.Sprintf("%d program(s) drifted across %d machines", drifted, len(fleet.Machines))
	case drifted == 0:
		fleetRow.Summary = fmt.Sprintf("%d config(s) drifted across %d machines", configsDrifted, len(fleet.Machines))
	default:
		fleetRow.Summary = fmt.Sprintf("%d program(s) · %d config(s) drifted", drifted, configsDrifted)
	}
	switch {
	case fleet == nil:
		fleetRow.Short = "no states"
	case drifted+configsDrifted > 0:
		fleetRow.Short = fmt.Sprintf("%d drifted", drifted+configsDrifted)
	default:
		fleetRow.Short = fmt.Sprintf("%d in sync", len(fleet.Machines))
	}
	if fleet == nil {
		fleetRow.Verb = "nothing to compare"
		fleetRow.Action = app.ActionNone
	}
	if drifted > 0 || configsDrifted > 0 {
		fleetRow.Severity = Attention
	}
	return append(sections, fleetRow)
}

// ---------------------------------------------------------------- helpers

func ptr[T any](v T) *T { return &v }

func runes(s string) int { return len([]rune(s)) }

func padEnd(s string, width int) string {
	if n := runes(s); n < width {
		return s + strings.Repeat(" ", width-n)
	}
	return s
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

func firstLineOr(s, fallback string) string {
	if line := firstLine(s); line != "" {
		return line
	}
	return fallback
}

func allIn(xs, in []string) bool {
	for _, x := range xs {
		if !slices.Contains(in, x) {
			return false
		}
	}
	return true
}

func namesOf[T any](rows []T, name func(T) string) map[string]bool {
	names := make(map[string]bool, len(rows))
	for _, row := range rows {
		names[name(row)] = true
	}
	return names
}

// with is s plus keys, as a new set: a state's sets are never changed in place.
func with[K comparable](s map[K]bool, keys ...K) map[K]bool {
	out := make(map[K]bool, len(s)+len(keys))
	for k, v := range s {
		if v {
			out[k] = true
		}
	}
	for _, k := range keys {
		out[k] = true
	}
	return out
}

// without is s minus keys, as a new set.
func without[K comparable](s map[K]bool, keys ...K) map[K]bool {
	out := make(map[K]bool, len(s))
	for k, v := range s {
		if v && !slices.Contains(keys, k) {
			out[k] = true
		}
	}
	return out
}

func toggled(s map[string]bool, key string) map[string]bool {
	if s[key] {
		return without(s, key)
	}
	return with(s, key)
}

func containsAll(s map[string]bool, keys []string) bool {
	for _, k := range keys {
		if !s[k] {
			return false
		}
	}
	return true
}
