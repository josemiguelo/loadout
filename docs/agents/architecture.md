# Architecture

One Go module (`github.com/josemiguelo/loadout`, go.mod at the root), one
binary (`cmd/loadout`), everything else under `internal/`. Releases build
with CGO off for linux-x64, linux-arm64, macos-arm64 and macos-x64 from one
runner. The packages depend downwards: model ← assemble ← core and
hclconf; core ← app ← cli and tui; hclconf ← lsp ← cli: only cli
(`compile`) and lsp (the language server) import hclconf, and cli and tui
never import each other (they meet in app).

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
                   data and partial) only when changed; refuses a Kotlin repo.
                   readRepoFiles/repoFiles.assemble are its reading and
                   assembling, shared with Check
    analyze.go     for the language server: Analyze (every pass, never
                   stopping at a mistake; every declaration with where it
                   is, its variants or params, every diagnostic, the data
                   schema) and Check (what compile would refuse, writing
                   nothing, an editor's unsaved buffers over the disk)
    schema.go      ShapeOf: what each block may hold, built from the same
                   specs the decoder checks, plus what each attribute
                   takes; schema_test holds every spec attribute to a value
    hcltest/       ManifestOf for tests (TEST-ONLY)
  core/
    loader/        LoadRepo — reads the lock: missing/newer/stale/floor
                   refusals, file: paths re-checked; ReadLayout reads it
                   alone; ToolTooOld
    state/         StateStore — <state>/<machine>.json; pretty JSON, stable
                   order, WriteIfChanged; LastWarnings
    coremodel/     what the binary observes: MachineState and its parts, SystemInfo
    bun/           Ensure — the repo's pinned bun (`repo { bun = … }`): downloaded
                   by curl through the runner, checked against SHASUMS256.txt,
                   unpacked into $XDG_DATA_HOME/loadout/bun/<version>/ (the
                   -baseline build on x64 without AVX2); Asset, SumOf, Unpack,
                   Prune. LOADOUT_BUN_DOWNLOAD_BASE serves tests (file://)
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
               outdated/run/apply/diff/sync/init/compile, and the hidden
               lsp); root.go (bare
               invocation without a TTY prints help), home.go (starts the
               screen, prints what it ended with), style.go, table.go, spinner.go, help.go, errors.go
               (usage errors as loadout 3 printed them), converge.go;
               scaffold/ is `init`'s templates (go:embed). `self-upgrade`
               shells to version.InstallCommand and needs no repo, so it works
               under a min-tool-version refusal (which points at it)
  lsp/         `loadout lsp`, the manifests' language server over stdio:
               rpc.go (JSON-RPC framing), server.go (lifecycle, dispatch),
               workspace.go (the repo root, open buffers, debounced Check,
               diagnostics published per file), scan.go (where the cursor
               is: block path, key or value, the attribute, object keys),
               complete.go (what goes there: block types, attributes,
               nested blocks, references, flags, data keys, params,
               labels, variants), position.go (HCL <-> LSP positions,
               UTF-8 or UTF-16)
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

## Dependencies and encoding

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
