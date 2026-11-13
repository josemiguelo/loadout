# The TypeScript port (in progress, part of 5.0)

loadout is being rewritten in TypeScript, compiled by bun into one
executable per target. The Go code (`cmd/`, `internal/`) stays as the
reference until the TypeScript binary passes everything; then it's deleted.
Read this before porting any package.

## Build, run, test

```sh
bun install                                   # deps (ink, react, @xterm/headless; types, typescript)
bun run build                                 # build/loadout-ts, this host's executable
bun test src                                  # unit tests (*.test.ts beside the code)
bunx tsc --noEmit -p .                        # types
./integration/run-tests.sh build/loadout-ts [pattern]   # the black-box suite: THE gate
go build -o build/loadout ./cmd/loadout       # the Go reference, for differential runs
```

Cross-compile: `bun build --compile --target=bun-<linux-x64-baseline|linux-arm64|darwin-arm64|darwin-x64> src/main.ts`.

## The design

- **Sequencing:** until the TypeScript binary reaches parity, the port
  reproduces the Go code as it is, the bun download (`core/bun`), the repo
  pin (`repo({ bun })`, `meta.bun`) and the outdated bun row included, so
  differential runs against the Go binary stay exact. The design below is
  the cutover step, done after parity, in one change.
- **One executable, and it is the bun** (the cutover step). Manifest commands get a folder
  first on PATH holding a `bun` wrapper (`BUN_BE_BUN=1 exec <loadout>
  "$@"`): a compiled bun executable with `BUN_BE_BUN=1` behaves as the bun
  CLI, so scripts (`#!/usr/bin/env bun`) and compile's run of loadout.ts use
  loadout itself. No bun download, no `repo({ bun })` pin, no outdated bun
  row: every repo runs the bun this loadout was built with (`Bun.version`).
  `$LOADOUT_BUN` (a bun binary) still overrides it, for tests.
- **compile runs loadout.ts in a child process** (loadout as bun), with a
  cleared environment, exactly as `internal/tsmanifest` does: isolation and
  determinism, not in-process.
- **The SDKs** are `internal/tsmanifest/sdk/loadout.sdk.ts` and
  `loadout.script.ts` until the Go code goes; the app imports their text
  (`import SDK from "…/loadout.sdk.ts" with { type: "text" }`) to write them
  into repos.
- **The home screen** draws its frames itself (src/tui/renderer.ts: the
  alternate screen, changed rows only, synchronized output, the command's
  cursor) and reads the tty itself (src/tui/input.ts). Not Ink: Ink
  re-tokenizes every styled cell of a frame on each render (60–130 ms for
  140×40) and the busy spinner redraws twelve times a second, which kept the
  screen at a full core and made the run panel answer a command's terminal
  queries too late (sudo read the late replies as a password). Ink and React
  stay dependencies until the cutover decides on them. Its run panel runs a
  command in a PTY (`Bun.spawn({ terminal })` / `Bun.Terminal`) and keeps
  the screen in `@xterm/headless`. `react-devtools-core` is stubbed
  (src/stubs, tsconfig paths) so Ink bundles.

## Layout: one folder per Go package

| Go | TypeScript |
|---|---|
| `internal/version` | `src/version.ts` |
| `internal/model` | `src/model/` |
| `internal/assemble` | `src/assemble/` |
| `internal/tsmanifest` | `src/compile/` |
| `internal/core/<pkg>` | `src/core/<pkg>/` |
| `internal/app` | `src/app/` |
| `internal/cli` (+ scaffold/) | `src/cli/` (+ scaffold/) |
| `internal/theme` | `src/theme/` |
| `internal/tui`, `tui/style`, `tui/term` | `src/tui/`, `src/tui/style/`, `src/tui/term/` |
| `cmd/loadout/main.go` | `src/main.ts` |

A Go file becomes the TypeScript file of the same name (`manifest.go` →
`manifest.ts`, `statusengine.go` → `statusengine.ts`); its `_test.go` becomes
`<name>.test.ts` (bun test), with the same test names in words. Exported Go
names become camelCase (`ResolveInstall` → `resolveInstall`), types keep
PascalCase. Imports are relative, with the `.ts` extension. Doc comments
carry over: they record why, and the repo's style (AGENTS.md) applies.

## Rules

- **Behaviour is the Go code's, exactly.** Every message, exit code,
  ordering and edge case. When unsure, run the Go binary and compare.
- **Outputs are byte-identical**: the lock, state files,
  `.chezmoidata/loadout.json` and the partial, as `internal/model`'s writer
  makes them (`PrettyJSON`, its quoting, `KotlinDouble`, insertion order).
  The `testdata/` files are golden tests.
