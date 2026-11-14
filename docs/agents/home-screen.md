# The home screen

## Driving it without a human

**Driving the TUI without a human**: the home screen needs a real TTY; fake
one with `script` and pipe keys in, and read what it draws from
`LOADOUT_SCREEN_DUMP=<file>` (the current frame as plain text, rewritten
after every render; the renderer writes only changed rows, so the raw
capture can't be grepped). Give the screen time to bind the tty
and finish its first refresh: a key on a busy row is refused, a key before
raw mode is lost. By hand, sleeps do; the integration suite waits on the
dump instead (see testing.md). Set the pty's size inside it
(`stty cols 140 rows 40`): script's pty has none.

```sh
# Linux: the command is one string, the log is the last argument.
(sleep 4; printf 'l'; sleep 1; printf 'q') | LOADOUT_SCREEN_DUMP=$PWD/frame.txt script -qec "stty cols 140 rows 40; $BIN --repo <repo>" /dev/null
# macOS (BSD script): the log comes first, the command is plain argv.
(sleep 4; printf 'l'; sleep 1; printf 'q') | LOADOUT_SCREEN_DUMP=$PWD/frame.txt script -q /dev/null sh -c 'stty cols 140 rows 40; exec "$0" --repo <repo>' "$BIN"
```

A run that doesn't exit means something kept the screen alive after q
(see "The home screen's mechanics" below). Rendering changes
still need a human check: ask the user to run it.

**Ctrl-C in a run**: every action runs its command as a child loadout in
the run panel's pseudo-terminal (src/tui/term), its own session with
the PTY as controlling terminal, so Ctrl-C typed into the panel is the
line discipline's SIGINT to the child's process group, never to the screen.
The child is started with `LOADOUT_HANDOFF=1`: it traps SIGINT
(src/main.ts), stops, and exits 130, which the screen reads as
"interrupted". `70-home-screen` checks Ctrl-C on both platforms.

## How it works

- **Home screen** (bare `loadout` on a TTY; a pipe gets help):
  `src/tui` (homemodel.ts + keys.ts hold all state and logic,
  unit-tested; view.ts draws). Layout B, master–detail, in Crush's style
  (user decisions): the sidebar LEFT (32 cols) and the main pane right of
  it, which shows one subject (programs, scripts, configs — only with
  `repo({ configs })` —, remote, fleet) under a plain title row
  (`Programs` bold in primary, its summary at the right), a filter line and
  the subject's list. Plain, styled text only: no `╱` hatch, no block-letter
  logo (the user removed both). The sidebar has the brand line (`loadout`
  in a gradient, the version at the right), the machine, a `Machine`
  section with the five subjects (status glyph, name, short count) and
  `Runs` (this session's runs, newest first). Side by side needs ≥100
  columns (width only: a wide but short window keeps it). Tests find a row
  by its text, never by position.
- **Under 100 columns the screen is STACKED** (user decision), like a
  website's sidebar collapsing on a phone: ONE page fills the screen, the
  focused area's — FocusArea.Sidebar is the home page (the sidebar's content,
  full width), FocusArea.Main the subject page (title, filter, list or
  inspector), FocusArea.Terminal the run page (the panel, full height). Same
  state, focus areas and reducers; only the presentation changes, so a
  resize across 100 keeps the focus. A breadcrumb row on top (`loadout ›
  m1`, `loadout › programs › inspect › git`, `loadout › scripts › run`;
  the verdict counts ✓N ●M at the right, and `⟳ <run>` while a command
  runs off-page), a horizontal `style.divider` rule under it (no `│` or
  `├`). enter/l push (a subject's page, a run's page), i the inspector,
  esc/h pop one level; 1–5 show a subject's page from anywhere; tab and z
  do nothing (one page shows). A confirmed run pushes the run page,
  ctrl+] pops to the list while it runs, and a finished run STAYS on its
  output (user decision) until esc closes it and pops to where it came
  from. esc never closes a run panel that isn't on the page shown. Clicks
  and the wheel hit the visible page only.
