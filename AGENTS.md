# AGENTS.md — loadout

Source of truth for coding agents working on this repo. The README is the
*user-facing* tour; this file is the *contributor-facing* knowledge base.
Keep both updated when behavior changes — and keep them consistent.

Add an entry here only when it stops a future agent from reverting a
deliberate-looking decision (Design contract) or re-paying for a
non-obvious, costly-to-discover failure (Toolchain facts) — most changes
belong in the commit message alone, not here. State what is true now, in
one clause folded into the relevant existing bullet where possible; never
add a "used to X, now Y" history — git log already holds that, and a
change that repeats itself in both places is a change repeated for no
reader's benefit.

## What this is

`loadout` is a single Kotlin/Native binary (no JVM at runtime) that sets up
unix-like machines from a shared git "config repo" and tracks installed program
versions across machines. Users declare installers (mechanism patterns: probe/install/check),
programs (install variants over those installers) and scripts (idempotent
setup steps) in TOML; each machine
maps every program to one install variant; state files record what each machine
actually has; `diff` compares the fleet. CLI + ONE Mosaic screen: the home
screen (bare `loadout`). The old dashboard TUI was deleted on 2026-08-21
because it RE-DISPLAYED what commands already did; the `maintain` picker
was deleted on 2026-09-14 because the home screen's scripts row became the
same picker with the same pane. The home screen observes, then dispatches
to commands (or streams non-interactive ones in its pane), and owns no
domain logic.

Renamed from `post-installer` on 2026-08-17 — the working directory and some
external references may still use the old name. Never reintroduce it in code.

## Build, run, test

```sh
./gradlew :app:linkDebugExecutableLinuxX64          # dev binary
./app/build/bin/linuxX64/debugExecutable/loadout.kexe --help
./gradlew :app:linkReleaseExecutableLinuxX64        # optimized (slow)

./gradlew :core:linuxX64Test                        # core unit tests
./gradlew :app:linuxX64Test                         # home-model unit tests
./integration/run-tests.sh [path-to-binary] [pattern] # black-box suite (default: debug binary)
./integration/run-tests.sh home                     # only t/*home*.sh — 30s instead of 2min
```

All three suites must pass before claiming work done. The integration script
builds nothing — link the binary first.

**Testing the TUI without a human**: Mosaic needs a real TTY; use `script` to
fake one and pipe keys with sleeps (give the screen ~4s to bind the tty and
finish its first refresh before the first key — a key on a busy row is
refused, and a key before raw mode is lost):

```sh
# Linux: the command is one string, the log is the last argument.
(sleep 4; printf 'j'; sleep 1; printf 'l'; sleep 1; printf 'q') | script -qec "$BIN --repo <repo>" /dev/null
# macOS (BSD script): the log comes first, the command is plain argv.
(sleep 4; printf 'j'; sleep 1; printf 'l'; sleep 1; printf 'q') | script -q /dev/null "$BIN" --repo <repo>
```

A run that doesn't exit usually means a coroutine kept `runMosaic` alive (see
Gotchas). Rendering changes still need a human check — ask the user to run it.

Manual testing target: the user's live config repo at `~/.config/loadouts`
(machine name `macbook-fedora-kde`, Fedora, dnf + linuxbrew present). Fine to
run `status`/`diff`/`--dry-run` against it; don't install/remove packages or
push git without asking.

## Architecture

Two Gradle modules; all targets native (linuxX64, linuxArm64, macosX64,
macosArm64 — macosX64 is deprecated upstream but kept). Compose plugin only on
`:app` so `:core` stays Compose-free.

```
core/  loadout.core
  LoadoutException — supertype of every refusal (contract 9)
  model/       Manifest, MachineState, System (@Serializable schemas; Manifest
               owns resolveInstall/checkFor — variant × installer resolution)
  manifest/    ManifestLoader — loadRepo() merges manifest.toml + manifest.d (recursive, subfolders cosmetic)
               + machines/*.toml + InstallerLibrary under the repo's own
               installers, validates everything; parse() is single-doc, TEST-ONLY
               InstallerLibrary — the built-in installers, as TOML text
  state/       StateStore — state/<machine>.json via Okio; pretty JSON, stable order
  exec/        ProcessRunner interface + KommandProcessRunner (kommand); ALL process
               use goes through the interface (tests use FakeProcessRunner).
               capture (blocking), inherit (sudo/progress), stream (live
               line-by-line + kill handle; default impl replays capture)
  detect/      Detection — os/distro/hostname + isBinaryAvailable probe (`command -v`)
  engine/      VersionChecker (concurrent checkAll), UpdateChecker (outdated
               oracles; exit code deliberately ignored), InstallEngine (plan/
               execute), UpgradeEngine (a planner only: which mechanisms
               this machine can upgrade, one step per command, refusals —
               the CLI and the pane each run the steps their own way and
               verify via refreshAndWriteState), ScriptRunner, StatusEngine (observes
               programs AND scripts; all checks concurrent — read-only)
  diff/        DiffEngine — pure function: manifest × states -> DiffReport
  git/         GitClient — shells out to `git`, always cwd = repo root
  platform/    expect/actual posix: hostname, isatty, uname, nowIso, envVar,
               blockingDispatcher (= Dispatchers.IO)
app/   loadout
  Main.kt      Clikt dispatch (bare invocation prints help). Catches
               LoadoutException (+ okio.IOException) -> "error: ..." + exit 1
  cli/         AppContext (shared services, suspend refreshAndWriteState) +
               one file per subcommand (status/explain/installers/setup-new-machine/install/upgrade/self-upgrade/outdated/run/diff/sync/init).
               SelfVersion = the one remote-self-check carve-out: status
               footer (6h cache read/written with Okio, fail-soft) +
               outdated self-row (fresh);
               `self-upgrade` shells to INSTALL_COMMAND and needs no repo, so
               it works under a min-tool-version refusal (which points at it)
  tui/         HomeModel (ALL state + logic, no rendering, unit-tested)
               + HomeApp.kt (the composables) + TuiApp.kt (palette, frame loop)
```