- **Ordered maps**: Go's `model.Map` (insertion-ordered) is a JS `Map<string,
  V>`; keep its helpers (`Plus`, `MapValues`, …) as functions in
  `src/model/map.ts`.
- **All process use goes through `ProcessRunner`** (src/core/exec): `capture`
  and `inherit` of a `ShellCommand` (line, cwd, env), `sh -c` like Go's; a
  fake runner (src/core/exec/fakeexec) for tests. No `Bun.spawn` elsewhere,
  except the PTY in tui/term.
- **Errors**: `Refusal` (an `Error` subclass) and its kinds
  (`ManifestException`, `ToolTooOldException`, …); src/main.ts prints any
  error as one `error: ` line, exit 1; Ctrl-C exits 130 (contract 9).
- **Dependencies**: ink, react, @xterm/headless only. Ask before adding one.
- **Linux and macOS**, as AGENTS.md's working agreements say.

## The model in TypeScript

- **Plain data**: interfaces built with `newProgram({...})`, `newManifest`,
  … (unset fields at Go's zero value), copied with spreads, never mutated
  once shared. Go methods are functions taking the value first
  (`resolveInstall(m, p, k)`, `forMachine(m, h)`, `scriptVariant(s, v)`).
  A Go pointer is an optional field (`undefined` = nil); a slice is an
  array, always present, except `ScriptStep.modes` (undefined = default,
  `[]` = empty, refused).
- **Maps** are JS `Map`s (`set` keeps a key's place, as Go's did); helpers
  in `src/model/map.ts`. Sort with `compareStrings`/`sortStrings`
  (src/model/gostd.ts, Go's byte order), not bare `.sort()`; Go's
  `unicode.IsSpace`, `path.Clean`/`Join` are there too.
- **JSON**: `JSONValue` = null | boolean | string | `JSONNumber` (the
  literal, as `json.Number`) | array | `JSONObject` (`Map`). The writer takes
  a JS number only as an integer; a Kotlin Double is `kotlinDouble(f)`.
  `parseJSON` keeps key order and number literals (JSON.parse loses both)
  and words errors as Go's decoder; `prettyJSON` is the only writer of
  the lock, state and chezmoi files. `ObjWriter`/`ObjReader` (codec.ts)
  are the field-by-field codec for other files (core/state).
- **Files** go through `RepoFS` (src/model/fsys.ts, Go's `fs.FS`):
  `dirFS(root)`, `mapFS({...})` for tests.
- **Refusals** extend `Refusal` (src/model/refusal.ts) and are thrown;
  `isRefusal(e)` is Go's `err.(model.Refusal)`.

## Core in TypeScript (what the engines build on)

- **Processes are async**: `ProcessRunner.capture(cmd): Promise<ExecResult>`,
  `inherit(cmd): Promise<number>`; `success(r)` is Go's `r.Success()`. Go's
  `(result, err)` is the awaited value, and the only rejection is
  `InterruptedByUser` (a Refusal, "interrupted"), so the result of an
  interrupted capture is gone: Go's callers returned the error anyway.
  Anything that runs a command is async in turn (`Detection.isBinaryAvailable`,
  every `GitClient` method, `bun.ensure`); file work stays synchronous
  (`StateStore`, `loader`, `writeIfChanged`) and throws.
- **`ShellCommand`** is `{ line, cwd, env? }`: `env` a plain
  `Record<string, string>` (Go's unordered map), `undefined` = nil.
  `exec.line(l, dir)` for plain lines; manifest commands through
  `frameOf(...)` → `CommandFrame` (a class: `frame.command(line, origin)`,
  `frame.cwd(origin)`), `newCommandFrame` for tests.
- **fakeexec**: `newRunner().onCommand(line, exit(n), stdout(s), stderr(s))`,
  `received()`, `executed()`; a call is recorded when it is made, so
  concurrent checks record in call order. Unregistered lines exit 127.
- **Go's `New…` constructors** are `new…` functions (`newShellRunner`,
  `newDetection`, `newGitClient`, `newStateStore`) beside the exported
  classes; a Go nil pointer return is `undefined` (`StateStore.read`).
- **OS errors read as Go's**: wrap node's with `goPathError(e, op?, path?)`
  (src/model/gostd.ts): "open /x: permission denied", "read /x: is a
  directory", "mkdir …", "rename /a /b: …". Warnings and `error: ` lines
  that carry an OS error depend on it.
- **diff's kinds** are string unions (`"unknown" | "installed" |
  "missing"`, `"unknown" | "applied" | "drifted"`), with Go's constant names
  as constants; a `ConfigCell.files` is 0 unless drifted.
- **The engines' refusals** (`ResolutionException`, `UpgradeException`,
  `ConfigException`, src/core/engine/errors.ts) are in
  src/core/loader/loader.test.ts's "every loadout failure reports as a clean
  one-liner" list; a new refusal joins it.
- **Timestamps** come from `platform.nowIso()` (9 fraction digits, as Go
  wrote them). Never `new Date().toISOString()`.

## The engines in TypeScript (what the app builds on)

`src/core/engine/index.ts` exports them all (`import * as engine from …`).

- **Classes for what holds a runner** (`VersionChecker`, `UpdateChecker`,
  `ScriptRunner`, `InstallEngine`, `StatusEngine`, `ConfigEngine`, each with
  a `new…` constructor); **functions for the planners and data**
  (`planUpgrade`, `planSourceItems`, `planProgramUpgrades`,
  `upgradableInstallers`, `commandFor`, `withArgs`, `commandNeedsSudo`,
  `sudoValid`, `startSudoKeepalive`, `unitOf`). Go's methods on data are
  functions: `InstallOutcome.Success` is `outcomeSuccess(o)`,
  `UpgradeStep.Label` is `stepLabel(s)`, `ToolDown.Message` is
  `toolDownMessage(t)`. Everything that runs a command is async; the
  planners that don't are synchronous and throw their refusal.
- **`PlanItem`** is a union tagged by `kind`: `"install"` (InstallItem) or
  `"installed"` (InstalledItem); both have `program` (Go's ProgramName()).
  `installs(plan)` is the InstallItems.
- **`InstallEngine.plan` is async** and its `binaryAvailable` may return a
  promise (`Detection.isBinaryAvailable`), asked one at a time in Go's order.
- **Go's nil vs empty slices** stay apart where the Go code tells them
  apart: `plan(requested)` (undefined = nothing asked; with nothing mapped
  either, Go's nil ordered every program), `ConfigEngine.edited(targets)`
  and `applyCommand(targets)` (undefined = every target, `[]` = none). Pass
  `undefined` where the Go caller passed nil.
- **Zero values that were structs** are optional: `InstallOutcome.stateAfter`
  (unset when skipped), `ScriptOutcome.state` (unset when `alreadyDone`).
  `InstallOutcome.skippedFor` is `""` when it ran.
- **`StatusEngine.refreshParts`**: programs, configs and scripts run side by
  side (promises; checks bounded at 8 by `limiter`), each `Part` emitted as
  it lands, with the other subjects' fields empty; a part's failure is its
  `err`, and the refresh rejects with the first of programs', configs',
  scripts' errors once all are in, as Go did. `Part.kind` is `"programs" |
  "scripts" | "configs"` (`partPrograms`, …). `lastScriptDetail()` is a `Map`.
- **Regexes** (version, oracle) go through `goRegExp` (engine/text.ts): RE2
  syntax read as a JS RegExp, a leading `(?i)`/`(?s)`/`(?m)` as flags,
  `\A`/`\z` as anchors; one that doesn't compile answers nothing, as Go's
  did. The app's batch-oracle regex (app/outdated.go) uses it too.

## The app in TypeScript (what the CLI and the home screen build on)

`src/app/index.ts` exports it all (`import * as app from …`).

- **`AppContext`** (a class; `newApp(repo, machine, verbose)` is Go's
  `app.New`, `newAppWith(…, runner, detection)` for tests): readonly
  `repoRoot`, `machineOverride`, `verbose`, `runner`, `detection`. Go's
  `(T, error)` methods return T and throw. Synchronous: `layout()`,
  `stateStore()`, `parentRoot()`, `configs()` (undefined = none),
  `hasConfigs()`, `fleetStates()`, `fleetWarnings()`, `loadManifest()`,
  `detectSystem()`, `canonicalRoot()`, `lastConfigsDown()`,
  `lastScriptDetail()` (a `Map`, empty before any refresh),
  `lastToolsDown()`. Async (they run commands): `bunDir()`, `frame(system)`,
  `statusEngine(system)`, `binaryAvailable(b)`,
  `refreshAndWriteState(manifest, system, scriptResults)`,
  `refreshAndWriteStateParts(…, onPart)`, `explain(names)`,
  `outdatedReport(manifest, system, observed, freshSelfCheck)`.
  `runCommand(closed)`, `selfArgv(self, …args)` stay synchronous.
- **Laziness is Go's `sync.Once`**: layout, state store, parent root,
  parent store, configs and the bun folder are computed on first use, and
  every later use gets that value or throws that error again (a `Lazy`
  per value; `bunDir`'s is the one promise everyone awaits).
  `reloadLayout()` drops them all at once.
- **`explain` throws `NoSuchItemError`** for an unknown name; its
  `explained` is what came before it (Go returned both): print that, then
  the `error: ` line. `ExplainRow.machine` is `""` unless it's this
  machine's variant.
- **`runCommand` is a `ChildCommand`** (`{ argv, cwd?, env? }`, Go's
  exec.Cmd), which tui/term's `TermCommand` takes as it is; `undefined` =
  nothing to run; `HandoffException` when loadout can't find its binary.
- **The screen meets the CLI here**: `HomeAction`/`PaneKind` are Go's iota
  numbers as constants (`ActionHandOff`, `PaneInstall`, …); `Closed` is
  `{ action, handoff? }` and `closedCommand(c)` (Go's `Closed.Command`) is
  `{ name, args } | undefined`. Go's `var NewScreen` is
  `registerScreen(factory)` (the tui module calls it when imported),
  `hasScreen()` and `newScreen(app)`; `Screen.run()` resolves to
  `Ended { message, code }`.
- **Self-version**: `latestRelease`, `latestBun`, `behindRelease` are async
  (curl through the runner), the 6h cache in `$XDG_CACHE_HOME/loadout`.
  `home()` is Go's `app.Home()`, `shQuote` Go's `ShQuote`.

## The CLI in TypeScript (what the remaining commands build on)

- **The command line is cobra's, rewritten** (src/cli/args.ts, no
  dependency): `Command` (name, help, args, opts, `validateArgs`, `run`,
  `persistentPreRun`), `find` (cobra's Find, persistent flags skipped with
  their values), `parseFlags` (pflag: interspersed, `--`, `-abc`, `-fv`,
  `-f=v`, bools' `=value`), `executeCommand` (flag error, help, not
  runnable → help, the args' check, persistentPreRun, run, in that order).
  Errors keep pflag's words there; errors.ts's `flagError` turns them into
  Clikt's, as Go did. A command is `subcommand(name, commandHelp(…), args,
  run)` plus `boolFlag`/`stringFlag`/`stringsFlag` (help.ts); `run` gets
  `(cmd, args, flags)`, flags read as `flags.bool("yes")`,
  `flags.string(…)`, `flags.strings(…)`, `flags.changed(…)`. The hidden
  `no-help-command` stays (it shows its help, as Go's); cobra's
  `__complete` doesn't.
- **Writes go through `echo`/`echoNoNewline`/`echoErr`** (spinner.ts),
  synchronous on fds 1 and 2 (`streams`, swapped by tests); `spinning(msg,
  async work)` draws from a timer, so the work must be async to animate.
- **`UsageError`/`usageErr`, `ExitError`/`exitWith`** are thrown;
  src/main.ts reports them as cmd/loadout/main.go did.
- **The commands take app's `AppContext`** (`appCtx()` in root.ts, built
  by the root's persistentPreRun as Go's `app.New`). `ensureBun(a,
  manifest)` (spinner.ts) gets the repo's pinned bun before a command runs
  manifest commands. converge.ts is the program half of `install` and
  `setup-new-machine`. Bare `loadout` on a terminal starts the screen
  through `app.newScreen` (home.ts) once src/tui registers one; until
  src/main.ts imports `./tui/index.ts`, it refuses (Go printed help when
  no screen was linked in).
- **The scaffolds** are imported as text from internal/cli/scaffold
  (src/cli/scaffold.ts, checked against the folder by scaffold.test.ts).
  tsconfig maps `loadout`/`loadout/script` to the SDKs, because tsc follows
  those imports into the scaffolds' .ts files and type-checks them. bun's
  build warns about the child scaffold's templated tsconfig.json
  (`{{.ParentImport}}/*`): harmless.

## The home screen in TypeScript

- **Go's architecture, kept**: `HomeModel` (homemodel.ts) is the state and
  the seams (`runCommand`, `newTerm`, `explain`, `now`); Go's methods are
  functions taking the model first, in the files Go had them in
  (`handleKey`/`handleText` in keys.ts, `runExited`/`followUp`/`confirm` in
  runs.ts, `inspect` in inspect.ts, `screenLines` in view.ts, `key`/`click`/
  `wheel` in program.ts); the pure builders (`sectionsOf`, `remoteLines`,
  `listOf`, …) are unchanged. homemodel.test.ts is homemodel_test.go, case
  for case.
- **State is plain and replaced, never mutated in place**: Go's sets are
  `Set`s, its per-subject maps `Map`s (`withKeys`, `without`, `withValue`);
  the remote status is a tagged union (`asking`, `unavailable(reason)`,
  `newAnswered({…})`); a Dialog or Inspector is copied before it changes.
- **What Go asked synchronously is a promise here** (explain, the configs'
  `edited`, the install plan): `later(m, value, then, failed)` finishes the
  reducer at once when the answer is already there (tests' fakes), else
  queues a command whose `ThenMsg` the program applies. The inspector opens
  when explain answers.
- **The program** (program.ts) is Bubble Tea's loop: `send(msg)` updates,
  starts the commands, then redraws once per burst (`setTimeout(0)`).
  Background jobs are promises (jobs.ts); `post` and the final answer land
  through `notify`. Input: input.ts decodes the tty's bytes as ultraviolet
  does (control bytes are ctrl+key, ESC+key alt+key, a lone ESC in its read
  esc, CSI/SS3 keys with xterm modifiers, kitty CSI u, bracketed paste as one
  `PasteMsg`, SGR mouse), and `keyString` is Bubble Tea's `Key.String` for
  key.ts's bindings. The terminal gets mouse cell motion (1002+1006),
  bracketed paste and the window title, as Bubble Tea set them.
- **Frames are Go's**: the same bytes per row (style is Lip Gloss's), so a
  tmux `capture-pane -e` of both binaries at the same size is identical; the
  screen dump is Go's (stripped, trailing spaces trimmed, written atomically
  when it changes).
- **Width is the hot path**: `stringWidth`/`strip` (style/ansi.ts) skip
  segmentation for styled ASCII and for symbol-only text, where every code
  point is its own grapheme; ~1.5 ms a 197×51 frame, ~4% CPU while a run
  spins.

## Status

| Part | State |
|---|---|
| skeleton, build, Ink + xterm in a compiled binary | done |
| model, assemble, coremodel, coretest, version | done: Go tests ported; every testdata and real lock re-encodes byte for byte (src/model/differential.test.ts) |
| core/platform | done (termios through bun:ffi for the OSC 11 query) |
| core (exec + fakeexec, detect, git, loader, state, diff, bun wrapper) | done: Go tests ported; state's testdata re-encodes byte for byte; nowIso reads nanoseconds (clock_gettime through bun:ffi), as Go's time.Now |
| compile (tsmanifest) | done: Go tests ported; byte-identical to the Go binary (lock, chezmoi data, partial, SDKs, warnings, refusals) on the dotfiles, `init`/`init --configs` scaffolds and child repos. `src/compile/devcompile.ts` (the differential driver) goes at cutover |
| engines (core/engine) | done: Go tests ported (88, same names), plus text.test.ts for the port's own helpers (goRegExp, forEach) |
| cli: style, table, spinner, help, errors, the command line (args.ts), init + scaffolds, compile, main.ts | done: Go tests ported (cli_test.go's), plus args/scaffold tests; help screens, usage errors, `init` (plain, --configs, --parent) and `compile` byte-identical to the Go binary (styled on a terminal too); 10-init passes |
| app | done: Go tests ported (run, screen; same names), plus context.test.ts for what Go left untested (laziness and reloadLayout, the outdated ordering, explain, the self-version cache) |
| cli's other commands (status, explain, installers, setup-new-machine, install, outdated, run, apply, diff, sync, upgrade, self-upgrade, the home screen's entry) | done: every integration file but 70-home-screen passes against build/loadout-ts (55-configs up to its home-screen part); `status --json`, `status`, `explain`, `diff`, `outdated`, `setup-new-machine --dry-run`, `install --dry-run`, `upgrade --dry-run`, `installers` byte-identical to the Go binary on the dotfiles (styled on a terminal too, spinner frames aside); `src/cli/context.ts` is gone. cli_test.go was already ported; converge.test.ts adds the plan table, install tallies and sync's summary. src/main.ts imports src/tui/index.ts, which registers the screen |
| theme, tui/style, tui/term (+ src/tui/tea.ts, key.ts: the Bubble Tea and bubbles/key slices they use) | done; style's bytes pinned to Lip Gloss's by testdata/golden.json |
| tui (the home screen) | done: homemodel_test.go ported (66 cases, same names); 70-home-screen, 71-terminal and 55-configs pass against build/loadout-ts; frames and colours identical to the Go binary's in tmux (wide and stacked, dialogs, the palette, a finished run) |
| release (workflow, install.sh unchanged names), docs, Go removed | — |
