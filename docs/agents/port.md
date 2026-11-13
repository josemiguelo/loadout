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

- **One executable, and it is the bun.** Manifest commands get a folder
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
- **The home screen** is Ink (React for the terminal). Its run panel runs a
  command in a PTY (`Bun.spawn({ terminal })` / `Bun.Terminal`) and keeps the
  screen in `@xterm/headless`, drawn inside Ink. `react-devtools-core` is
  stubbed (src/stubs, tsconfig paths) so Ink bundles.

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
- **Until src/app exists**, `src/cli/context.ts` (`CliContext`, `appCtx()`
  in root.ts) is the slice init and compile need; it goes when app lands.
  Every command not yet ported has its file with Go's help, flags and
  arguments, and runs `notPorted(…)`: fill in its run.
- **The scaffolds** are imported as text from internal/cli/scaffold
  (src/cli/scaffold.ts, checked against the folder by scaffold.test.ts).
  tsconfig maps `loadout`/`loadout/script` to the SDKs, because tsc follows
  those imports into the scaffolds' .ts files and type-checks them. bun's
  build warns about the child scaffold's templated tsconfig.json
  (`{{.ParentImport}}/*`): harmless.

## Status

| Part | State |
|---|---|
| skeleton, build, Ink + xterm in a compiled binary | done |
| model, assemble, coremodel, coretest, version | done: Go tests ported; every testdata and real lock re-encodes byte for byte (src/model/differential.test.ts) |
| core/platform | done (termios through bun:ffi for the OSC 11 query) |
| core (exec + fakeexec, detect, git, loader, state, diff, bun wrapper) | done: Go tests ported; state's testdata re-encodes byte for byte; nowIso reads nanoseconds (clock_gettime through bun:ffi), as Go's time.Now |
| compile (tsmanifest) | done: Go tests ported; byte-identical to the Go binary (lock, chezmoi data, partial, SDKs, warnings, refusals) on the dotfiles, `init`/`init --configs` scaffolds and child repos. `src/compile/devcompile.ts` (the differential driver) goes at cutover |
| engines (core/engine) | done: Go tests ported (88, same names), plus text.test.ts for the port's own helpers (goRegExp, forEach) |
| cli: style, table, spinner, help, errors, the command line (args.ts), init + scaffolds, compile, main.ts | done: Go tests ported (cli_test.go's), plus args/scaffold tests; help screens, usage errors, `init` (plain, --configs, --parent) and `compile` byte-identical to the Go binary (styled on a terminal too); 10-init passes with the other commands through the Go binary. `ensureBun` waits for app |
| app; cli's other commands (status, explain, installers, setup-new-machine, install, outdated, run, apply, diff, sync, upgrade, self-upgrade, the home screen's entry) | — (each refuses: not ported yet) |
| theme, tui/style, tui/term (+ src/tui/tea.ts, key.ts: the Bubble Tea and bubbles/key slices they use) | done; style's bytes pinned to Lip Gloss's by testdata/golden.json |
| tui (the home screen) | — |
| release (workflow, install.sh unchanged names), docs, Go removed | — |
