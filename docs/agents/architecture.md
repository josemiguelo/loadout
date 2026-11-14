# Architecture

TypeScript under `src/`, compiled by `bun build --compile` into one
executable per target (`package.json`'s build; release.yml for linux-x64,
linux-arm64, macos-arm64 and macos-x64, all cross-compiled from one Linux
runner). The executable carries its bun runtime, about 70–90 MB, and is
also the bun its manifests and scripts run with. Imports are relative,
with the `.ts` extension. The modules depend downwards: model ← assemble ←
core and compile; core ← app ← cli and tui; only cli (`compile`) imports
compile, and cli and tui never import each other (they meet in app).

```
src/
  main.ts      dispatch to cli's execute; LOADOUT_THEME checked first,
               LOADOUT_HANDOFF's SIGINT trap; every error -> "error: ..." +
               exit 1 (contract 9), Ctrl-C (InterruptedByUser) -> 130;
               imports tui, which registers the home screen
  version.ts   VERSION (the ONE place it's written), installCommand, atLeast
  model/       a config repo, resolved: what the lock holds and engines read
    refusal.ts     Refusal, the Error subclass every refusal extends (contract 9);
                   ManifestException, ToolTooOldException; isRefusal
    manifest.ts    Manifest and its types; resolveInstall/checkFor/
                   dependenciesOf/forMachine (variant × installer resolution),
                   shellLine (file: + PATH prefix), expandFilePrefix, scriptEntry
    lock.ts        Lock, encodeLock/decodeLock (format check), sourcesHash
    draft.ts       encodeDraft/decodeDraft: a manifest before assembly in the
                   lock's own shapes, what loadout.ts prints for compile
    codec.ts json.ts map.ts  the lock's JSON field by field, ordered JSON
                   (parseJSON, prettyJSON) and Map helpers: byte-identical to
                   loadout 3's output
    gostd.ts       Go's string order, unicode.IsSpace, path.Clean/Join and OS
                   error wording (goPathError), which every older loadout
                   wrote with
    fsys.ts        RepoFS: dirFS(root), mapFS({...}) for tests
    installerlibrary.ts  the built-in installers, as values
    chezmoidata.ts the templates' data file and partial (chezmoiPartial)
    machinedata.ts data merged, validated, compared; glob.ts: globMatches, globExpand
  assemble/    ManifestDraft -> Manifest: built-ins merged, installer
               requires applied, profiles flattened (contract 2), validated,
               file: paths checked through a RepoFS, maps sorted;
               installOrder/scriptOrder (ties by name). assembleWithoutFiles is
               TEST-ONLY. draftover.ts: a child's draft over its parent's
               (contract 18)
  compile/     `loadout compile`: the TypeScript manifests
    sdk/loadout.sdk.ts  the SDK (a text import), written into every repo
                   as loadout.sdk.ts: the manifest language, its references,
                   the language's own rules (fail(): file, line, column), the
                   draft repo() prints, include(), the import-graph sources
    sdk/loadout.script.ts  the script SDK, written beside it as
                   loadout.script.ts, imported as "loadout/script":
                   main/run (a managed script's check/install), oracle and
                   programOracle (outdated rows, Row/formatRow, update), env
                   (LOADOUT_*), clonesBehind/fastForward, Bun Shell helpers
    compile.ts     compile: refuses an HCL or Kotlin repo by name, writes both
                   SDKs, runs loadout.ts (and a child's parent as a parent)
                   with loadout as bun, decodeDraft, draftOver, assemble,
                   writes the lock (and, with configs, the chezmoi data and
                   partial) only when changed; doneScripts, writeIfChanged
    unused.ts      unusedWarnings, transitionalWarnings
  core/
    loader/        loadRepo: reads the lock: missing/newer/stale/floor
                   refusals, file: paths re-checked; readLayout reads it
                   alone; toolTooOld
    state/         StateStore: <state>/<machine>.json; pretty JSON, stable
                   order, writeIfChanged; lastWarnings
    coremodel/     what the binary observes: MachineState and its parts, SystemInfo
    bun/           the `bun` wrapper (see "loadout is the bun")
    exec/          ProcessRunner + ShellRunner; ALL process use goes through
                   it (tests use fakeexec). capture and inherit (sudo,
                   progress), each taking a ShellCommand (line, cwd, env), run
                   as `sh -c`; manifest commands build one through
                   CommandFrame (contract 5); exec.line is for
                   git/probes/self-version. A child killed by a signal reports
                   -1; Ctrl-C in a LOADOUT_HANDOFF child (a home-screen
                   run) rejects with InterruptedByUser once the child exits
    detect/        Detection: os/distro/hostname + binary availability (`command -v`)
    engine/        VersionChecker (concurrent checks), UpdateChecker (outdated
                   oracles; exit code deliberately ignored), InstallEngine
                   (plan/execute), upgradeengine.ts (planner only: which mechanisms
                   this machine can upgrade, one step per command, refusals;
                   `upgrade` runs and verifies, the home screen plans with it to
                   describe steps and refuse early), ScriptRunner, ConfigEngine
                   (chezmoi over the repo's configs dir: units, drift, edited
                   files, the apply command; contract 17), StatusEngine
                   (observes programs, scripts AND configs; all checks
                   concurrent, at most 8, read-only), sudo.ts (commandNeedsSudo,
                   the keepalive), text.ts (goRegExp: a manifest's RE2 regex
                   as a JS RegExp), errors.ts (the engines' refusals)
    diff/          the diff engine: pure, manifest × states -> DiffReport
    git/           GitClient: shells out to `git`, cwd = repo root
    platform/      hostname, isStdoutTty, uname, nowIso, envVar,
                   selfExecutable, terminalRows/Columns,
                   terminalBackgroundLuma (OSC 11; termios.ts through bun:ffi),
                   trapInterrupts/takeInterrupt; clock.ts: nanosecond wall
                   time (clock_gettime through bun:ffi)
    coretest/      manifestOf/example for core's tests (TEST-ONLY)
  app/         what the CLI and the home screen share: AppContext (shared
               services, refreshAndWriteState; loadManifest() is the lock as
               this machine sees it; reloadLayout), outdatedReport,
               explain (explain's answer as data: the CLI prints it, the
               home screen's inspector shows it), runCommand (the child
               loadout a home-screen run starts), the self-version check
               (latestRelease: status footer, 6h cache, fail-soft;
               outdated's self-row, fresh), and screen.ts: the Screen
               interface (run → Ended), HomeAction, Handoff, closedCommand
               (what a confirmed action runs), registerScreen/newScreen
  cli/         one file per subcommand (status/explain/installers/
               setup-new-machine/install/upgrade/self-upgrade/outdated/run/
               apply/diff/sync/init/compile/bun); args.ts (the command line:
               commands, flags, help, in cobra's and pflag's behaviour),
               root.ts (bare invocation without a TTY prints help), home.ts
               (starts the screen, prints what it ended with), style.ts,
               table.ts, spinner.ts, help.ts, errors.ts (usage errors as
               loadout 3 printed them), converge.ts; scaffold.ts embeds
               scaffold/, `init`'s templates. `self-upgrade` shells to
               installCommand and needs no repo, so it works under a
               min-tool-version refusal (which points at it)
  theme/       Tokyo Night / Day palettes, detectDarkTerminal, forcedDark
  tui/         the home screen; registers itself with app.registerScreen.
               homemodel.ts (ALL state + the domain-facing builders, no
               rendering), keys.ts (reducers, dialogs, toasts), lists.ts
               (each subject's list, filter), runs.ts (the run panel's
               lifecycle), inspect.ts, view.ts (layout + rendering),
               program.ts (the loop, keys/mouse, the screen dump), jobs.ts
               (background checks), renderer.ts (frames on the alternate
               screen), input.ts (the tty's bytes as keys, pastes, mouse),
               tea.ts and key.ts (messages, commands and key bindings)
    style/     the look: Charmtone themes, rows, dialogs, toasts, the busy
               clock; lipgloss.ts writes Lip Gloss v2's bytes, pinned by
               testdata/golden.json
    term/      the run panel: one command in a PTY (Bun.Terminal), its
               screen kept by @xterm/headless
```

