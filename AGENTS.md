# AGENTS.md — loadout

Knowledge base for coding agents. README is the user-facing tour; this file
is for contributors. Update both when behavior changes, and keep them
consistent.

Add an entry only when it stops a future agent from reverting a deliberate
decision (Design contract) or from rediscovering a costly failure
(Toolchain facts); everything else belongs in the commit message. State
what is true now, folded into the relevant bullet. Keep history only when
it explains a rule or guides future changes; git log holds the rest.

**Writing style** (comments, doc comments, this file, README, wiki):
succinct, direct, present tense, no important detail dropped. A past
incident is written as the rule it produced, not as a story.

## What this is

`loadout` is a single static Go binary that sets up unix-like machines from
a shared git "config repo" and tracks installed program versions across
machines. In HCL manifests, users declare installers (mechanisms:
probe/install/check), programs (install variants over those installers) and
scripts (idempotent setup steps); each machine says which variant of each
program it installs and which scripts it runs. `loadout compile` (the
binary itself, on the machine that edits the manifests) turns them into
`loadout.lock.json`, committed, which is all every other command reads.
State files record what each machine has; `diff` compares the fleet.

CLI plus ONE Bubble Tea screen, the home screen (bare `loadout`). It
observes, and runs every action it confirms as the matching subcommand in
a run panel inside the screen (an embedded terminal); it owns no domain
logic. No other TUI: a second picker for something a home-screen subject
already does is not wanted.

Formerly `post-installer`: the working directory and some external
references may still use that name. Never reintroduce it in code.

## Build, run, test

```sh
go build -o build/loadout ./cmd/loadout             # the binary
./build/loadout --help
go vet ./...
go test ./...                                       # every unit test
go test ./internal/hclconf/...                      # one package's
./integration/run-tests.sh [path-to-binary] [pattern] # black-box suite (default: build/loadout)
./integration/run-tests.sh home                     # only t/*home*.sh
```

All suites must pass before claiming work done. The integration script
builds nothing: build the binary first. The binary needs nothing beside it:
`compile` and `init` are its own, with no share directory and no
`LOADOUT_HOME`.

