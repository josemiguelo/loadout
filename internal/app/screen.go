package app

import "slices"

// The home screen (bare `loadout` on a TTY) observes, and runs every action
// it confirms as the matching subcommand: a child loadout in a
// pseudo-terminal shown inside the screen (RunCommand). It owns no domain
// logic; the CLI only starts it (cli's home) and prints what it ends with.
// They meet here, so neither package imports the other.

// HomeAction is what the user chose. The screen decides; the matching
// command does it.
type HomeAction int

const (
	ActionNone HomeAction = iota

	// Row verbs: what the focused subject needs. Each subject's list is in
	// the screen; acting on its ticks is a HandOff. None of these runs a
	// command by itself.
	ActionRunScripts
	ActionInstallMissing
	ActionApplyConfigs
	ActionReviewOutdated
	ActionShowDiff

	// Whole-machine verbs, on their own keys — they belong to no single row.
	ActionSync
	ActionUpgrade // self-upgrade: ends the loop afterwards
	ActionSetup

	// ActionHandOff runs Closed.Handoff, confirmed in the screen's dialog.
	ActionHandOff
)

// PaneKind is what the screen's confirm dialog asked about, and so which
// command a run starts.
type PaneKind int

const (
	PaneUpgrade PaneKind = iota
	PaneScripts
	PaneInstall
	PaneConfigs
	// PaneList only shows a list (the "N more not in your loadout" packages);
	// a run of it is an upgrade.
	PaneList
)

// Asking says the pane asks a question (Run/Cancel), rather than only listing.
func (k PaneKind) Asking() bool { return k != PaneList }

// Handoff is the command a confirmed dialog runs: Kind picks it, Args are its
// arguments as the screen built them (program, script, config or
// `<installer>`/`--item <source>/<name>` names), without the confirmation
// flags Command adds.
type Handoff struct {
	Kind PaneKind
	Args []string
}

// Closed is an action the user confirmed: the action, and with ActionHandOff
// the command it runs.
type Closed struct {
	Action  HomeAction
	Handoff *Handoff
}

// Command is the subcommand and arguments a run starts for closed; ok false
// means there is nothing to run. The dialog already asked, so the command's
// own confirmation is skipped.
func (c Closed) Command() (name string, args []string, ok bool) {
	switch c.Action {
	case ActionUpgrade:
		return "self-upgrade", nil, true
	case ActionSync:
		return "sync", nil, true
	case ActionSetup:
		return "setup-new-machine", nil, true
	case ActionHandOff:
		if c.Handoff == nil {
			return "", nil, false
		}
		args := slices.Clone(c.Handoff.Args)
		switch c.Handoff.Kind {
		case PaneInstall:
			return "install", append(args, "--yes"), true
		case PaneScripts:
			// `run` has no confirmation; --force runs a ticked script even when done.
			return "run", append(args, "--force"), true
		case PaneConfigs:
			// The screen already refused files edited here; never --force from it.
			return "apply", args, true
		default:
			return "upgrade", append(args, "--yes"), true
		}
	}
	return "", nil, false
}

// Screen is the home screen: Run draws it on the terminal's alternate
// screen until the user quits (or a run replaced loadout's binary), then
// gives the terminal back as it was.
type Screen interface {
	// Run shows the screen until it ends. An error is a terminal that
	// couldn't be bound; the CLI reports it.
	Run() (Ended, error)
}

// Ended is how the screen ended: Message (may be empty) is printed on the
// normal screen afterwards, and Code is loadout's exit code (a self-upgrade
// that failed ends the screen with its code).
type Ended struct {
	Message string
	Code    int
}

// NewScreen builds the home screen for app: it loads the stored state and
// starts the first refresh. nil until a TUI registers itself (its
// package's init sets it; cmd/loadout imports that package); bare
// `loadout` on a TTY prints help meanwhile.
var NewScreen func(app *AppContext) (Screen, error)