## Design contract — do not violate

These came from explicit user decisions; don't "improve" them away:

1. **No package-manager auto-detection. No `--pm` flag or env override.** The
   only source of install-variant choice is `machines/<name>.toml` (`[pm]`
   table mapping EVERY program to a key of its install table). Inline
   `[machines.*]` in manifest.toml or fragments is a validation error.
2. **Mapping = membership + strict fail-fast resolution.** A program a machine
   doesn't map is not part of that machine's loadout: converge skips it,
   status doesn't observe it, diff shows "-". Machine files may sit in
   subfolders (cosmetic; name = file name, unique repo-wide) and may
   `extends` a `base = true` config (pm merged per key child-wins; scripts
   union, same-named child entry replaces): bases are flattened at load,
   validated, then dropped — they are never machines. Machines can't extend
   machines; no subtraction — a base entry is a promise every child keeps.
   `setup-new-machine` throws
   ResolutionException before executing anything if: machine config file
   missing, an EXPLICITLY requested program unmapped, a mapped program's
   dependency unmapped, or a mapped known PM's binary absent (probed). No
   automatic `script` fallback — everything explicit.
3. **Intent vs observation never mix.** `manifest.toml` + `manifest.d/` +
   `machines/` are authored; `state/` is generated and disposable. Nothing
   hand-edited ever goes in `state/`; the tool never writes authored files
   (except `init` scaffolding and `installers --eject`, which writes exactly
   `manifest.d/00_installers.toml` and refuses to clobber it without
   `--force`).
4. **Scripts: exactly one of `file` (repo path) or `run` (inline).** `file`
   existence is validated at manifest load (loadRepo, not parse). Variant
   `command` values AND all check commands (variant `check`, program
   `[version]`, script `check`) may use the `file:` prefix for repo scripts —
   also validated; expansion is centralized in model.expandFilePrefix, applied
   at the execution sites (InstallEngine plan, VersionChecker.check,
   ScriptRunner.withArgs). Tokens after the first space are passed as
   arguments (`file:path args…` → `sh 'path' args…`), so file: paths cannot
   contain spaces.
5. **Every manifest command runs via `sh -c` with the repo root as cwd** —
   installs, script runs, version checks, `check`s. Deterministic regardless of
   invocation directory.
6. **Execution order**: all programs before all scripts; programs topologically
   by `depends-on` (declaration order as tiebreaker: root manifest, then
   fragments sorted by filename); scripts by script-to-script `after` edges.
   Sequential execution, never parallel (only read-only checks run concurrently).
   `after` orders but never pulls anything in; `depends-on` pulls in transitively.