**Driving the TUI without a human**: the home screen needs a real TTY; fake
one with `script` and pipe keys in, and read what it draws from
`LOADOUT_SCREEN_DUMP=<file>` (the current frame as plain text, rewritten
after every render; Bubble Tea's renderer writes only changed cells, so
the raw capture can't be grepped). Give the screen time to bind the tty
and finish its first refresh: a key on a busy row is refused, a key before
raw mode is lost. By hand, sleeps do; the integration suite waits on the
dump instead (see Testing conventions). Set the pty's size inside it
(`stty cols 140 rows 40`): script's pty has none.

```sh
# Linux: the command is one string, the log is the last argument.
(sleep 4; printf 'l'; sleep 1; printf 'q') | LOADOUT_SCREEN_DUMP=$PWD/frame.txt script -qec "stty cols 140 rows 40; $BIN --repo <repo>" /dev/null
# macOS (BSD script): the log comes first, the command is plain argv.
(sleep 4; printf 'l'; sleep 1; printf 'q') | LOADOUT_SCREEN_DUMP=$PWD/frame.txt script -q /dev/null sh -c 'stty cols 140 rows 40; exec "$0" --repo <repo>' "$BIN"
```

A run that doesn't exit means something kept the screen alive after q
(see the home screen's mechanics in Toolchain facts). Rendering changes
still need a human check: ask the user to run it.

**Ctrl-C in a run**: every action runs its command as a child loadout in
the run panel's pseudo-terminal (internal/tui/term), its own session with
the PTY as controlling terminal, so Ctrl-C typed into the panel is the
line discipline's SIGINT to the child's process group, never to the screen.
The child is started with `LOADOUT_HANDOFF=1`: it traps SIGINT
(cmd/loadout/main.go), stops, and exits 130, which the screen reads as
"interrupted". `70-home-screen` checks Ctrl-C on both platforms.

Manual testing target: the user's live config repo (`$LOADOUT_REPO`: chezmoi's
source, `~/.local/share/chezmoi`; machine name = hostname, or `LOADOUT_MACHINE`; the user's machines run Omarchy/Arch and macOS).
`status`/`diff`/`--dry-run` against it are fine; installing/removing
packages or pushing git needs the user's OK. Opening the home screen
writes the machine's state file there.

## Architecture

One Go module (`github.com/josemiguelo/loadout`, go.mod at the root), one
binary (`cmd/loadout`), everything else under `internal/`. Releases build
with CGO off for linux-x64, linux-arm64, macos-arm64 and macos-x64 from one
runner. The packages depend downwards: model ← assemble ← core and
hclconf; core ← app ← cli and tui; only cli imports hclconf (`compile`),
and cli and tui never import each other (they meet in app).

```
cmd/loadout/main.go  dispatch to cli.Execute; LOADOUT_THEME checked first,
               LOADOUT_HANDOFF's SIGINT trap; every error -> "error: ..." +
               exit 1 (contract 9), Ctrl-C (InterruptedByUser) -> 130
internal/
  version/     Version (the ONE place it's written), InstallCommand, AtLeast
  model/       a config repo, resolved: what the lock holds and engines read
    refusal.go     Refusal — the interface every refusal implements (contract 9);
                   ManifestException, ToolTooOldException
    manifest.go    Manifest and its types; ResolveInstall/CheckFor/
                   DependenciesOf/ForMachine (variant × installer resolution),
                   ShellLine (file: + PATH prefix), ExpandFilePrefix, ScriptEntry
    lock.go        Lock, EncodeLock/DecodeLock (format check), SourcesHash
    codec.go json.go map.go  the lock's JSON field by field, ordered JSON and
                   an insertion-ordered Map: byte-identical to loadout 3's output
    installerlibrary.go  the built-in installers, as Go values
    chezmoidata.go the templates' data file and partial (ChezmoiPartial)
    machinedata.go data merged, validated, compared; glob.go — Glob, GlobExpand
  assemble/    ManifestDraft -> Manifest: built-ins merged, installer
               requires applied, profiles flattened (contract 2), validated,
               file: paths checked through an fs.FS, maps sorted;
               InstallOrder/ScriptOrder (ties by name). AssembleWithoutFiles is
               TEST-ONLY. draftover.go: a child's draft over its parent's
               (contract 18)
  hclconf/     the HCL front end and `loadout compile`
    decode.go      files -> Decoded (draft + spares + transitional + the
                   language's errors), in two passes; declarations, variants,
                   machines and profiles
    refs.go        reference values (kind, name, variant, args) and the
                   functions every expression may call
    body.go        what each block may hold; DiagnosticsError (one line each)
    data.go        the data schema (flag/text/number/whole/list) and machine data
    unused.go      UnusedWarnings, TransitionalWarnings
    compile.go     Compile: loadout.hcl's repo block, globs, the parent, decode,
                   assemble, write the lock (and, with configs, the chezmoi
                   data and partial) only when changed; refuses a Kotlin repo
    hcltest/       ManifestOf for tests (TEST-ONLY)
  core/
    loader/        LoadRepo — reads the lock: missing/newer/stale/floor
                   refusals, file: paths re-checked; ReadLayout reads it
                   alone; ToolTooOld
    state/         StateStore — <state>/<machine>.json; pretty JSON, stable
                   order, WriteIfChanged; LastWarnings
    coremodel/     what the binary observes: MachineState and its parts, SystemInfo
    exec/          ProcessRunner interface + ShellRunner; ALL process use goes
                   through the interface (tests use fakeexec). Capture
                   (blocking), Inherit (sudo/progress), each taking a
                   ShellCommand (line, cwd, env); manifest commands build one
                   through CommandFrame (contract 5); exec.Line is for
                   git/probes/self-version. A child killed by a signal reports
                   -1; Ctrl-C in a LOADOUT_HANDOFF child (a home-screen
                   run) returns InterruptedByUser once the child exits
    detect/        Detection — os/distro/hostname + binary availability (`command -v`)
    engine/        VersionChecker (concurrent checks), UpdateChecker (outdated
                   oracles; exit code deliberately ignored), InstallEngine
                   (plan/execute), UpgradeEngine (planner only: which mechanisms
                   this machine can upgrade, one step per command, refusals;
                   `upgrade` runs and verifies, the home screen plans with it to
                   describe steps and refuse early), ScriptRunner, ConfigEngine
                   (chezmoi over the repo's configs dir: units, drift, edited
                   files, the apply command; contract 17), StatusEngine
                   (observes programs, scripts AND configs; all checks
                   concurrent, read-only), sudo.go (CommandNeedsSudo, the keepalive)
    diff/          DiffEngine — pure: manifest × states -> DiffReport
    git/           GitClient — shells out to `git`, cwd = repo root
    platform/      posix: Hostname, IsStdoutTty, Uname, NowIso, EnvVar,
                   SelfExecutable, TerminalRows/Columns (TIOCGWINSZ),
                   TerminalBackgroundLuma (OSC 11), TrapInterrupts/TakeInterrupt
                   (os/signal); termios_<os>.go hold the ioctl numbers
    coretest/      ManifestOf/Example for core's tests (TEST-ONLY)
  app/         what the CLI and the home screen share: AppContext (shared
               services, RefreshAndWriteState; LoadManifest() is the lock as
               this machine sees it; ReloadLayout), OutdatedReport,
               Explain (explain's answer as data: the CLI prints it, the
               home screen's inspector shows it), RunCommand (the child
               loadout a home-screen run starts), the self-version check
               (LatestRelease: status footer, 6h cache, fail-soft;
               outdated's self-row, fresh), and screen.go: the Screen
               interface (Run → Ended), HomeAction, Handoff, Closed.Command
               (what a confirmed action runs)
  cli/         cobra commands, one file per subcommand (status/explain/
               installers/setup-new-machine/install/upgrade/self-upgrade/
               outdated/run/apply/diff/sync/init/compile); root.go (bare
               invocation without a TTY prints help), home.go (starts the
               screen, prints what it ended with), style.go, table.go, spinner.go, help.go, errors.go
               (usage errors as loadout 3 printed them), converge.go;
               scaffold/ is `init`'s templates (go:embed). `self-upgrade`
               shells to version.InstallCommand and needs no repo, so it works
               under a min-tool-version refusal (which points at it)
  theme/       Tokyo Night / Day palettes, DetectDarkTerminal, ForcedDark
  tui/         the home screen; registers itself as app.NewScreen.
               homemodel.go (ALL state + the domain-facing builders, no
               rendering), keys.go (reducers, dialogs, toasts), lists.go
               (each subject's list, filter), runs.go (the run panel's
               lifecycle), inspect.go, view.go (layout + rendering),
               program.go (the Bubble Tea program, keys/mouse, the screen
               dump), jobs.go (background checks)
    style/     the look: Charmtone themes, rows, dialogs, toasts, the busy clock
    term/      the run panel: one command in a PTY through charmbracelet/x/vt
```

## Design contract — do not violate

Explicit user decisions; don't "improve" them away.

1. **No package-manager auto-detection, no `--pm` flag or env override.**
   The only source of variant choice is the machine and the profiles it
   extends (`via "dnf" { install = [program.curl] }` names a program's
   variant key).
2. **Mapping = membership + strict fail-fast resolution.** A program a
   machine doesn't install is not in its loadout: converge skips it, status
   doesn't observe it, diff shows "-".
   - **Declarations** (a `machines/` folder, a file per machine and per
     profile, or one `machines.loadout.hcl`): `profile "name" { … }` and
     `machine "hostname" { … }`, each with two verbs.
     `via "installer" { install = [programs…] }` maps each program to that
     installer's variant (`install` is the block's only attribute, so a
     line inside always installs through the block's installer; a body
     holds any number of `via` blocks); `install = [programs…]` outside a
     block takes programs with exactly ONE variant (more is a compile error
     naming them: no choosing for you) and named variants
     (`variant(program.setup-brew, "linux")`), mixed. `run = [scripts…]`
     with `args(script.x, "a")` opts scripts in; `variant(script.x,
     "arch")` picks a script variant. A program installed twice or a
     script run twice in one machine is an error. A machine is named by its
     hostname, so the lock (and chezmoi templates reading it) find it; a
     host whose hostname can't or shouldn't be the name (proot's
     `localhost`, a work laptop's asset tag) sets `LOADOUT_MACHINE`, which
     both `--machine` and the partial read first.
   - **Profiles**: `extends = [profile.x]` names profiles only (a machine
     is never extended); profiles may extend profiles (cycles are errors).
     A machine's profiles are combined first: two of one `extends` list
     setting a program's variant, a script's arguments or variant, or a data
     key differently is an error (equal values are fine), so their order
     never changes the result. Then the machine overrides them (mapping per
     program, scripts by name, `data` table by table, lists replace).
     Profiles are flattened, validated, then dropped: never observed,
     diffed or converged. No subtraction: a profile's entry is a promise
     every machine extending it keeps.
   - **`data`** is a typed schema: the `data { … }` block declares every key
     with its default (`work = flag(false)`, a nested `kitty { opacity =
     number(0.85) }` for a table; `flag/text/number/whole/list` exist only
     there). A machine's or profile's `data = { work = true }` is checked
     against it (an unknown key, a wrong type or a table given a non-object
     is an error naming the machine and key) and recorded as written, which
     keeps the profile-conflict error. Every machine ends up with all
     declared keys (model/machinedata.go; bare `explain` shows them); the
     lock holds each machine's merged table.

   `setup-new-machine` refuses (ResolutionException) before
   executing anything if the machine isn't declared, an EXPLICITLY
   requested program is unmapped, a mapped program's dependency is
   unmapped, or a mapped known PM's binary is absent (probed). No automatic
   `script` fallback. A variant with `provides "flatpak" {}` vouches for
   that binary to whatever installs AFTER it in the same plan (flatpak
   before every flatpak on Omarchy); one ordered after its dependents is
   refused, naming the fix. `provides "brew" { at = "/opt/homebrew/bin" }`
   also says where it lands when a fresh shell doesn't have it on PATH:
   the probe counts as present there, and `ForMachine` records the mapped
   variants' folders in `Manifest.ToolPaths`, which `ResolveInstall`
   (install, check, outdated, batch oracle), `UpgradeEngine` (`ToolPathOf`)
   and the status's tool question put first on PATH for every command
   probed through that binary. On the variant, not the program: where a
   tool lands depends on how it was installed. Declared, never inferred
   from a program's name or searched for.
3. **Intent and observation never mix.** The HCL manifests are authored;
   `loadout.lock.json` is generated from them and committed (`loadout
   compile` writes it, and only when its content changed); the
   state directory is generated and disposable. With configs,
   compile also writes `<configs>/.chezmoidata/loadout.json` and the
   `<configs>/.chezmoitemplates/loadout/machine` partial (contract 17),
   generated and committed like the lock. Nothing hand-edited goes in
   state, the lock or those two; the tool never writes authored files,
   except `init` scaffolding.
4. **Scripts: exactly one of `file` (path) or `run` (inline)**, per variant
   when a script has variants. `run` and `check` take a string or a list of
   commands, joined with `&&` (allOf); one holding `||` or `;` is grouped in
   `{ …; }` first, so the join can't change what it means (a single string
   goes through the same rule). Variant commands, installer patterns,
   oracles, `outdated` commands (program and custom source) and all check
   commands may name a repo script: `run_script("x.sh args…")` (stored with
   the `file:` prefix; `installed_by = "x.sh"` for a variant's install, and
   `managed_by`, `updates_managed_by` and a script's `file` imply it), so a
   manifest never writes `file:` itself. Every path is relative to the
   directory of the file that declared it (its `origin`; "" = the repo
   root, also for built-in installers): a declaration's origin is its
   file's folder, so moving a file with its scripts needs no edit, and file
   names need not be unique. What must run from the repo root is declared
   in `loadout.hcl`. Paths are kept as written, and validated at compile
   AND at every lock load to exist without leaving the repo (`..` inside
   one is fine: a shared helper). Expansion is centralized in
   model.ExpandFilePrefix/ShellLine, applied at the execution sites. Tokens
   after the first space are arguments (`file:path args…` → `sh 'path'
   args…`), so script paths can't contain spaces. A variant's param value
   given as `file("repos/x.repo")` (`params = { repofile = file(…) }`) is a
   path too, relative to the program's directory and validated the same
   way; it is substituted as `$LOADOUT_REPO/<repo path>` because the
   installer pattern it lands in runs in the installer's directory.
   Plain values (a URL) pass through.
5. **Every manifest command runs via `sh -c` in its declaring file's
   directory** (installs, scripts, version checks, `check`s, oracles,
   upgrades), whatever the invocation directory, with `LOADOUT_REPO`,
   `LOADOUT_FRAGMENT_DIR` (= that directory), `LOADOUT_MACHINE`,
   `LOADOUT_OS` (`linux`/`macos`) and, with configs,
   `LOADOUT_CONFIGS`, all absolute (`exec.FrameOf`, via
   `AppContext.Frame`). A command takes the origin of the file that WROTE
   it: an installer pattern runs in the installer's directory, a variant's
   own `command`/`check`/`outdated` in the program's (`ResolveInstall`).
   In a child repo (contract 18) a parent's declaration runs in the
   parent's checkout with the parent's `LOADOUT_REPO`/`LOADOUT_CONFIGS`,
   and every command sees `LOADOUT_PARENT` (the parent's root).
6. **Execution order**: all programs before all scripts; programs
   topologically by dependencies, ties broken by NAME (InstallOrder sorts;
   where a declaration sits carries no meaning: files decode in glob order,
   but a reference is an identity, never a position); scripts by
   `run_after` edges, ties by name. Whatever must come first says so.
   Sequential, never parallel (only read-only checks run concurrently).
   `run_after` orders but never pulls anything in; dependencies pull in
   transitively. A program's dependencies (`Manifest.DependenciesOf`) are
   its own `depends_on`, the mapped variant's (a COPR's dnf-plugins-core
   never lands on a pacman machine), and what the variant's INSTALLER
   `requires` of everything it installs (`requires "brew" { programs =
   [program.setup-brew] }`; the required program is exempt from its own
   installer's rule). Validation and cycle detection count every variant's
   edges. An install whose dependency failed (or was itself skipped) is
   skipped, not tried (`InstallOutcome.SkippedFor`), and counts as a
   failure: the run says what it skipped and why, and exits 1.
7. **Script status is observation**: every refresh re-runs each `check`
   (exit 0 => `done`, else `pending`), even right after a run; `lastRun`/
   `exitCode` are only history of tool-run executions. Check-less scripts
   carry only run history. Install success = exit 0 AND a re-run version
   check no longer says missing. **A check that couldn't run is not
   "missing"**: a check that goes THROUGH a tool (`VersionCheck.Probe`, from
   the installer's/variant's probe) and dies with the shell's 127/126 is
   `unknown`, with `ProgramState.Reason` set to the shell's line; a check
   with no probe IS the program, so its 127 means missing. (Otherwise a tool
   off PATH reports all its programs missing.) The refresh groups unknown
   rows by tool and asks about each ONCE (`command -v`):
   `StatusEngine.LastToolsDown` — `status` reports it once after the table,
   the home screen in a toast, and affected programs are never
   offered for install. Ceiling: a pipeline check (`tool | grep …`) exits
   with the LAST command's code and hides the tool's absence; write
   `x=$(tool …) && printf '%s\n' "$x" | grep …` so the failure propagates.
   A **yes/no check** (`present = "…"`, `managed_by` without a `regex`)
   has no regex: exit 0 is installed with no version recorded, so a setup
   step that is a program (setup-dnf, a flatpak remote) needs no fake
   version string.
8. **State files**: written only for this machine; `updatedAt` bumps only
   when content changed (clean git history; `sync` is a no-op when idle).
   Unknown JSON keys are ignored on read.
9. **Errors are clean one-liners** (`error: ...`), never stack traces or
   panics. Every refusal implements `model.Refusal`, and cmd/loadout/main.go
   prints any error that reaches it as one `error: ` line (an OS error
   too), so a new failure type needs no new case. A test asserts that every
   refusal type implements it (loader_test.go).
10. **Product code loads manifests via `loader.LoadRepo`** (the lock,
    checked) and sees it through `Manifest.ForMachine` (its script
    variants picked; `AppContext.LoadManifest` does both).
    `assemble.AssembleWithoutFiles`, `hcltest.ManifestOf` and
    `coretest.ManifestOf` are for tests only: they skip the `file:` checks,
    and everything else — built-ins, flattening, validation — is the
    production path.
11. **No templates.** HCL's abstractions are the allowed ones, kept to
    plain values: `locals` (shared lists: `everyday_cli = [program.bat,
    program.eza]`) and user functions (`function "ssh_key"`, which saves
    repeating two `args(…)` entries in every machine). Nothing that
    generates programs or machines: every block is written out, so a
    reader finds every program by name in one place.
12. **Scripts are opt-in per machine**: `run = [script.x, args(script.x,
    "a")]` in a machine or profile. Each argument is one or more words;
    the machine's entries are "name args…", parsed by `ScriptEntry` (args
    re-joined with single spaces because they're pasted into a shell
    command line, where a newline would run the next line as a command).
    Only opted-in scripts converge and are observed; `run` errors on others.
    Args become positional params for the file script AND its check (`set
    --`, see engine.WithArgs); `managed_by = "x.sh"` checks with `x.sh
    check "$@"`, so a managing script gets them in both modes. Args on an
    inline script are an error. No implicit script application, no OS or
    bootc detection deciding membership (the old `os` filter is gone: the
    machine's opt-in decides). A script's modes (`setup_only = true`,
    `maintain_only = true`, default both) scope EXECUTION only:
    setup-new-machine converges setup-mode scripts, the home screen's
    scripts picker lists maintain-mode ones; status observes all opted-in
    scripts and `run` ignores modes. A script may declare `variant "name" {
    … }`s (its own file/run, check, run_after; description, modes and
    needs_sudo shared); a machine running it must pick one, and engines
    only see the picked one (`ForMachine`).
13. **Installers own mechanics; variants refine them.** An installer
    (`probe`, `install`, `check`, `regex`, `outdated`, `outdated_all`,
    `upgrade`, `needs_sudo`, `params`; `{pkg}` substituted) defines a
    mechanism once, repo-unique. Loadout
    ships a library (`internal/model/installerlibrary.go`: dnf, dnf-repo,
    dnf-copr, brew, brew-cask, flatpak, pacman, omarchy, omarchy-aur with
    oracles; apt install/check only) as Go values, named in manifests as
    they are (`dnf`, `brew-cask`, or `installer.dnf`), merged UNDER the
    repo's own at assembly: a repo installer of the same name replaces the
    built-in outright (and the bare name then refers to it), and
    `Manifest.BuiltinInstallers` records which survived so
    `explain`/`installers` label `(built-in)` vs `(repo)`. `requires "x" {
    programs = [...] }` adds to any installer, built-ins included, without
    redefining it. Knowledge, never detection: nothing probes the machine
    to pick an installer.
    A program lists its variants as `install_via = [brew, omarchy]` (an
    installer as it is) and `via "brew" { pkg = "vim" }` blocks (configured
    where it's named: `via "dnf-copr" { params = { copr = "x/y" } }`, `via
    "dnf" { managed_by = "x.sh" }`), so a variant never reads like a
    command being run. `custom "linux" { … }` is the variant with no
    installer: a command of its own (`custom { … }` is named "custom", for
    a program with one). Naming an installer twice, across the list and the
    blocks, is an error, so there is no hidden merge. Variants keep their
    source order. Every field is optional and defaults from the installer;
    `pkg` defaults to the program name. An installer may declare `params =
    ["copr"]`: values a variant supplies (`params = { copr = … }`),
    substituted like `{pkg}`. All declared, never inferred: a missing param
    or an undeclared one is an error, so an unsubstituted `{placeholder}`
    never reaches a shell.
    Resolution (`Manifest.ResolveInstall`/`CheckFor`, used by every
    engine/UI): command → installer install pattern (else error); check →
    variant check → installer check (else program `version`); probe →
    installer probe (else none); outdated → variant override, else
    installer `outdated_all` (one batch command per installer, per-program
    regex extracts; binaries that don't know it fall back to per-pkg), else
    installer per-pkg pattern, else no oracle (`outdated` skips and says
    so). These oracles' exit codes are always ignored. A program's
    `path = [...]` puts directories first on PATH for its commands
    (`ShellLine`), so a check never needs `tool || $HOME/.local/bin/tool`.
    Repos may also declare custom `outdated` sources: on the script they're
    about (an `outdated { }` block inside `script`, named after it unless
    it says `name`) or alone (`outdated "name" { command = … }`). The usual
    form is `updates_managed_by = "x.sh"`: `x.sh` lists, `x.sh update
    <item>` updates one row (on a program, `x.sh` prints the newest version
    and `x.sh update` updates it); `command`/`upgrade` is the long form for
    anything else, a read-only source included (`<item> <current>
    <candidate> [note…]` lines; a URL in the note becomes the row's link,
    opened with `K`; `run_script(…)` allowed, repo-unique). Unlike
    installer oracles, a source's exit code is NOT ignored: non-zero
    surfaces as `outdated source [name] failed: ...`, so a crashing oracle
    can't hide updates.
    Installers may declare `upgrade`: the ONE command that moves everything
    the mechanism manages, with no `{pkgs}` placeholder (contract 15).
    Never write cross-variant `||` chains in checks.
    `needs_sudo = true` (installer, variant, script, `outdated` source)
    declares a command that needs sudo's password without saying `sudo`
    itself (`omarchy pkg add`, a repo script); a variant's replaces its
    installer's. `setup-new-machine`, `install`, `run` and `upgrade` ask
    for the password once, after the confirmation and before the first
    step (`askForSudoUpfront` in cli/converge.go), when their plan holds a
    step that needs it: declared, or a command matching `CommandNeedsSudo`
    (core/engine/sudo.go: the word sudo, not "pseudo"). Scripts count only
    while pending (`ScriptRunner.Pending` asks the check, which `run` asks
    again). Valid credentials ask nothing; a refusal stops the run before
    any step. A background shell loop then runs `sudo -n -v` every 50s
    while loadout's pid lives, checked every second (`SudoKeepalive`), so
    a step an hour in finds them valid. Never inferred from a script's
    content: an undeclared sudo inside a repo script still prompts
    mid-run, on the terminal, as before. Home-screen runs get this for
    free: each runs one of these subcommands, in the run panel.
14. **Versioning contract.** The deliberate breaks: 0.2.0 (string install
    values became variant mappings), 0.9.0 (`templates` removed), 2.0.0
    (TOML to YAML), 3.0.0 (YAML removed: manifests are the Kotlin DSL,
    compiled into the lock), 3.1.0 (`install(installer, programs…)`
    removed for `via(installer) { install(…) }`; kept a minor release
    because the lock format didn't change) and 4.0.0 (the Kotlin DSL
    removed: manifests are HCL, compiled by the binary itself, no JDK or
    Gradle; a Kotlin repo is refused by name; the lock format is
    unchanged, so a 3.x lock still reads). A removal is decided once,
    loudly, in the release notes, never silently. The manifest language
    and the binary are one version: compile is the binary's own, so a repo
    compiles against exactly the installed binary. The lock carries
    `format` (bumped only when an older binary could misread a lock; a
    newer one is refused by name before anything else is read) and the
    `toolVersion` that wrote it: a binary refuses a lock from a newer MINOR
    (patch releases never change what a lock means), naming
    `self-upgrade`. `meta minToolVersion` (`repo { min_tool_version = … }`)
    is a floor the repo declares on top.
    New lock fields are additive with defaults. State files with
    `schemaVersion > coremodel.SchemaVersion` are skipped with a warning
    (`StateStore.LastWarnings`; new read paths must echo/log them). Bump
    SchemaVersion only for a real schema break; handle older schemas via
    defaults.
15. **Converge installs; `upgrade` upgrades, a whole mechanism at a time.**
    `setup-new-machine`/`install` add what's MISSING and never touch a
    version already there. Moving versions is its own verb, `loadout upgrade
    <installers…>|--all` (`UpgradeEngine`), never single packages: naming a
    program is an error pointing at its mechanism. Mechanisms sharing a
    command (dnf, dnf-repo, dnf-copr all run `dnf upgrade -y`; omarchy and
    omarchy-aur both `omarchy update -y`) are ONE step,
    deduped by command; the UI groups by the TOOL they drive (their probe),
    so ticking a brew row ticks casks too. `PlanUpgrade` refuses an
    installer this machine doesn't map, so a repo mapping nothing to brew
    can't sweep it.
    Custom `outdated` sources upgrade per item: their update command
    (`x.sh update <item>` under `updates_managed_by`, or `upgrade = "…
    {item}"`) runs once per row (`upgrade --item <source>/<name>`),
    since items (a pin, a clone) are independent and one failure shouldn't
    stop the rest; a source without it is read-only (`[–]`). Afterwards
    EVERY mapped program is re-checked, since the transaction can move
    packages loadout doesn't declare. The binary's own update is
    `self-upgrade`, which needs no repo, so it survives a version-floor
    refusal. Both refusals of a too-old binary (floor, newer minor) are
    `model.ToolTooOldException`, carrying the version needed. `sync`
    catches it after its pull: it refuses when the latest release is still
    below it, else runs the install and then the same sync with the binary
    it was started from (its path read BEFORE the install: Linux names a
    replaced `/proc/self/exe` "(deleted)"), under `LOADOUT_SYNC_UPGRADED=1`,
    which turns a second refusal into an error instead of another upgrade.
    A child's sync that compiled before the refusal also passes
    `LOADOUT_SYNC_RECOMPILED=1`: the sync it starts finds the lock already
    compiled (the parent unchanged since) and must still commit it. The
    home screen ends after an S whose repo now refuses its binary
    (`loader.ToolTooOld`), like after U. Only `sync` upgrades by
    itself: it is the command that pulls, so it's the one that meets a
    repo moved ahead of the binary.
16. **The repo's shape is declared, never assumed.** A config repo is
    `loadout.hcl` at its root, always compiled, plus the files its `repo {
    sources = [...] }` globs match, and only those (`Glob`: `*` one
    segment, `?` one char, `**` any depth; wildcards never match a leading
    dot, so `.tmux.loadout.hcl` compiles only when a glob spells the dot;
    `.git` is never entered). Nothing else: no build files, no build
    folder, nothing outside the repo. `repo { state = …, configs = … }`
    names the state and chezmoi dirs; `state` is required, with no
    default. The lock records the globs (`loadout.hcl` first) and a sha256
    of the files they match (path + content); a binary that finds them
    changed refuses with "run: loadout compile", so a lock never silently
    lags its sources. A repo with `loadout.kt` or `build.gradle.kts` and no
    `loadout.hcl` is a loadout 3 repo: compile refuses it by name. The suite runs with its own
    XDG_CACHE_HOME (seeded with a release, so `status` doesn't ask
    GitHub), never the developer's.
17. **Configs are chezmoi's, observed like everything else.** `repo {
    configs = … }` names chezmoi's source directory inside the repo; unset,
    there is no configs concept and chezmoi is never called. Every chezmoi
    call is `chezmoi --source <repo>/<configs> --no-pager …`
    (`ConfigEngine`), so a `--repo` worktree is observed and applied from
    that worktree, never from chezmoi's own configured source.
    - **Units**: `.config/<name>/…` is unit `<name>`, any other target its
      first path segment (`.zshenv`, `.local`), from one `chezmoi managed
      --include files,symlinks` per refresh. Not opted in: `.chezmoiignore`
      is chezmoi's membership. A unit may share a program's name (tmux);
      `explain <name>` shows both.
    - **Drift is observation** (contract 7): one `chezmoi status --include
      files,symlinks` per refresh. Its second column is what `apply` would
      change (the same answer as `chezmoi verify`, in one call); a unit with
      any such file is `drifted`, with them in `ConfigState.Files`. Its
      first column marks a file edited since chezmoi last wrote it.
    - **chezmoi can't answer** (absent: exit 127; a template error): the
      units last seen are `unknown` with chezmoi's line as the reason, and
      `status` says it once (`StatusEngine.LastConfigsDown`); never a
      refusal for status.
    - **Writing**: `apply [unit…]` and `sync` run `chezmoi apply --no-tty`
      (a unit = its targets, absolute via `chezmoi target-path`). Without a
      terminal chezmoi aborts the whole apply on a file edited in place
      (it would ask), so both refuse first when a file they'd replace is
      edited AND drifted (`refuseEdited`, cli/apply.go), naming the files:
      keep them with `chezmoi re-add`, or replace them with `apply
      --force`. `sync` = pull → (upgrade loadout, contract 15) → refuse
      edited → apply → refresh → name what's left (missing programs,
      scripts not done) → commit → push; nothing is committed after a
      refusal or a failed apply. It never installs or runs scripts itself.
      Its pull (or a parent's, through the child's compile) can rename the
      repo's folders, so `sync` calls `AppContext.ReloadLayout()` after
      them: everything read from the layout (configs and state folders, the
      parent, chezmoi's sources) is read again, never kept from before the
      pull.
    - **State**: `MachineState.Configs`, left out of the file when empty,
      so repos without configs write what they always did and older
      readers ignore it (schema stays 1). `diff` shows a CONFIG table (`-` =
      the machine doesn't report that unit) and exits 1 on config drift.
    - **Templates' data**: `loadout compile` writes `<configs>/
      .chezmoidata/loadout.json` (`model.ChezmoiDataFiles`), which chezmoi
      loads into every template as `.loadout`: `loadout.defaults` (every
      declared key) and `loadout.machines.<hostname>` (each machine's
      merged table). That shape is the contract with templates; the lock's
      layout stays loadout's own (templates reading the lock broke on any
      change to it). Compile also writes the partial that picks this host's
      table, `<configs>/.chezmoitemplates/loadout/machine`
      (`model.ChezmoiPartial`): the machine loadout runs as
      (`LOADOUT_MACHINE`, else the hostname, so a plain `chezmoi apply`
      agrees with `--machine`); for a machine this repo's data lacks, its
      table from the lock of `LOADOUT_REPO` (a child repo declaring it,
      contract 18), else the defaults. The partial reads loadout's lock
      because compile writes both and every load checks the partial; no
      user template may. So a repo's templates read their machine with
      `includeTemplate "loadout/machine" . | fromJson` and the partial
      always matches the data's shape. The `loadout/` folder keeps it apart
      from the repo's own templates. Every load re-renders both from the
      lock and refuses a missing or different file ("run: loadout
      compile"), so dotfiles never render from data the manifests don't
      say. `init --configs` scaffolds such a repo (`configs =
      "loadouts"`, a `.chezmoiroot`, `loadouts/`), every manifest in
      `loadouts/`, laid out where files land: a tool's manifest sits at its
      destination (beside its dotfiles; with none, a dot-file, or a
      dot-folder for one with scripts, since chezmoi deploys no dot entry
      and a plain folder holding only a manifest would land empty in
      `$HOME`), and what lands outside `$HOME` and belongs to no tool
      (system packages, hardware) is a folder per concern in `.etc/`
      (`.etc/dnf/`).
      No `system/` beside it: one folder holds the whole loadout. `**`
      never enters a dot folder, so the scaffold's globs spell it
      (`loadouts/**/.*/.*.loadout.hcl`) beside
      `loadouts/**/.*.loadout.hcl`, and `.etc/`'s folders get
      `loadouts/.etc/*/.*.loadout.hcl`. Plain `init` keeps `programs/` and
      `maintenance/`.

18. **A child repo inherits a parent; nothing flows back.** A private repo
    names a public one in its `loadout.hcl`, `repo { parent { name = …,
    path = … } }` (`~/…`, absolute, or relative to the child), and its
    manifests use the parent's installers, programs, scripts, outdated
    sources, profiles and data schema by name (`program.x`, checked at
    compile like its own). One level, one parent; any number of children,
    none of which the parent knows.
    - **Compile** (hclconf/compile.go): the parent's own lock names its
      globs; compile refuses a parent that has no lock, whose lock is stale
      (its manifests' hash differs: an unknown file set), that is itself a
      child, or whose manifests are Kotlin. It decodes the parent's files
      as a parent (every origin `parent:`), then the child's against the
      parent's namespace, and merges them (`assemble.DraftOver`): the
      parent's machines, meta and layout stay out; a name both declare, a
      machine in both and a child data schema are errors; the floor is the
      higher `min_tool_version`. A parent's mistakes are reported prefixed
      `parent <name>: `. Unused and transitional warnings are the child's
      own declarations' only.
    - **Lock**: `layout.parent` (name, path as written, state, configs,
      globs, hash of the parent's manifests); a parent declaration's origin
      is `parent:<folder>` (`Origin`), its `file` values `$LOADOUT_PARENT/…`
      (a built-in installer that takes them runs in the child). A repo
      without a parent writes exactly what it did. A parent edit the child
      hasn't compiled is refused at load like a stale lock, and a missing
      parent by name and path.
    - **Runtime**: commands as in contract 5; configs are two chezmoi
      sources, the parent's then the child's (`ConfigEngine`): units span
      both, a target both manage is `unknown` and refused by `apply`, and
      chezmoi runs with `LOADOUT_REPO` (the child) and `LOADOUT_MACHINE` so
      the parent's partial finds the child's machine. `diff` and the fleet
      row are the parent's machines and the child's (the parent's state
      read-only). `sync` pulls the parent, never commits or pushes it, and
      when the parent's manifests changed compiles the child and commits its
      lock with the state.
    - **Privacy**: nothing a command run on a child does writes under the
      parent (compile's and the state store's `WriteIfChanged` assert the
      child root; the parent's `StateStore` is read-only; its git only
      pulls). `integration/t/110-parent-repo.sh` checksums the parent
      around every command. `init --parent <path> [--name n]` scaffolds a
      child.

## Toolchain facts — don't rediscover

- **Go, per go.mod's `go` line**; deps added with `go get`, then `go mod
  tidy`. cobra/pflag for the CLI, hashicorp/hcl v2 + go-cty for manifests,
  x/sys + x/term for the terminal, Bubble Tea v2 / Lip Gloss v2 / Bubbles
  v2 (`charm.land/…`) for the home screen. Releases build with
  `CGO_ENABLED=0`: static binaries, every target cross-compiled from one
  Linux runner.
- **Outputs are byte-identical to loadout 3's**: the lock, state files,
  `.chezmoidata/loadout.json` and the partial are written field by field in
  kotlinx's order and format (model/codec.go, json.go, core/state/codec.go:
  key order, defaults dropped, only JSON's required escapes, a `number`
  written as Kotlin's Double: `1.0`), so a 3.x lock and state file decode
  and re-encode to the same bytes (`testdata/`) and a fleet mixing versions
  commits no noise. Keep it that way when adding a field. Help and usage
  errors are likewise laid out as loadout 3's (Clikt's) were (help.go,
  errors.go).
- **The lock always says its format**: defaults are dropped, but
  `EncodeLock` writes `format` always; without it an old binary couldn't
  refuse a newer lock by name.
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
  (plan table, `extraRows` for setup's scripts), `confirmOrAbort`,
  `askForSudoUpfront`, `installPrograms`. `install` and
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
- **Home screen** (bare `loadout` on a TTY; a pipe gets help):
  `internal/tui` (homemodel.go + keys.go hold all state and logic,
  unit-tested; view.go draws). Layout B, master–detail, in Crush's style
  (user decisions): the sidebar LEFT (32 cols) and the main pane right of
  it, which shows one subject (programs, scripts, configs — only with
  `repo { configs = … }` —, remote, fleet) under a plain title row
  (`Programs` bold in primary, its summary at the right), a filter line and
  the subject's list. Plain, styled text only: no `╱` hatch, no block-letter
  logo (the user removed both). The sidebar has the brand line (`loadout`
  in a gradient, the version at the right), the machine, a `Machine`
  section with the five subjects (status glyph, name, short count) and
  `Runs` (this session's runs, newest first). Side by side needs ≥100
  columns (width only: a wide but short window keeps it). Tests find a row
  by its text, never by position.
- **Under 100 columns the screen is STACKED** (user decision, replacing a
  compact layout of header + subject tabs + a `d` details dialog), like a
  website's sidebar collapsing on a phone: ONE page fills the screen, the
  focused area's — FocusSidebar is the home page (the sidebar's content,
  full width), FocusMain the subject page (title, filter, list or
  inspector), FocusTerminal the run page (the panel, full height). Same
  state, focus areas and reducers; only the presentation changes, so a
  resize across 100 keeps the focus. A breadcrumb row on top (`loadout ›
  m1`, `loadout › programs › inspect › git`, `loadout › scripts › run`;
  the verdict counts ✓N ●M at the right, and `⟳ <run>` while a command
  runs off-page), a horizontal `style.Divider` rule under it (no `│` or
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
  in `style.Divider` (BgMost: quiet, still visible on a transparent
  terminal). The focused area's title wears the focused selection's
  highlight (`TitleRowFocused`: the Primary fill and OnPrimary ink of a
  selected row), so tab lands on something that stands out in every area,
  the run panel included (user decision); every other title is muted
  (`TitleRowMuted`). The sidebar has no title row: its selected entry is
  its highlight.
- **Focus areas, not one cursor** (user decision, replacing "one cursor
  for the whole screen"): the sidebar (subjects, then runs), the main pane
  (its list, filter or inspector) and the terminal (only while the run
  panel shows). tab/shift+tab cycle them (side by side); ctrl+] always leaves the
  terminal for the main pane. A run opened from the sidebar's Runs
  (enter or a click) gives the focus back to that entry when the panel is
  left (h/←) or closed (esc) — `RunFromSidebar` — not to the main pane,
  which never opened it. The focused area's selection is a full-row fill,
  with no bar (user decision: the `▌` read as a stray `|`) — Primary with
  OnPrimary ink, the same in the sidebar
  (`style.SubjectRow`) as in the main pane (`ListRow`), so the active
  entry stands out (user decision); an unfocused area keeps its
  selection on a dimmer BgLess fill. Moving in
  the sidebar switches the main pane's subject at once; 1–5 jump. Each
  subject keeps its own cursor, scroll and filter (`Cursors`/`Offsets`/
  `Filters`, keyed by subject name); `snap` re-resolves a cursor against
  the CURRENT rows after every reshape (nearest stop at or above), so an
  emptied list never highlights nothing. Keys: ↑↓/jk move, pgup/pgdn page,
  `[`/`]` jump between remote groups (not `H`/`L`), l/→ into the list or
  unfold, h/← fold or back to the sidebar, space tick, a all, u none, enter
  ACTS in the list (a confirm dialog first; never on a busy subject) and
  on a sidebar subject only goes INTO its list, like l (user decision: a
  command never starts from a row whose ticks aren't in view; enter on a
  sidebar run shows that run), `/` filter (fuzzy,
  matched runes underlined; esc clears), ctrl+d/ctrl+u half a page as in vim and less (user decision; the list, the inspector and a finished run's output — a running command gets them, ctrl+d is its end of input), `i` inspector, `K` link, `r`
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
  from `OutdatedReport.Tools`): a heading per probe (brew and brew-cask are
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
  (`ConfigEngine.Edited`): any, and an Error toast names them plus a list
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
  as `explain` resolves it (`app.Explain`, shared with the CLI: no explain
  logic in the TUI), where it is declared, this machine's last verdict
  from the rows on screen, and every machine's from the fleet comparison.
  esc goes back to the list.
- **Commands run INSIDE the screen** (user decision, replacing "nothing
  runs inside the screen; every action is a hand-off" and "no screen
  re-displays command output"): a confirmed action runs its real
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
  - The yes builds the command with `AppContext.RunCommand` (a CHILD
    loadout: `platform.SelfExecutable()`, the global options, the
    subcommand with `--yes`/`--force` as `Closed.Command` says,
    `LOADOUT_HANDOFF=1`, `PAGER=cat`/`GIT_PAGER=cat`: a pager would work in
    the panel, but its screen leaves nothing in the run's log) and starts
    it in a `term.Model` (internal/tui/term: creack/pty + charmbracelet/x/vt;
    the reply pipe drained, redraws coalesced, OSC 10/11 answered with the
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
    binary (`loader.ToolTooOld`), END the screen: the binary on disk is a
    different version, and the run's output plus what to do next is
    printed on the normal screen (`app.Ended`).
  - The run stays in the panel until esc dismisses it or the next run
    starts, and in the sidebar's Runs (at most `maxRuns`; enter shows one
    again). Only the newest finished run keeps its emulator (4 MiB); older
    ones are closed and keep their text (`term.Close` keeps `Plain`).
- **Dialogs** are centred overlays (no dim): confirm, list, command
  palette (ctrl+p: fuzzy filter, every machine verb and subject with its
  key) and help (ctrl+g: bubbles/help's full view; stacked, it names no
  tab or zoom). A dialog owns the keyboard. **Toasts** are floating cards at the
  bottom right, above the help line, which stays (`style.ToastCard`; user
  decision, replacing a full-width band that covered a transparent
  terminal): a rounded border, icon and title in the kind's colour (✓ Done,
  ! Warning, × Error, • Note), the message wrapped below, nothing filled,
  4s; a dialog sits over one. Every message the screen says is one.
- **The home screen's Bubble Tea mechanics** (`internal/tui/program.go`,
  `jobs.go`): ONE program for the whole session on Bubble Tea v2's own
  renderer (cell diffs, synchronized output). `View` returns a `tea.View`
  with AltScreen (quitting gives the normal screen back exactly as it
  was), MouseModeCellMotion and, while the terminal has the keys, its
  cursor offset
  by the panel's position. Keys come from `/dev/tty` when stdin isn't one.
  Background work (refresh, remotes, plans, the browser) is a `tea.Cmd` run
  by `jobs`: the first refresh starts before the program, a finished job
  queues its message and `prog.Send`s a wake-up, so every state write
  happens on Update's goroutine (no lock around state). Reducers queue
  their commands (`m.cmds`: toast expiries, the terminal's messages) for
  the program to run. Busy is shown by Bubbles' MiniDot braille spinner
  (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` in Primary, `style.BusyGlyph`/`BusyLabel`), every row on
  the same frame (user decision, replacing scrambling glyphs: calm, and
  never mistaken for a status glyph such as the attention `●`). It runs
  off ONE clock (`style.Busy`) that ticks only while something is busy
  and stops on exit, so q never hangs. `LOADOUT_SCREEN_DUMP=<file>` (undocumented for users) writes
  each changed frame as plain text, atomically: the PTY tests' window.
- **Each subject settles on its own** (user decision): programs, scripts
  and configs are checked side by side by ONE refresh
  (`StatusEngine.RefreshParts` → `AppContext.RefreshAndWriteStateParts`),
  which hands each part to the screen the moment ITS checks finish
  (`engine.Part`; the refresh job `post`s a `partMsg` per part before its
  own message). `HomeState.Checking` is the subjects still waiting: a
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
  logic: StatusEngine/DiffEngine/`AppContext.OutdatedReport`/`Explain` do
  the work, and every action is a real subcommand. Rows measure their
  columns once a frame from ALL the list's rows, not just the visible ones. A script's verdict is always its check.
- **Manifests are HCL, compiled by the binary; every other command reads
  JSON.** `loadout compile` is `hclconf.Compile` under a spinner: on
  success it prints `✔ wrote loadout.lock.json` and its warnings; on
  failure every diagnostic, one `error: ` line each. Nothing is written
  when anything is wrong.
- **HCL decodes in two passes; references are identities.** Pass one
  collects every block's label in every file (the namespace); pass two
  evaluates attributes against it. A reference (`program.x`,
  `script.x`, `profile.x`, `installer.x`, a bare installer name like
  `brew-cask`, `local.x`) is a value carrying only its kind and name (plus
  `variant`/`args`), so the order of files and declarations never matters
  and nothing initialises anything. An unknown name is HCL's own "Unsupported
  attribute; This object does not have an attribute named …". Locals may
  use locals (cycles are errors); user functions (`function "x" { params
  = [a] result = … }`) work in any file. Lists of references are flattened,
  so `install = [program.curl, local.everyday_cli]` works.
- **Diagnostics name the file from the repo root**: `error:
  programs/x.loadout.hcl:2,13: <summary>; <detail>`, every one of them,
  one line each (`DiagnosticsError`); a parent's files by their path.
  The language's own rules (a name declared twice, an install without
  saying how) are refused together after HCL's, as "Invalid manifest:".
- **Shell text in HCL**: `$HOME` passes through as written, but `${…}` is
  HCL interpolation and `%{…}` a template directive, so a shell `${VAR}`
  is written `$${VAR}` and a literal `%{` is `%%{`. A heredoc (`<<-EOT`)
  keeps its trailing newline in the value: wrap it in `chomp(…)` when the
  newline matters. Prefer repo scripts (`managed_by`, `run_script`) for
  anything longer than a line.
- **A name starting with a digit isn't a traversal**: `program.1password`
  is a syntax error; write `program["1password"]`. Dashes are fine
  (`program.setup-brew`).
- **One attribute per body, one argument per single-line block.** Setting
  an attribute twice is HCL's "Attribute redefined", so a machine has one
  `install` and one `run` (repeat `via` blocks, not attributes). A
  single-line block holds at most one argument (`via "pacman" { pkg =
  "github-cli" }`); two need the multi-line form.
- **HCL house style** (the dotfiles port, `init`'s scaffold and the docs):
  the label is the name (`program "ripgrep"`, `machine "<hostname>"`);
  `description` is the body's first line, on its own; `install_via` is one
  line (`install_via = [brew, omarchy]`), the variants it can't express as
  `via`/`custom` blocks after it; a one-attribute block may stay on one
  line (`via "pacman" { pkg = "github-cli" }`); `=` aligned within a group
  of attributes (hclfmt's style); a list too long for a line opens `[` and
  closes `]` on their own lines, one entry per line with a trailing comma
  (a profile's long lists of plain names may group a few related ones per
  line); a comment about an entry sits above it; a blank line between
  declarations.
- **Compile warns about what no machine uses** (hclconf/unused.go): a
  profile no machine extends, a program none installs (dependencies
  count), a script or script variant none runs, a repo installer nothing
  in use goes through. A way to install a program that no machine picks
  is reported only when some machine uses that installer for OTHER
  programs ("machine 'm' installs other programs via 'dnf', but not fzf"):
  `install_via` lists every true claim, so a variant through an installer
  nobody uses (a scaffold's ripgrep via apt, a COPR for a future Fedora
  machine) is the recipe, not a mistake. Warnings, never refusals: the lock is written either way.
  `spare = "reason"` marks one kept on purpose (on the profile, program,
  variant, script variant, installer); a spare profile's contents count as
  used, and a spare mark on something used is itself a warning, so marks
  can't go stale. A machine can't be spare.
- **Transitional scripts end themselves through compile**
  (`TransitionalWarnings`): `transitional = true` marks a script that only
  exists until every machine has done it (a cleanup after a change). It is
  a compile-time mark like `spare`, kept by the front end and never in the
  lock, so binaries are untouched. Compile reads `<state>/<machine>.json`
  for every machine that runs it and warns "delete it" once all of them
  report it `done`; a machine without a state file hasn't done it. Done
  means its check passes (contract 7), so a transitional script needs a
  check (on itself, or on every variant), and the mark goes on the script,
  never a variant. This is loadout's answer to migrations: no ledger of
  what ran, since a fresh machine's check already passes; history-only
  steps (nothing on disk can tell) stay manual instructions.
- **A profile's long list can live beside its scripts**: a user function
  in the scripts' file (`function "omarchy_bar" { params = [] result =
  [args(script.omarchy-bar, …), …] }`), called from the profile's `run`
  (`omarchy_bar()`). It returns only references, so where it lives
  changes nothing in the lock.

## Testing conventions

- Unit tests are Go `_test.go` files beside the code (`go test ./...`). No
  real processes: `fakeexec.Runner` (scripted command lines with stdout/
  stderr/exit; an unregistered command exits 127) behind
  `exec.ProcessRunner`. Files are `t.TempDir()` or `testing/fstest`
  (assembly's file checks go through an `fs.FS`).
- Fixtures are written in HCL where the front end is in reach:
  `hcltest.ManifestOf(t, src)` / `ManifestOfFiles` / `Refusal` (TEST-ONLY,
  contract 10: the real decoder, `file:` checks skipped). Core's tests
  build drafts in Go:
  `coretest.ManifestOf(t, func(b *coretest.Draft) { … })` and
  `coretest.Example(t)`, the shared fixture. The language's meaning and
  mistakes are tested in hclconf (dsl_test, decode_test, assembly_test,
  compile_test, unused_test, in HCL), assembly on hand-built drafts in
  assemble, the lock reader in core/loader, byte-identical encoding
  against `testdata/` locks and state files written by loadout 3.
- Integration = `integration/run-tests.sh`: black-box, real binary. The
  runner sources `lib.sh` (ok/fail, fixtures, `has_pty`/`pty_run`), then
  every `t/NN-*.sh` in name order, each in its OWN fresh directory: a file
  builds its fixtures (`basic_repo`, `scripts_repo`, `scaffold_repo`, or
  inline) and never depends on another file; the numbers only fix the
  order. Fixtures are HCL repos: `hcl_root <dir>` (loadout.hcl with the
  repo block over init's plain layout, stdin as declarations at the root),
  `hcl_repo <dir>` (the same, nothing at the root), `hcl_file <path>`
  (stdin as one manifest), `repo_attr <loadout.hcl> '<attr>'` (a line
  added to the repo block: `configs = "configs"`), then `compile_repo`,
  which compiles with the real binary (milliseconds: no cache). A `manual`
  custom variant with a failing command keeps tests off the host's
  package managers. Add an `ok "..."` test for every user-visible
  behavior change, in the file whose subject it is (new subject = new
  file); run that file with a name pattern while iterating. Never share
  state across files through `$WORK`. Configs tests (`t/55-configs.sh`)
  put a stub `chezmoi` on PATH for each command only (`cz_loadout`: the
  files are sourced into one shell, so an exported PATH would leak),
  answering from files and logging its calls; a real chezmoi would read
  and write the developer's own dotfiles, so "chezmoi missing" is the
  stub's exit 127, never a PATH without it.
- TUI: the model's reducers (`handleKey`, `handleText`, `runExited`,
  `followUp`) and pure builders (`sectionsOf`, `scriptRowsOf`,
  `programRowsOf`, `preselect`, `selectionKey`, `remoteLines`, `listOf`,
  `upgradeItem`) are unit-tested in internal/tui on a state set up by the
  test; runs go through seams (`runCommand`, `newTerm` with a fake
  terminal, `explain`), and the frame's size is checked in both layouts.
  Rendering is verified manually (ask the user) plus PTY probes.
  `t/70-home-screen.sh` (`has_pty`-guarded, `script`-driven) and
  `t/71-terminal.sh` (plain commands: TTY-gated colour, a terminal that
  never answers the background-colour query) run on BOTH platforms;
  `pty_run` and `screen_run` branch on `uname` (BSD `script` takes the log
  then plain argv; Linux takes `-qec "<command>"` with the log last).
  EVERY home-screen PTY test calls `fake_release_cache` and passes
  `XDG_CACHE_HOME=$FAKE_CACHE`: the screen asks the remotes on open, and an
  unmocked self-version check is seconds of curl before the remote subject
  settles.
  **The home screen is read from its frame dump, never from the raw
  capture**: Bubble Tea's renderer writes only changed cells, so text is
  split by cursor moves. `screen_run <name> <args>` runs it under `script`
  at `PTY_SIZE` (default 140x40; `stty` inside the pty) with
  `LOADOUT_SCREEN_DUMP=<name>.screen` (the current frame, plain, written
  atomically after every changed render; undocumented for users) and the
  raw output in `<name>.log` (for what isn't text: the alternate screen,
  OSC 11 background colours, a password never echoed, what is printed
  after the screen ends). **Key feeders wait on the frame, never on fixed
  sleeps**: `wait_settled <name>` (every subject in the sidebar shows its
  count; a busy one shows none, and the refresh starts before the first
  frame), `wait_frame <name> <ERE>…` (all in ONE frame) and `wait_done
  <name>` (the run panel's verdict). A frame passes by, so a feeder copies
  the one it waited for (`cp <name>.screen <name>.x`) and the test asserts
  on the copy; `frame_seen`/`fail_frame` read the current one. `pty_run`,
  `wait_screen` and `seen` stay for plain commands on a PTY (raw capture,
  escapes stripped). `fake_sudo` prompts on /dev/tty like the real one.
  Send ESC with a short sleep after it: ESC and the next key together read
  as alt+key. Short sleeps between keys that act synchronously are fine.

## CI / release

`.github/workflows/ci.yml`: ubuntu (`go vet` + unit tests, the binary,
integration, a cross-build of every release target) and macos (`go vet` +
unit tests, a release-flagged binary — CGO off, `-trimpath -ldflags='-s
-w'` —, integration against it). It runs on pushes to `master` and on pull
requests; the Go version comes from go.mod.
Runners differ from a desktop: Ubuntu's `/bin/sh` is dash ("not found", not
bash's "command not found"), and `TERM` is unset (Linux) or unusable
(macOS), so `pty_run` sets its own.
Reproduce the Linux job locally in an `ubuntu:24.04` container as a non-root user.
`release.yml` on `v*` tags: one ubuntu runner cross-compiles each target
(`CGO_ENABLED=0`, `-trimpath -ldflags='-s -w'`) and tars the binary alone
→ `loadout-<tag>-{linux-x64,linux-arm64,macos-arm64,macos-x64}.tar.gz`
attached to the GitHub Release. Nothing runs the linux-arm64 or macos-x64
binaries before release. It packages without testing: let CI pass before
tagging. **The version lives in ONE place**, `internal/version/version.go`'s
`var Version = "…"` (the binary's `--version`, the lock's `toolVersion`);
release.yml's first job refuses a tag that isn't `v<Version>`. A release =
bump that line, commit, tag.

`install.sh` (repo root) is the curl|sh bootstrap over those releases: it
resolves latest via the GitHub API (pin: LOADOUT_VERSION) and installs the
one binary to ~/.local/bin (LOADOUT_INSTALL_DIR); keep its target names in
sync with release.yml. An older loadout's `~/.local/share/loadout` (its
Kotlin DSL and Gradle plugin) is left as it was: install.sh never deletes
what it no longer installs. It reads the installed version BEFORE
overwriting, so an upgrade (including `loadout self-upgrade`, which shells
out to it) says "was vX" and skips the first-install "Next steps".
Testable offline via LOADOUT_DOWNLOAD_BASE=file://… against a local
tarball; run-tests.sh covers both paths on both platforms, staging one
stub tarball per release name so `install.sh` resolves the host's own
target (don't repeat that mapping in the test: a Rosetta shell says x86_64
where macos-arm64 is still right).

## Adding programs to a config repo — the recipe

The wiki's "Writing your manifest" is the user-facing long form. Match
top-down, first fit wins:

1. Standard package → `install_via = […]` listing ONLY installers where
   the claim is true (`install_via` is unverified; a false entry is a
   mappable lie). The named installer usually ships with loadout (`loadout
   installers`); declare one only to add a mechanism or replace a
   built-in.
2. Different package id → that installer's block with a pkg:
   `via "brew-cask" { pkg = "gcloud-cli" }`, `via "flatpak" { pkg =
   "md.obsidian.Obsidian" }`.
3. Special install command, same mechanism → that installer's block with
   `command = …`, so check/probe derive. Key by what it IS: a cask is
   `via "brew-cask" { … }`, not `via "brew" { … }`.
4. Prerequisite step (tap/repo/remote) → its own program + `depends_on`,
   never `&&`-chained into another program's command; on the variant when
   only that mechanism needs it. When EVERY program of a mechanism needs it
   (a pm's config, the flathub remote, a COPR's dnf-plugins-core), the
   installer `requires` it (`requires "flatpak" { programs =
   [program.flathub-remote] }`). When that step installs the installer's
   own tool (flatpak on a distro without it, Homebrew), its variant also
   has `provides "flatpak" {}` (plus `at = …` when it lands off PATH), or
   the plan refuses the missing probe before anything runs.
5. Repo-script install that lands in a pm's database → that pm's block
   with `installed_by = "…"`; check/probe derive; override `regex` for odd
   version formats. When several programs need the SAME shaped script (rpm
   repo + key + install, a brew tap), make it an installer with `params =
   [...]` and one `run_script(…)` pattern; the variants carry only their
   values (`via "brew-tap" { params = { tap = "owner/tap" } }`).
6. Truth not in a package db (dnf groups, virtual provides) → override the
   check (`version = "rpm -q --whatprovides …"`, a managing script, or
   `present = "…"` when there's no version), keep the rest derived.
7. No pm at all → `custom { installed_by = "x.sh" }` (or `command = …`) + a
   program-level `version = …`; `path = ["$HOME/.local/bin"]` when it lands
   off a fresh shell's PATH.
8. Nothing to "have" (dotfiles, services) → a `script` + check, run per
   machine. A *managing script* (`<file>` does the step, `<file> check`
   says whether it's done) is `managed_by = "x.sh"`. A step done
   differently per platform is one script with `variant "arch" { … }`s,
   picked by the machine.

Cross-cutting: no `||` chains or trailing pipes in checks; versions are the
mapped pm's truth (rpm's version, not the binary's self-report: expected,
not a bug); a repo script (`run_script`, `installed_by`, `managed_by`) for
every script file (existence checked at compile and load); plain values
over abstraction (contract 11). Verify loop: `explain` →
install it in a machine or profile → `loadout compile` → `setup-new-machine
--dry-run` → `status`.

Where the check lives: loadout never trusts "it ran once"; everything
converges against a re-askable check, declared where the truth lives via
the resolution chain (variant check → installer check → program
version). Program-install scripts are install-only: pm-keyed ones get the
pm-database check derived (recipe 5), pm-less ones fall back to version
(recipe 7). Only when neither holds the truth (dnf groups, recipe 6, and
every script, recipe 8) is there a hand-written check: an inline one-liner
or a managing script's `check` mode. A script file needs a check
mode only if it IS the truth's only oracle.

## Working agreements with the user

- **Everything works on Linux AND macOS** (the user runs both): the Go
  and the shell, in this repo and in config repos. macOS ships BSD tools:
  no `\|` alternation in a BRE (use `sed -nE` with `|`); `cat -A`, `sed -i`
  without an argument, `timeout` and GNU `readlink -f` are absent or
  different; `script` takes its arguments the other way round (see
  `pty_run`). BSD failures tend to be SILENT (a `sed` that matches nothing
  returns empty, not an error). Test here and reason about the other
  platform before claiming done.
- **Close your tmux test windows**: a real-terminal TUI check is `tmux
  new-window -d -n ldtest` + `send-keys` + `capture-pane`, then `tmux
  kill-window -t ldtest` before the task ends.
- After any phase/feature, end with a **"Try it"** section: exact commands,
  binary path, expected output.
- **Docs split**: README.md is the front door (concept, command table,
  quickstart, links); the GitHub **wiki** holds the guides (Home = concepts,
  Writing-Your-Manifest, A-Day-With-Loadout), cloned at ../loadout.wiki, a
  SEPARATE git repo with its own commits and pushes. **A change isn't done
  until the wiki has been re-read against it**: grep the pages for the
  screen text, keys and example output the change touches; the guides show
  rendered screens, and a stale one teaches the wrong thing. Same for README
  and this file. The wiki links into josemiguelo/.dotfiles as the live
  example, so renames there can break wiki links.
- **Wiki voice**: friendly, direct, concise, for a USER getting work done,
  not a contributor. Show an example wherever one fits (a screen or a
  `console` block). Don't narrate the obvious parts of the UI; reasons that
  are only true because of how loadout is built belong in THIS file.
- **Word every user-visible string for the final user.** Screen text, CLI
  output and the wiki say what to do or what happened, never why the
  implementation needs it: "a step needs your sudo password", not "sudo's
  cache is cold". Cache, stamp, mechanism, oracle, transaction are
  contributor words; they live here and in comments.
- The user prefers explicit over implicit in every design fork: no
  auto-detection, no fallbacks, no heuristics; errors over guesses. Propose
  designs before implementing when the user asks a question ("is this ok?"
  means assess first, don't jump to code).