- **Rules set the areas apart** side by side (user decision: the sidebar
  and the run panel blended into the main pane): a vertical `│` in the
  gutter between the sidebar and the main pane, full height, and with the run panel a
  horizontal rule above it that meets it in a `├` (none when zoomed), both
  in `style.divider` (BgMost: quiet, still visible on a transparent
  terminal). The focused area's title wears the focused selection's
  highlight (`titleRowFocused`: the Primary fill and OnPrimary ink of a
  selected row), so tab lands on something that stands out in every area,
  the run panel included (user decision); every other title is muted
  (`titleRowMuted`). The sidebar has no title row: its selected entry is
  its highlight.
- **Focus areas, not one cursor** (user decision): the sidebar (subjects, then runs), the main pane
  (its list, filter or inspector) and the terminal (only while the run
  panel shows). tab/shift+tab cycle them (side by side); ctrl+] always leaves the
  terminal for the main pane. A run opened from the sidebar's Runs
  (enter or a click) gives the focus back to that entry when the panel is
  left (h/←) or closed (esc) — `runFromSidebar` — not to the main pane,
  which never opened it. The focused area's selection is a full-row fill,
  with no bar (user decision: the `▌` read as a stray `|`) — Primary with
  OnPrimary ink, the same in the sidebar
  (`style.subjectRow`) as in the main pane (`listRow`), so the active
  entry stands out (user decision); an unfocused area keeps its
  selection on a dimmer BgLess fill. Moving in
  the sidebar switches the main pane's subject at once; 1–5 jump. Each
  subject keeps its own cursor, scroll and filter (`cursors`/`offsets`/
  `filters`, keyed by subject name); `snap` re-resolves a cursor against
  the CURRENT rows after every reshape (nearest stop at or above), so an
  emptied list never highlights nothing. Keys: ↑↓/jk move, pgup/pgdn page,
  `[`/`]` jump between remote groups (not `H`/`L`), l/→ into the list or
  unfold, h/← fold or back to the sidebar, space tick, a all, u none, enter
  ACTS in the list (a confirm dialog first; never on a busy subject) and
  on a sidebar subject only goes INTO its list, like l (user decision: a
  command never starts from a row whose ticks aren't in view; enter on a
  sidebar run shows that run), `/` filter (fuzzy,
  matched characters underlined; esc clears), ctrl+d/ctrl+u half a page as in vim and less (user decision; the list, the inspector and a finished run's output — a running command gets them, ctrl+d is its end of input), `i` inspector, `K` link, `r`
  re-check, `S` sync, `U` self-upgrade, `C` setup-new-machine (each asks
  first), `t` theme, `z` zoom the run panel, ctrl+p command palette, ctrl+g
  full help, `q` quit. Mouse: click a subject, run or row; the wheel
  scrolls the list or the panel under it.
- **esc closes, never quits**: only `q` leaves the screen. esc closes a
  dialog, the inspector or the filter, then a FINISHED run's panel from
  whichever area has the focus (`finishedPanel`; the help line says "esc
  close run"; stacked, only from the run page), then backs out of the main
  pane to the sidebar; there it says "nothing to close — q quits". A
  finished run KEEPS the focus (user decision), in both layouts: its
  output is what you look at next (scroll, gg/G, z, esc), and its
  emulator is blurred, so keys are the screen's, not the ended command's.
  esc there closes it and gives the focus back to where the run came from
  (`backFromRun`); from another area esc closes it too (`70-home-screen`
  checks esc right after a run). A running command's panel never closes: ctrl+c stops it. Ctrl-C on the
  dashboard never quits either: with a run going it interrupts it (as in
  its terminal), otherwise a toast says "q quits".
- **Remote tree** is grouped by the TOOL that will act (`remoteLines`,
  from `OutdatedReport.tools`): a heading per probe (brew and brew-cask are
  one tool) with its declared programs nested under it and an amber "⋯ N
  more not in your loadout" line for the sweep's real cost (enter lists
  them), then each custom source as a heading with its items. space
  selects a tool's whole mechanism (ticking any row under it lights up the
  tool) or a source's one item (its heading ticks all of them), a selects
  all, u clears, enter asks and runs. Groups FOLD (h/l, `▾`/`▸`); a remote
  line's `foldable` makes an empty heading (a clean tool) unfoldable, since
  folding can't be derived at render time once its rows are gone. **A row
  is keyed by where it came from, never by name** (`selectionKey`/
  `mechanismOf`): a source item named like a mapped program must upgrade
  through its source, not the program's mechanism. `remoteSummary` (the
  title's info) names tools with work first, then one count of everything
  else, then the biggest named group, then "+N more"; an idle tool is
  never named, and the two kinds of count are never merged. `K` opens a
  row's link when its source printed one. Batch oracles read STDOUT ONLY.
  `l` only unfolds, never dispatches. A filter keeps a matching row's
  heading, and a matching heading's rows.