7. **Script status is observation**: every refresh re-runs each `check` —
   exit 0 => `done`, else `pending` — even right after a run (the check is
   the truth, not `lastRun`/`exitCode`, which are history from
   tool-executed runs only). Check-less scripts carry only run history.
   Install success = exit 0 AND a re-run version check no longer says
   missing. **A check that couldn't run is not "missing"**: a check that
   goes THROUGH a tool (`VersionCheck.probe`, from the installer's/
   variant's probe) that dies with the shell's own 127/126 is `unknown`
   with `ProgramState.reason` set to the shell's line; a check with no
   probe IS the program, so its 127 means missing (a tool off PATH would
   otherwise report every one of its programs missing — a confident lie).
   The refresh groups unknown rows by tool and asks about each ONCE
   (`command -v`): `StatusEngine.lastToolsDown` — `status` reports it once
   after the table, the home screen shows it on its message line, and
   affected programs are never offered for install.
   Ceiling: a pipeline check (`tool | grep …`) exits with the LAST
   command's code and hides the tool's absence; write
   `x=$(tool …) && printf '%s\n' "$x" | grep …` so the tool's failure
   propagates.
8. **State files**: written only for this machine; `updatedAt` bumps only when
   content actually changed (keeps git history clean; makes `sync` a no-op when
   idle). Unknown JSON keys ignored on read.
9. **Errors are clean one-liners** (`error: ...`), never stack traces. Every
   refusal of ours extends `loadout.core.LoadoutException`, which Main.kt
   catches once (plus `okio.IOException`, which isn't ours) — a new failure
   type inherits the clean reporting instead of needing a new catch block. A
   test asserts the hierarchy.
10. **Product code loads manifests via `ManifestLoader.loadRepo`** (merging +
    file validation). `parse()` exists for tests only — it tolerates inline
    `[machines.*]` and can't check `file:` paths, but both paths share
    `withBuiltinInstallers`, so install resolution is identical (a test
    asserts it). Anything else that must hold for both goes in that helper,
    not in one path.
11. **No templates.** `[templates.<name>]` (reusable program patterns with
    `{name}` substitution) existed through 0.8.0 and was REMOVED in 0.9.0 —
    the only real config repo never used it, and the recipe below prefers
    explicit repetition over abstraction. `template = "..."` and
    `[templates.*]` are now unknown keys (ktoml ignores them, so an old
    manifest silently loses those programs — the removal note in contract 14
    is what tells a repo to bump its floor). Don't reintroduce it; a program
    that repeats another is fine.
12. **Scripts are opt-in per machine**: a machine's top-level `scripts` list
    (in machines/<name>.toml, ABOVE any table header) has entries "name" or
    "name args..." parsed by MachineConfig.scriptArgs(); only opted-in
    scripts converge and are observed, `run` errors otherwise, and args become
    positional params for the file script AND its check (via `set --` — see
    ScriptRunner.withArgs). Args on inline `run` scripts are a validation
    error. No implicit script application; no os/bootc auto-detection to
    decide membership. A script's optional `modes` (["setup"], ["maintain"],
    default both) scopes EXECUTION surfaces only — setup-new-machine converges
    setup-mode scripts, the home screen's scripts picker lists maintain-mode
    ones; status observes all
    opted-in scripts regardless and `run` ignores modes (explicit escape
    hatch). Empty or unknown modes are load errors.
13. **Installers own mechanics; variants refine them.** `[installers.<name>]`
    (probe / install / check / outdated / regex, `{pkg}` substituted) define
    a mechanism once, repo-unique, fragment-definable. Core ships a library
    of them (`core/manifest/InstallerLibrary.kt`: dnf, brew, brew-cask,
    flatpak with oracles; apt, pacman install/check only) as TOML text,
    merged UNDER the repo's own in `loadRepo` — a repo definition of the
    same name replaces the built-in outright; `Manifest.builtinInstallers`
    records which survived so `explain`/`installers` can label
    `(built-in)` vs `(repo)`. This is knowledge, never detection — nothing
    probes the machine to pick an installer; `installers --eject` writes
    the library into the repo to let a user own it, and a repo that relies
    on built-ins should declare `[meta] min-tool-version`.
    A program's install entry is a variant table `{installer, pkg, command,
    check, regex, probe}`, every field optional and defaulting from its
    installer; `pkg` defaults to the program name. An installer may declare
    `params = [...]`: named values a variant supplies via a nested
    `[...install.<key>.with]` table and substitutes like `{pkg}`. All
    declared, never inferred — a missing param, an undeclared `with` key,
    or a `with` on a variant with no installer are load errors, so an
    unsubstituted `{placeholder}` can never reach a shell. This is what
    lets one `dnf-repo`/`dnf-copr` mechanism replace a pile of
    near-identical install scripts (recipe 5); `via = [...]` is shorthand
    for one all-defaults variant per named installer.
    Resolution (`Manifest.resolveInstall`/`checkFor`, used by every
    engine/UI): command → installer install pattern (else load error);
    check → installer check (else program `[version]`); probe → installer
    probe (else none); outdated → variant override, else installer
    `outdated-all` (one batch command per installer, per-program regex
    extracts — much faster than per-pkg; old binaries ignore it and fall
    back to per-pkg automatically), else installer per-pkg pattern, else no
    oracle (`outdated` skips and reports it). Exit codes are always ignored
    for these oracles.
    Repos may also declare `[outdated.<name>]` custom sources (`<item>
    <current> <candidate> [note…]` lines; a URL in the note becomes the
    row's link, opened with `K`; `file:` allowed, repo-unique). UNLIKE
    installer oracles, a source's exit code is NOT ignored — a non-zero
    exit surfaces as `outdated source [name] failed: ...` so a crashing
    oracle can't silently hide updates.
    Installers may declare `upgrade`: the ONE command that moves everything
    the mechanism manages — no `{pkgs}` placeholder, since loadout never
    upgrades single packages (contract 15). Never write cross-variant `||`
    chains in checks.
14. **Versioning contract.** Since 0.2.0 the manifest format evolves
    ADDITIVELY only (new optional fields; never repurpose existing ones) —
    0.2.0 itself broke 0.1 repos (string install values became variant
    tables), and 0.9.0 removed `[templates.*]` (contract 11), the second and
    so far last deliberate break. A removal is a decision to make once,
    loudly, in the release notes — never a silent one, because ktoml drops
    unknown keys instead of failing. `[meta] min-tool-version`
    is enforced at loadRepo — repos requiring newer features declare their
    floor and old binaries refuse with an "upgrade loadout" error. State files
    with `schemaVersion > StateStore.SCHEMA_VERSION` are skipped with a
    warning (surfaced via `StateStore.lastWarnings` — new read paths must
    echo/log them). Bump SCHEMA_VERSION only with a real schema break, and
    handle older schemas via defaults.
15. **Converge installs; `upgrade` upgrades — a whole mechanism at a time.**
    `setup-new-machine`/`install` add what's MISSING and never touch a
    version already there. Moving versions is its own verb, `loadout
    upgrade <installers…>|--all` (`UpgradeEngine`), and it never upgrades
    single packages — naming a program is an error pointing at its
    mechanism. Mechanisms sharing a command (dnf, dnf-repo, dnf-copr all
    run `dnf upgrade -y`) are ONE step, deduped by command; the UI groups
    by the TOOL they drive (their probe), so ticking a brew row ticks
    casks too. `plan` refuses an installer this machine's mapping doesn't
    use, so a repo that maps nothing to brew can't accidentally sweep it.
    Custom `[outdated.<name>]` sources upgrade the other way: a declared
    `upgrade = "... {item}"` runs once per row picked, since each item (a
    pin, a clone) is independent and one failure shouldn't take the rest; a
    source without that command stays read-only (`[–]`). Afterwards EVERY
    mapped program is re-checked, since the transaction can move packages
    loadout doesn't declare. The binary's own update is `self-upgrade` —
    needs no repo, so it survives a version-floor refusal.

## Toolchain facts (hard-won — don't rediscover)

- **Kotlin must be ≥ 2.4.0**: clikt 5.1.0 klibs use ABI 2.3.0. Mosaic 0.18.0
  works on 2.4.0. Repos: mavenCentral + **google()** (Compose androidx deps).
- **clikt duplicate-symbol linker error**: clikt + clikt-mordant both define
  `Context.selfAndAncestors`; fixed via `disableNativeCache(...)` applied to
  **all** binaries (`target.binaries.all`) in app/build.gradle.kts — test
  binaries need it too. The old `kotlin.native.cacheKind` properties are dead.
- **Kotlin nested block comments**: `/*` inside a KDoc (e.g. a glob like
  `manifest.d/*.toml`) opens a *nested* comment and eats the file. Word globs
  differently in comments.
- **Dispatchers.IO on native** needs `import kotlinx.coroutines.IO`
  (extension); fully-qualified use resolves an internal symbol. Wrapped as
  `platform.blockingDispatcher` — use that.
- **Clikt 5**: `currentContext.obj` needs `import com.github.ajalt.clikt.core.obj`;
  subcommands read it via `requireObject<AppContext>()`.
- **Mosaic 0.18**: entry point is our `runTui {}` (see below); keys via
  `Modifier.onKeyEvent { it == KeyEvent("q") ... }`; styles `TextStyle.Bold/
  Dim/Invert/Italic` combined with `+`, neutral is `TextStyle.Empty` (no
  `.None`); colors `com.jakewharton.mosaic.ui.Color`. App stays alive while a
  `LaunchedEffect` runs — exit = remove the `awaitCancellation()` effect.
- **TUI effect rule**: EVERY `LaunchedEffect` must stop when the model says
  exit — `if (!s.exit) { LaunchedEffect(...) }`. An effect still looping keeps
  `runMosaic` alive forever; the home screen's spinner effect hung the whole
  integration suite this way (q pressed mid-refresh, spinner still ticking).
- **TUI coroutine rule**: async work must NOT run on the composition's scope
  (`rememberCoroutineScope`) — a lingering job there keeps `runMosaic` from
  ever finishing (caused a q-after-refresh hang). HomeModel owns its own
  `CoroutineScope(SupervisorJob() + blockingDispatcher)`; UI calls
  `model.handleKey(key)`. Keep it that way.
- **TUI size**: Mosaic 0.18's `LocalTerminalState.size` does NOT report the
  real TTY size — TuiApp polls `platform.terminalRows()`/`terminalColumns()`
  (TIOCGWINSZ) every 300ms instead, with 24x80 fallback; the polling effect
  is guarded by `!exit` so quit still works. Keep windowing math in the
  model file, not composables.
- **Theme is ONE source of truth**: `app/.../theme/Theme.kt` (package
  `loadout.theme`) holds the Tokyo Night / Day `ThemePalette` pairs and
  `detectDarkTerminal(bgLuma, COLORFGBG)`; the TUI maps it to Mosaic colors
  (TuiApp `toPalette()`), the CLI emits it as 24-bit ANSI (`Style` — Mordant
  may re-encode the SGR codes on output; that's normal). `HomeState.dark`
  toggled with `t`; bgLuma is a real OSC 11 query
  (`platform.terminalBackgroundLuma()`, raw-mode /dev/tty round-trip,
  ~200ms fail-soft — see the poll() gotcha below) that MUST run before
  runMosaic owns the terminal — CLI
  `Style` runs it lazily at first styled output, TTY-gated so piped output
  stays plain AND never queries the terminal. Color = signal: ok/warn/error/dim
  statuses, accent = headers/actions (`Style.header` = bold accent),
  machine = machine identity — never reintroduce raw ANSI codes or
  Color.* constants outside Theme.kt/cli/Style.kt. Style AFTER padding.
  The CLI's presentation is four small files, not one: `Style.kt` (palette
  -> ANSI + the Clikt theme), `Table.kt` (TableRow/echoRows), `Spinner.kt`,
  `Help.kt` (commandHelp). Put new presentation in the one it belongs to.
  `--help` is rendered by Clikt/Mordant, not by `Style`, so RootCommand
  installs `Terminal(theme = Style.cliktTheme())` — the same detected palette
  mapped onto Mordant's style keys (warning = section titles, info = option/
  argument/command names, muted = metavars/tags, danger = errors) — the
  yellow-title/blue-name look Mordant ships, in whichever palette was
  detected. Without it help keeps Mordant's dark-only defaults and washes
  out on light terminals.
- **NEVER time a /dev/tty read with `poll()`** — on Darwin poll() answers
  /dev/tty with POLLNVAL (revents 0x20), never POLLIN, so a
  `if (poll(...) <= 0) break` guard is waved through and the read that
  follows blocks FOREVER whenever no reply comes. That shipped in
  `terminalBackgroundLuma()` and hung EVERY command (Style's palette is
  initialized while RootCommand builds its Clikt context, so even `status`
  never printed a byte) in any terminal that swallows the OSC 11 query —
  a tmux popup running its own nested tmux client (`tmux new -A -s
  floating`, i.e. the "floating pane" people bind) being the one actually
  hit; a plain kitty pane answers, which is why it looked fine everywhere
  else. The deadline must come from the terminal: cfmakeraw leaves VMIN=1
  ("block for a byte"), so set `VMIN=0` + `VTIME` (deciseconds) and read()
  itself returns 0 on silence. Any future terminal query does the same.
  Reproduce a no-reply terminal with a DETACHED tmux session (`tmux
  new-session -d`, nobody to answer) and `sample <pid>` to see the stack —
  but use a DEBUG binary, the released one is stripped. `script`'s pty is
  a no-reply terminal too (no emulator behind it), which is what makes
  `t/71-terminal.sh` the regression test: the query bytes show up
  unanswered in the capture and the command must still print its table.
- **A terminal that won't answer gets TOLD: `LOADOUT_THEME=dark|light`.**
  Silence from the query means the dark default, so the popup above renders
  a light terminal in dark colours. That is not loadout's to detect around:
  tmux passthrough (`ESC P tmux ;` …, escapes doubled) was tried and does
  not reach a popup's nested client either, so it was reverted rather than
  kept as speculative code. `theme/forcedDark` is the explicit answer —
  consulted BEFORE `terminalBackgroundLuma()`, so a told palette costs no
  query — and the popup binding is where the platform knowledge belongs
  (`popup -E 'LOADOUT_THEME=$(defaults read -g AppleInterfaceStyle
  >/dev/null 2>&1 && echo dark || echo light) tmux new -A -s floating'`).
  A value that is neither is a refusal, not a shrug, and it is checked in
  **Main.kt**, not at the use site: the palette is chosen inside `object
  Style`'s initializer, and Kotlin/Native wraps a throw from one of those
  in `FileFailedToInitializeException` — not a `LoadoutException`, so it
  escapes Main's catch as a stack trace (contract 9). Anything else that
  must refuse from an object initializer validates in Main the same way.
- **Unsettled rows are boxed**: `cli/Table.kt`'s `echoRows(List<TableRow>)` is
  the one renderer for `diff` and `status` tables — a row with a non-null
  `severity` (false = amber, true = red) is wrapped in a rounded box,
  consecutive ones share one box (severe if any row in it is), and a row's
  extra lines (a failing script's check output) ride inside it. Plain rows
  get the same 2-column gutter the border occupies, so columns line up
  either way; box width is measured with ANSI codes stripped. Boxed today:
  diff's drift (amber) / incomplete (red), status' missing programs (red)
  and pending (amber) / failed (red) scripts, and outdated's failed
  `[outdated.*]` sources (red, message clamped to the terminal width — a box
  that wraps is worse than a plain line). NOT outdated's update rows: every
  row there is an update, and a highlight with nothing to contrast against
  is decoration.
- **One converge pipeline**: `cli/Converge.kt` owns the program half of
  converging — `planPrograms` (re-check + `engine.plan`), `echoPlan`
  (plan table, `extraRows` for setup's scripts), `confirmOrAbort`,
  `installPrograms`. `install` and `setup-new-machine` are thin shells over
  it; scripts are setup's alone. Add a converge behavior here, not in one
  command (that's how `--all` nearly became install-only).
- **Slow steps wear the spinner**: any step that can look like a hang —
  version checks, state refresh/write, git pull/push — goes through
  `cli/Spinner.kt`'s `CliktCommand.spinning(message) { ... }`, never a bare
  `echo("Doing x...")` + `runBlocking`. It runs the work on
  `blockingDispatcher` (a blocking call on runBlocking's own thread would
  freeze the spinner) and draws nothing when stdout isn't a TTY.
- **Home screen** (bare `loadout` on a TTY; a pipe still gets help):
  `tui/HomeModel.kt` (all state + logic, unit-tested) + `HomeApp.kt`
  (composables). Four subject rows — programs, scripts, remote, fleet —
  each carry their verdict and the ONE verb that resolves it. ↑↓/jk move,
  l/h (or ←/→) open/close a detail, pgup/pgdn page, enter ACTS (never
  opens/closes — inside the remote table it's the upgrade key, and never
  fires on a row still busy). Machine-wide verbs are their own keys, not
  rows, since they belong to no single subject: r re-check, S sync,
  U self-upgrade, C setup-new-machine, t theme, q quit.
- **One cursor for the whole screen**: `homeLines(state)` flattens the
  body into subject rows plus every OPEN detail's lines, in draw order;
  `HomeState.cursor` walks it one stop at a time (gaps/headers skipped),
  so a table can never capture the arrows — `k` off its top row lands on
  the owning subject row and keeps going. `HomeState.open` is a SET, so
  several details stay open at once; only an explicit h/esc on the one
  under the cursor closes it. `[`/`]` jump between headings instead of
  `H`/`L` (which vim reads as screen top/bottom — a missed shift on `H`
  would close the very list you're in). A closed table keeps your place
  (`HomeState.lastRow`), resolved against the CURRENT rows on reopen since
  a refresh or upgrade can remove them; `snapCursor` re-resolves the
  cursor the same way after every reshape (nearest stop at or above), so
  a picker emptied by a refresh doesn't leave the highlight on nothing.
- **esc CLOSES, never quits**: only `q` leaves the screen. With nothing
  open under the cursor the message line says which key does what ("esc
  closes the list you're in" / "nothing to close — q quits").
- **Remote table** is grouped by the TOOL that will act (`remoteLines`,
  built from `OutdatedReport.tools`): a heading per probe (brew and
  brew-cask count as one tool) with its declared programs nested under it
  and an amber "N more not in your loadout" line for the sweep's honest
  cost, then each custom source as its own heading with its items. space
  selects a tool's whole mechanism (ticking any row under it lights up
  the tool) or a source's one item, a selects all, u clears, enter
  upgrades the ticked ones in the floating pane. Groups FOLD (h/l;
  `RemoteLine.foldable` makes an empty heading — a clean tool — unfoldable,
  since folding can't be derived at render time once its rows are gone).
  **A row is keyed by where it came from, never by name**
  (`selectionKey`/`mechanismOf`) — keying by name instead let a source
  item collide with a same-named mapped program (a plugin and a package
  sharing one name) and upgrade through the wrong mechanism, silently
  never actually moving the source. `remoteSummary` names tools with
  work first, then one count of everything else, then the biggest named
  group, then "+N more" — an idle tool is never named, and the two kinds
  of count are never merged into one total (a sweep and N independent
  pins are not the same work). `K` opens a row's link when its source
  printed one; batch oracles read STDOUT ONLY, since stderr can carry
  warnings mistaken for package names. `l` only ever opens — it never
  dispatches, so the vim keys can't start an install by accident.
- **Scripts row** is the picker the old `maintain` command was: lists
  maintain-mode scripts in run order with their last verdict, anything
  not done pre-ticked (`preselect`, re-applied after every refresh so
  picks follow verdicts), runs the ticks in the pane forced, then
  re-verifies via the same `refreshAndWriteState` the r key uses — a
  script that exited 0 but still fails its check is "not all done," not
  a crash. **Programs row** is the same picker over what the last
  observation found missing, planned with `InstallEngine.plan`
  (dependencies first, the same refusals `install` raises) and installed
  in the pane.
- Every row's answer is in hand already: `l` opens it in place, and enter
  says so instead of leaving the screen when there's nothing to open
  (remotes unreachable, fleet in sync). NO ROW EVER LEAVES THE SCREEN;
  only S/U/C do. It opens on the stored state, then runs a real `status`
  refresh (published like `status` does) and asks the remotes, each
  landing independently as it finishes. The remote row uses the CACHED
  self-version check (GitHub's API is rate-limited and this screen opens
  constantly); `outdated` asks fresh. HomeModel owns no domain logic —
  StatusEngine/DiffEngine/`cli/OutdatedQuery.kt`'s `outdatedReport()` do
  the work, and every action dispatches to a real subcommand through
  `cli/Actions.kt`'s `dispatch()`. Rendering windows `homeLines` and
  measures each table's column widths once a frame from ALL of its rows,
  not just the ones on screen.
- **Floating pane**: rendered as a real overlay (`Box(fillMaxSize) {
  body; RunPane() }`) so the screen stays visible underneath. One pane,
  three planners — `startUpgrade`, `startScripts`, `startInstalls` — each
  hand `ask()` a list of steps and `confirmRun()` streams them. A step's
  own prompt would be invisible behind the pane, so **the pane asks for
  sudo's password itself**: if a step (or a script's check) needs sudo
  and `sudo -n true` fails, a masked field appears and the line goes to
  `sudo -S -p '' -v` on STDIN only — never argv, env, or the log; a
  keepalive holds the stamp for the run. A `file:` script that reads
  stdin on its own is still invisible to this — nothing catches that but
  the author. The pane opens as a QUESTION (exact commands; enter runs,
  esc changes nothing), then becomes a live log (↑↓/pgup scroll, esc
  cancels and kills the child, enter closes a finished run without
  leaving the screen).
- **Own frame loop, not `runMosaicBlocking`**: the screen starts through
  `tui/TuiApp.kt`'s `runTui {}`, which binds the tty (`Tty.tryBind()` +
  `asTerminalIn`) and drives Mosaic's public `Mosaic(...)` composition
  itself, so every frame is wrapped in synchronized output (`?2026h`/`l`)
  and the cursor is hidden for the app's lifetime. Stock Mosaic decides
  both from a capability handshake it SKIPS whenever the primary DA reply
  says VT100 — which is what tmux answers — so under tmux it drew each
  frame in the open (clear line, rewrite, ×N) with a visible cursor: the
  pane text flickered on every spinner tick. Rendering itself mirrors
  Mosaic's `AnsiRendering` (cursor up, clear-and-write each row, clear
  below on shrink); Mosaic's own `runMosaic` is not used anywhere.
  (Needs mosaic-terminal / mosaic-tty / mosaic-tty-terminal as compile
  deps — they're runtime-only transitives of mosaic-runtime.)
- **One Mosaic app per process**: `Tty.tryBind()` (inside `runTui`) binds the tty once and
  never releases it — a second call anywhere in the same process dies with
  `IllegalStateException: Tty already bound`. So the home screen cannot
  reopen after an action: it exits INTO its action (install --all /
  outdated / diff / sync / setup / self-upgrade) and the process ends. Any
  "return to the home screen" loop needs re-exec, not a second runMosaic.
- **The picker opens on the LAST OBSERVED verdicts** — `load()` reads
  `state/<machine>.json`, and the refresh that follows re-asks and updates
  the rows in place; a script's verdict is always its check, re-run after
  the pane's run finishes. Live output comes from `ProcessRunner.stream`,
  which prepends `exec 2>&1` (merges stderr without a subshell so `kill()`
  reaches the real process) — kill hits the direct child only, so a
  grandchild holding the pipe open can delay the reader. On esc-cancel the
  run is marked cancelled immediately and a late stream return is guarded
  off — don't let it mutate state after the fact.
- ktoml quirk insurance: manifest schema sticks to plain nested tables (no
  inline tables / dotted keys). Fallback parser if ever needed: tomlkt.
- `.toml.sample` files in `machines/` and `manifest.d/` are deliberately
  ignored by the loader (only `.toml` matches).

## Testing conventions

- Unit tests live in commonTest, run on the host native target. No real
  processes or filesystem: `FakeProcessRunner` (scripted stdout/exit codes;
  unregistered command = exit 127) and Okio `FakeFileSystem`.
- `EXAMPLE_MANIFEST` in core's ManifestLoaderTest is the shared fixture.
- Integration = `integration/run-tests.sh`: black-box, real binary. The
  runner sources `lib.sh` (ok/fail, fixtures, `has_pty`/`pty_run`) and then
  every `t/NN-*.sh` in name order, each in its OWN fresh directory — a
  file builds its fixtures (`basic_repo`, `scripts_repo`, `scaffold_repo`,
  or inline) and never depends on another file having run; the numbers
  only fix the order. `manual = "..."` custom install keys keep tests off
  the host's package managers. Add an `ok "..."` test for every
  user-visible behavior change, in the file whose subject it is (a new
  subject = a new file); run just that file with a name pattern while
  iterating. Never share state across files through `$WORK`.
- TUI: reducers (`handleKey`) and the pure row builders (`sectionsOf`,
  `scriptRowsOf`, `preselect`, `selectionKey`, `homeLines`, `snapCursor`)
  are unit-tested via `setStateForTest`; rendering is verified manually
  (ask the user) plus PTY smoke probes. `t/70-home-screen.sh`
  (`has_pty`-guarded, `script`-driven) and `t/71-terminal.sh` (the same
  trick for plain commands — TTY-gated colour, a terminal that never
  answers the background-colour query) run on BOTH platforms; `pty_run`
  branches on `uname` since BSD `script` takes the log then plain argv
  while Linux's takes `-qec "<command>"` with the log last. EVERY PTY
  test of the home screen calls `fake_release_cache` and passes
  `XDG_CACHE_HOME=$FAKE_CACHE`, even ones that don't read the remote row
  — the screen asks the remotes the moment it opens, and an unmocked
  self-version check can eat several seconds of a test's fixed sleeps and
  land a key on the wrong frame, hanging the whole suite.

## CI / release

`.github/workflows/ci.yml`: ubuntu (unit + integration + release link) and
macos (arm64 unit tests, both mac release links, integration against the
release binary). `release.yml` on `v*` tags: strip + tar.gz →
`loadout-<tag>-{linux-x64,macos-arm64,macos-x64}.tar.gz` attached to the
GitHub Release. linuxArm64 builds but is not released. `install.sh` (repo
root) is the curl|sh bootstrap over those releases — it resolves
latest via the GitHub API (pin: LOADOUT_VERSION) and installs to
~/.local/bin; keep its target names in sync with release.yml. It reads the
installed binary's version BEFORE overwriting it, so an upgrade (including
`loadout self-upgrade`, which shells out to this script) says "was vX" and skips
the first-install "Next steps" — those instructions are wrong for someone
who already has a config repo. Testable offline via
LOADOUT_DOWNLOAD_BASE=file://… against a local tarball; run-tests.sh covers
both paths on both platforms — it stages one stub tarball per release name
so `install.sh` resolves the host's own target, which is the part being
trusted (repeating that mapping in the test would misread a Rosetta shell,
where uname says x86_64 and macos-arm64 is still right). The repo may not be
pushed to GitHub yet — workflows are inert until then.

## Adding programs to a config repo — the recipe

Distilled from migrating the user's real repo (README "Recipe: adding a
program" is the user-facing long form). Match top-down, first fit wins:

1. Standard package → `via = [...]` listing ONLY installers where the claim
   is true (via is unverified; a false entry = a mappable lie). The named
   installer usually needs no declaration — it ships with loadout
   (`loadout installers`); declare one only to add a mechanism or replace a
   built-in.
2. Different package id → variant with `pkg` (flatpak app ids, renamed casks).
3. Special install command, same mechanism → variant with `command`, keyed
   by the installer so check/probe derive. Key by what it IS: a cask gets
   `brew-cask`, not `brew`.
4. Prerequisite step (tap/repo/remote) → its own program + `depends-on`,
   never `&&`-chained into another program's command.
5. Repo-script install that lands in a pm's database → variant keyed by that
   pm with `command = "file:..."`; check/probe derive; override `regex` for
   odd version formats. When several programs need the SAME shaped script
   (rpm repo + key + install, say), make it an installer with `params` and
   one `file:` pattern instead of one script per program — the variants then
   carry only their values in `with`.
6. Truth not in a package db (dnf groups, virtual provides) → override
   `check` (two-mode script or `--whatprovides`), keep the rest derived.
7. No pm at all → `script` key + program-level `[version]` fallback.
8. Must precede everything (pm config, e.g. dnf.conf) → make it a program in
   a first-sorting fragment (`manifest.d/00_…`) — programs precede scripts,
   and dependency-free programs install in declaration order.
9. Nothing to "have" (dotfiles, services) → `[scripts.*]` + check, opted in
   per machine.

Cross-cutting: no `||` chains in checks; versions are the mapped pm's truth
(rpm's version, not the binary's self-report — expected, not a bug); no
trailing pipes in checks; `file:` for every repo script (load-time existence
check); prefer repetition over abstraction in config repos (templates were dropped
for explicit per-program `via`, then removed from the format in 0.9.0 —
don't reintroduce). Verify loop:
`explain` → map in machines/<name>.toml → `setup-new-machine --dry-run` → `status`.

Where the check lives (the invariant): loadout never trusts "it ran once" —
everything converges against a re-askable check, declared where the truth
lives via the resolution chain (variant check → installer check → program
[version]). Program-install scripts are one-mode, install-only — pm-keyed
scripts get the pm-database check derived (recipe 5), pm-less ones fall back
to [version] (recipe 7); only when neither holds the truth (dnf groups —
recipe 6 — and every [scripts.*] step) does a hand-written check exist:
inline one-liner or the script's own two-mode `check` argument. A script
file never needs a check mode unless it IS the truth's only oracle.

## Working agreements with the user

- **Everything new works on Linux AND macOS, both of which the user runs.**
  Not just the Kotlin: the shell too, in this repo and in config repos. The
  mac ships BSD tools, so `\|` alternation is not available in a BRE (use
  `sed -nE` with real `|`), `cat -A` / `sed -i` without an argument /
  `timeout` / GNU `readlink -f` are absent or different, and `script` takes
  its arguments the other way round (see `pty_run`). A shell snippet that
  fails on BSD tends to fail SILENTLY — a `sed` that matches nothing
  returns empty, not an error: that is how every `[outdated.*]` row lost
  its GitHub compare page on the mac while Fedora showed it for months.
  Test on this machine, and reason about the other before claiming done.
- **Stop the Gradle daemon when you're done**: `./gradlew --stop` at the end
  of a task (not after every build — it's what keeps rebuilds fast). The
  user doesn't want the `java … GradleDaemon` process lingering.
- **Close your tmux test windows**: this session runs inside the user's own
  tmux, so a real-terminal check of the TUI is `tmux new-window -d -n ldtest`
  + `send-keys` + `capture-pane` — and `tmux kill-window -t ldtest` before
  the task ends, every time. Nothing of yours stays open.
- After completing any phase/feature, end with a **"Try it"** section: exact
  commands, binary path, expected output.
- Docs split (2026-08-24): **README.md** is a concise front door (concept,
  command table, quickstart, links); the GitHub **wiki** holds the guides
  (Home = concepts, Writing-Your-Manifest, A-Day-With-Loadout — local clone
  at ../loadout.wiki, a SEPARATE git repo — its own clone, commit and push).
  **A change to loadout is not done until the wiki has been re-read against
  it**: not "updated if I remember", checked — grep the pages for the screen
  text, keys and example output the change touches, because the guides show
  rendered screens and a stale one teaches the wrong thing (the remote row's
  example line survived two reworks of that very line). README and **this
  file** the same. The wiki links into josemiguelo/loadouts as the live
  example, so renames there may break wiki links.
- **Wiki voice**: friendly, direct, concise, for a USER who wants to get
  work done — not a contributor. Show an example wherever one fits; a
  screen or a `console` block teaches faster than a paragraph about it. Do
  NOT narrate the obvious parts of the UI: a user who sees a `▸` on a
  folded group does not need a sentence explaining that groups without
  rows have no `▸`, and reasons ("because the heading would promise rows
  that aren't there") belong in THIS file, never there. When a wiki
  sentence is only true because of how loadout is built, cut it.
- **Word every user-visible string for the final user.** Screen text, CLI
  output and the wiki say what to do or what happened, never why the
  implementation needs it: "a step needs your sudo password", not "sudo's
  cache is cold". Cache, stamp, mechanism, oracle, transaction are
  contributor words — they live here and in comments.
- The user prefers explicit over implicit in every design fork — no
  auto-detection, no fallbacks, no heuristics; errors over guesses. Propose
  designs before implementing when the user asks a question ("is this ok?"
  means assess first, don't jump to code).