## Dependencies and encoding

- **bun, per package.json's `packageManager`** (CI and releases read it).
  The bun that builds a release is the bun that release's scripts run with:
  bumping it is a user-visible change. One runtime dependency,
  `@xterm/headless`; ask before adding another. No `Bun.spawn` outside
  core/exec and tui/term.
- **Linux binaries link glibc** (bun's runtime does): no musl targets.
  macOS binaries come out of the cross-compile ad-hoc signed.
- **Outputs are byte-identical to loadout 3's**: the lock, state files,
  `.chezmoidata/loadout.json` and the partial are written field by field in
  kotlinx's order and format (model/codec.ts, json.ts, core/state/codec.ts:
  key order, defaults dropped, only JSON's required escapes, a `number`
  written as Kotlin's Double: `1.0`), so a 3.x or 4.x lock and state file
  decode and re-encode to the same bytes (the `testdata/` files) and a
  fleet mixing versions commits no noise. Keep it that way when adding a
  field. Help and usage errors are likewise laid out as loadout 3's
  (Clikt's) were (help.ts, errors.ts).
- **The lock always says its format**: defaults are dropped, but
  `encodeLock` writes `format` always; without it an old binary couldn't
  refuse a newer lock by name.

## Conventions

loadout 4 was Go; 5.0 is the same program in TypeScript, and its files,
names and tests kept the Go packages' shape. Where JavaScript behaves
differently from what older loadouts wrote (sort order, whitespace, paths,
OS error wording, nanosecond timestamps), src keeps the old behaviour on
purpose.

- **Plain data**: interfaces built with `newProgram({...})`,
  `newManifest`, … (unset fields at their zero value), copied with spreads,
  never mutated once shared. Operations are functions taking the value
  first (`resolveInstall(m, p, k)`, `forMachine(m, h)`). An optional field
  is `undefined` when unset; arrays are always present, except
  `ScriptStep.modes` (undefined = default, `[]` = empty, refused).
- **Maps are JS `Map`s** (insertion order is the output's order); helpers
  in model/map.ts. Sort with `compareStrings`/`sortStrings` (model/gostd.ts:
  UTF-8 byte order), never bare `.sort()`.
- **JSON**: `JSONValue` = null | boolean | string | `JSONNumber` (the
  literal) | array | `JSONObject` (a `Map`). `parseJSON` keeps key order and
  number literals (JSON.parse loses both); `prettyJSON` is the only writer
  of the lock, state and chezmoi files, and takes a JS number only as an
  integer (a Kotlin Double is `kotlinDouble(f)`). `ObjWriter`/`ObjReader`
  (codec.ts) are the field-by-field codec for other files (core/state).
- **Files** go through `RepoFS` in model and assemble. OS errors are
  wrapped with `goPathError(e, op?, path?)`: "open /x: permission denied",
  "read /x: is a directory". Warnings and `error: ` lines that carry one
  depend on it.
- **Refusals** extend `Refusal` and are thrown; a new refusal joins
  loader.test.ts's "every loadout failure reports as a clean one-liner"
  list.
- **Processes are async**: `capture(cmd): Promise<ExecResult>`,
  `inherit(cmd): Promise<number>`; the only rejection is
  `InterruptedByUser`. Anything that runs a command is async in turn; file
  work stays synchronous and throws. fakeexec:
  `newRunner().onCommand(line, exit(n), stdout(s), stderr(s))`,
  `received()`, `executed()`; a call is recorded when it is made, and an
  unregistered line exits 127.
- **Laziness**: AppContext computes layout, state store, parent root,
  parent store and configs on first use (a `Lazy` per value), and every
  later use gets that value or throws that error again; `reloadLayout()`
  drops them all at once.
- **`undefined` vs `[]`** stay apart where the API tells them apart:
  `InstallEngine.plan(requested)` (undefined = nothing asked),
  `ConfigEngine.edited(targets)` and `applyCommand(targets)` (undefined =
  every target, `[]` = none).
- **Regexes** from manifests (version, oracle) go through `goRegExp`: RE2
  syntax read as a JS RegExp, a leading `(?i)`/`(?s)`/`(?m)` as flags,
  `\A`/`\z` as anchors; one that doesn't compile matches nothing.
- **Timestamps** come from `platform.nowIso()` (9 fraction digits), never
  `new Date().toISOString()`.
- **The command line** is args.ts, no dependency: cobra's and pflag's
  behaviour (interspersed flags, `--`, `-abc`, `-f=v`, persistent flags)
  with Clikt's error words. A command is `subcommand(name,
  commandHelp(…), args, run)` plus `boolFlag`/`stringFlag`/`stringsFlag`;
  a `passArgs` command (`loadout bun`) gets every argument after its name
  as it is. Writes go through `echo`/`echoErr` (spinner.ts), synchronous on
  fds 1 and 2.
- **The scaffolds and SDKs are text imports** (`import t from "…" with {
  type: "text" }`), inlined by `bun build --compile`. scaffold.test.ts
  checks scaffold.ts's table against the folder: a file added there is
  added to the table too. tsconfig maps `loadout`/`loadout/script` to the
  SDKs, so tsc checks the scaffolds' .ts files. bun's build warns about the
  child scaffolds' templated tsconfig.json (`{{.ParentImport}}/*`):
  harmless.

## loadout is the bun

- **core/bun is the wrapper**: `wrapperDir()` writes `bun` (`#!/bin/sh` +
  `BUN_BE_BUN=1 exec '<process.execPath>' "$@"`, with `--preload
  <folder>/.preload.js` when it runs a file) and that preload into
  `$XDG_DATA_HOME/loadout/bin` (else `~/.local/share/loadout/bin`) when
  missing, not executable or different, through a temp file and a rename.
  `ensure()` is that folder, unless `$LOADOUT_BUN` names a bun binary: then
  it's that binary's folder and nothing is written. `AppContext.bunDir()`
  (once per process) feeds it to `frameOf`, which puts it first on PATH and
  sets `LOADOUT_BUN_DIR`; `model.shellLine` puts it ahead of a `provides …
  at` folder.
- **compile runs loadout.ts in a child process**, loadout as bun, with a
  cleared environment plus that folder first on PATH: isolation and
  determinism, not in-process.
- **No pin**: every repo runs the bun this loadout was built with
  (`Bun.version`). `RepoSpec.bun` is `never` in the SDK and `repo()` fails
  where it's called; a lock that still carries `meta.bun` is refused as an
  unknown key, and the compile it asks for meets the SDK's refusal.
- **`loadout bun [args…]`** (cli/bun.ts) runs the wrapper (never
  `$LOADOUT_BUN`) with stdio inherited, exits with its code, and needs no
  repo.
- **`BUN_BE_BUN` must not reach what a script starts**: bun leaves it set,
  so loadout itself, or any bun-compiled executable a script runs, would
  act as bun. The preload (`delete process.env.BUN_BE_BUN`) drops it when
  bun runs a file (`bun x.ts`, a shebang, `bun run x.ts`). Not through
  `BUN_OPTIONS`: a `--preload` there makes every subcommand parse as `bun
  run` (`bun install` becomes "Script not found"). Other subcommands (`bun
  test`, `bun install`'s lifecycle scripts) still pass it on.

## The home screen's machinery

- **Its own renderer** (tui/renderer.ts): the alternate screen, changed
  rows only, synchronized output, the command's cursor. Not Ink: Ink
  re-tokenizes every styled cell of a frame on each render (60–130 ms for
  140×40) and the busy spinner redraws twelve times a second, which kept
  the screen at a full core and made the run panel answer a command's
  terminal queries too late (sudo read the late replies as a password).
- **Width is the hot path**: `stringWidth`/`strip` (style/ansi.ts) skip
  segmentation for styled ASCII and symbol-only text; about 1.5 ms for a
  197×51 frame.
- **What a reducer asks of the engines is a promise** (explain, the
  configs' `edited`, the install plan): `later(m, value, then, failed)`
  finishes the reducer at once when the answer is already there (tests'
  fakes), else queues a command whose message the program applies.
- **State is replaced, never mutated in place**: sets are `Set`s,
  per-subject maps `Map`s (`withKeys`, `without`, `withValue`); a Dialog or
  Inspector is copied before it changes.