- **Configs**: every unit the last observation saw, with its verdict and
  drifted files; drifted ones pre-ticked (`preselectConfigs`). Enter first
  asks chezmoi which ticked files were edited on this machine
  (`ConfigEngine.edited`): any, and an Error toast names them plus a list
  dialog of the files, and nothing runs (the choice between `chezmoi
  re-add` and `apply --force` is made in a terminal, never from the
  screen); none, and it asks, then runs `apply <names>`. The fleet subject
  and its table count config drift too.
- **Scripts**: maintain-mode scripts in run order with their last verdict;
  anything not done pre-ticked (`preselect`, re-applied after every
  refresh). Enter runs the ticks as `run <names> --force`, which
  re-verifies and names scripts that exited 0 but still fail their check.
  **Programs**: every program this machine maps with its verdict (missing
  first); only missing ones tick, planned with the InstallEngine's plan
  (dependencies first, the same refusals as `install`) and run as
  `install <names> --yes`. **Fleet**: the drifting programs and configs,
  machines as columns.
- **Inspector** (`i`, user decision): the row's program, script or config
  as `explain` resolves it (`app.explain`, shared with the CLI: no explain
  logic in the TUI), where it is declared, this machine's last verdict
  from the rows on screen, and every machine's from the fleet comparison.
  esc goes back to the list.
