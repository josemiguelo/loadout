# CLI output: theme, terminal queries, tables, spinner

- **Theme is ONE source of truth**: `internal/theme/theme.go` holds the
  Tokyo Night / Day `ThemePalette` pair and `DetectDarkTerminal(bgLuma,
  COLORFGBG)`. The TUI maps it to Lip Gloss colours (`Rgb.Hex`), the CLI to
  24-bit ANSI (`cli/style.go`'s `Style`). The home screen has its own palette (tui/style: Charmtone "Pantera"
  dark, Crush's, and a light variant) picked by the same detection; `t`
  toggles it. The screen never paints the terminal's background (no
  `View.BackgroundColor`, no OSC 10/11 set, no background on plain cells):
  a transparent terminal stays transparent (user decision). Only
  highlights carry a fill (the selected row, buttons); the theme's
  `BgBase` is what those fills and the embedded terminal's colour answers
  are computed against. `70-home-screen` checks no OSC 11 is ever set.
  bgLuma is a real OSC 11 query (`platform.TerminalBackgroundLuma()`,
  raw-mode /dev/tty round-trip, ~200ms, fail-soft) that MUST run before the
  screen owns the terminal; CLI `Style` runs it once (`sync.Once`), in the
  root's PersistentPreRunE before any command runs, TTY-gated, so piped
  output stays plain and never queries, and the query never lands while a
  child process or the screen owns the terminal. Color is signal:
  ok/warn/error/dim statuses, accent = headers/actions (`Style.Header` =
  bold accent), machine = machine identity, idleBg/idleFg = unfocused
  buttons. No raw ANSI codes or colour constants outside theme.go,
  cli/style.go and the TUI's styles. Style AFTER padding. CLI presentation
  is four files: `style.go` (palette -> ANSI, help's roles), `table.go`
  (TableRow/echoRows), `spinner.go` (echo, spinning), `help.go`
  (commandHelp, renderHelp); put new presentation where it belongs.
  `--help` uses the detected palette (section titles = warn, option/
  argument/command names = accent, metavars/tags = dim, errors = error):
  fixed dark-only colours wash out on light terminals.
- **Never time a /dev/tty read with `poll()`**: on Darwin poll() answers
  /dev/tty with POLLNVAL, never POLLIN, so the read after a `poll() <= 0`
  guard blocks forever when no reply comes. Style queries before EVERY
  command, so this hangs every command in a terminal that swallows the
  OSC 11 query (a tmux popup running its own nested client, `tmux new -A
  -s floating`). The deadline must come from the terminal: raw mode leaves
  VMIN=1, so set `VMIN=0` + `VTIME` (deciseconds) and read() returns 0 on
  silence (platform.go). Any future terminal query does the same. To
  reproduce a no-reply terminal: a DETACHED tmux session (`tmux
  new-session -d`) plus a goroutine dump (`kill -QUIT <pid>`) of the hung
  binary. `script`'s pty is a no-reply terminal too, so
  `t/71-terminal.sh` is the regression test: the query bytes appear
  unanswered and the command must still print its table.
- **A terminal that won't answer is TOLD: `LOADOUT_THEME=dark|light`.**
  Silence means the dark default. tmux passthrough (`ESC P tmux ;` …) does
  not reach a popup's nested client either, so there's no workaround code.
  `theme.ForcedDark` is checked BEFORE `TerminalBackgroundLuma()` (a told
  palette costs no query); the popup binding is where the platform
  knowledge belongs (`popup -E 'LOADOUT_THEME=$(defaults read -g
  AppleInterfaceStyle >/dev/null 2>&1 && echo dark || echo light) tmux new
  -A -s floating'`). Any other value is a refusal, checked first in
  **cmd/loadout/main.go**, before anything styles output: a typo that
  silently kept detecting would look exactly like the bug it was set to
  fix.
- **Unsettled rows are boxed**: `cli/table.go`'s `echoRows([]TableRow)`
  renders the `diff` and `status` tables. A row with a severity (amber or
  red) gets a rounded box; consecutive ones share a box (severe if any row
  is); a row's extra lines (a failing check's output) ride inside it.
  Plain rows get the same 2-column gutter, so columns line up; box width
  is measured with ANSI stripped. Boxed: diff's drift (amber) / incomplete
  (red), status' missing programs (red) and pending (amber) / failed (red)
  scripts, outdated's failed custom `outdated` sources (red, message
  clamped to the terminal width: a wrapping box is worse than a plain
  line). Not outdated's update rows: every row there is an update, so a
  highlight would contrast with nothing.
- **One converge pipeline**: `cli/converge.go` owns the program half of
  converging: `planPrograms` (re-check + the install plan), `echoPlan`
  (plan table, `extraRows` for setup's scripts; `echoSections` for setup's
  later phase under its own heading, one column width), `confirmOrAbort`,
  `askForSudoUpfront` (once for both phases), `installPrograms` /
  `installProgramsAfter` (the later phase, skipping what the core one
  failed). `install` and
  `setup-new-machine` are thin shells over it; scripts are setup's alone.
  Add converge behavior here, not in one command.
- **Slow steps wear the spinner**: anything that can look like a hang
  (version checks, state refresh/write, git pull/push, compile) goes
  through `cli/spinner.go`'s `spinning(message, work)` / `spin`, never a
  bare `echo("Doing x...")`. A goroutine draws the frames while the work
  runs; nothing is drawn when stdout isn't a TTY. Every write goes through
  `echo`/`echoNoNewline` (one mutex), so a frame never lands inside a
  line, and the final erase (`\r` + `ESC[K`) is its own write: a shorter
  line printed next would keep the spinner line's tail.