- **Commands run INSIDE the screen** (user decision): a confirmed action runs its real
  subcommand in the run panel, an embedded terminal below the list (45% of
  the main pane, at least 10 rows; `z` gives it the whole pane). A
  finished run's output scrolls with ↑↓, pgup/pgdn, ctrl+u/ctrl+d, and
  jumps to its start with home or gg and to its end with end or G, as in
  vim and less (user decision; `gArmed` holds the first g, any other key
  disarms it). A running command gets all of those keys itself. The
  panel shows `term.Model`'s content — the scrollback, then the screen down
  to its last written row or the cursor's — last rows first, scrolling
  back through it: a panel that grows (zoom) fills its new rows from the
  scrollback, as kitty or iTerm do on a resize, never its output at the
  top over blank rows (the emulator alone keeps them in its scrollback).
  A full-screen program (the alternate screen) is shown as it draws.
  - `startUpgrade`/`startScripts`/`startInstalls`/`startConfigs` plan
    first (refusals are toasts before anything runs), then `ask()` opens
    the confirm dialog: one row per step, name plus meaning (`upgradeItem`:
    "all 168 packages · 2 in your loadout"; a script's description; an
    install's installer), never the command; a sweep adds its "N more not
    in your loadout" list row (↑↓ selects it, enter lists them). Buttons
    Run/Cancel: ←→, h/l or tab move, enter presses, y/n press directly,
    esc/q cancel. S, U and C ask in the same dialog.
  - The yes builds the command with `AppContext.runCommand` (a CHILD
    loadout: `platform.selfExecutable()`, the global options, the
    subcommand with `--yes`/`--force` as `closedCommand` says,
    `LOADOUT_HANDOFF=1`, `PAGER=cat`/`GIT_PAGER=cat`: a pager would work in
    the panel, but its screen leaves nothing in the run's log) and starts
    it in a `term.Model` (src/tui/term: a PTY through `Bun.spawn({ terminal
    })`/`Bun.Terminal`, its screen kept by `@xterm/headless`; replies
    written back at once, redraws coalesced, OSC 10/11 answered with the
    theme's colours, ExitMsg only after the last output). The terminal is
    focused: EVERY key goes to the child except ctrl+], so sudo, `gum
    confirm` and pagers work as in a shell (kitty/CSI-u keys don't).
  - ONE run at a time: a second action, and q, are refused with a toast
    while one runs. Background checks are HELD (`jobs.hold`): a confirmed
    action waits for the checks already running (none may run beside the
    command or write the state file after it), and a check asked for
    during the run is deferred to its end (`jobs.release`).
  - When it exits: a toast (✓ Done / × Error exit N / ! Warning interrupted),
    the checks released, and `followUp`: rows re-read the state file the
    command wrote; an upgrade also re-asks the remotes (its ticks clear on
    success only), sync/setup reload everything (layout included), a
    failure re-checks the machine. U, and an S whose repo now refuses this
    binary (`loader.toolTooOld`), END the screen: the binary on disk is a
    different version, and the run's output plus what to do next is
    printed on the normal screen (app's `Ended`).
  - The run stays in the panel until esc dismisses it or the next run
    starts, and in the sidebar's Runs (at most `maxRuns`; enter shows one
    again). Only the newest finished run keeps its emulator (4 MiB); older
    ones are closed and keep their text (`close()` keeps the plain text).
- **Dialogs** are centred overlays (no dim): confirm, list, command
  palette (ctrl+p: fuzzy filter, every machine verb and subject with its
  key) and help (ctrl+g: every binding, grouped; stacked, it names no
  tab or zoom). A dialog owns the keyboard. **Toasts** are floating cards at the
  bottom right, above the help line, which stays (`style.toastCard`; user
  decision): a rounded border, icon and title in the kind's colour (✓ Done,
  ! Warning, × Error, • Note), the message wrapped below, nothing filled,
  4s; a dialog sits over one. Every message the screen says is one.
- **The home screen's mechanics** (`src/tui/program.ts`, `renderer.ts`,
  `input.ts`, `jobs.ts`): ONE program for the whole session, an
  update loop over messages and commands (messages.ts: messages, commands,
  update). `send(msg)` updates, starts the commands, then redraws once per
  burst (`setTimeout(0)`). The renderer draws on the alternate screen
  (quitting gives the normal screen back exactly as it was), writes only
  the rows that changed, inside synchronized output (mode 2026), and puts
  the cursor where the run panel's command has it while the terminal has
  the keys. input.ts decodes the tty's bytes itself: control bytes as
  ctrl+key, ESC+key as alt+key, a lone ESC in its read as esc, CSI/SS3 keys
  with xterm modifiers, kitty CSI u, bracketed paste as one `PasteMsg`, SGR
  mouse; the screen turns on mouse cell motion (1002+1006), bracketed paste
  and the window title. Keys come from `/dev/tty` when stdin isn't one.
  Background work (refresh, remotes, plans, the browser) is a promise run
  by `jobs`: the first refresh starts before the program, and a finished
  job queues its message and wakes the program, so every state write
  happens in update. Reducers queue their commands (`m.cmds`: toast
  expiries, the terminal's messages) for the program to run. Busy is shown
  by a MiniDot braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` in Primary,
  `style.busyGlyph`/`busyLabel`), every row on the same frame (user
  decision: calm, and never mistaken for a status glyph such as the
  attention `●`). It runs off ONE clock
  (`style.Busy`) that ticks only while something is busy and stops on
  exit, so q never hangs. `LOADOUT_SCREEN_DUMP=<file>` (undocumented for
  users) writes each changed frame as plain text, atomically: the PTY
  tests' window.
- **Each subject settles on its own** (user decision): programs, scripts
  and configs are checked side by side by ONE refresh
  (`StatusEngine.refreshParts` → `AppContext.refreshAndWriteStateParts`),
  which hands each part to the screen the moment ITS checks finish
  (`engine.Part`; the refresh job `post`s a `partMsg` per part before its
  own message). `HomeState.checking` is the subjects still waiting: a
  sidebar row's spinner stops, with its fresh counts, when its own part
  lands (`partLanded` merges it into `partial`), never when the slowest
  subject does. The state file is still written once, with the whole
  observation; a part that failed leaves its row to the refresh's own
  error. `70-home-screen` holds a script's check for seconds and checks
  that the programs row has already settled.
- **The lists open on the LAST OBSERVED verdicts**: the screen first
  reads `<state>/<machine>.json`; the refresh that follows (published like
  `status`) re-asks and updates the rows in place, and the remotes are
  asked at once, each landing as it finishes. The remote subject uses the
  CACHED self-version check (GitHub's API is rate-limited and the screen
  opens constantly); `outdated` asks fresh. The home model owns no domain
  logic: StatusEngine/DiffEngine/`AppContext.outdatedReport`/`explain` do
  the work, and every action is a real subcommand. Rows measure their
  columns once a frame from ALL the list's rows, not just the visible ones. A script's verdict is always its check.
