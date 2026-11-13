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
  `ConfigException`) join the list in src/core/loader/loader.test.ts's
  "every loadout failure reports as a clean one-liner" when they're ported.
- **Timestamps** come from `platform.nowIso()` (9 fraction digits, as Go
  wrote them). Never `new Date().toISOString()`.

## Status

| Part | State |
|---|---|
| skeleton, build, Ink + xterm in a compiled binary | done |
| model, assemble, coremodel, coretest, version | done: Go tests ported; every testdata and real lock re-encodes byte for byte (src/model/differential.test.ts) |
| core/platform | done (termios through bun:ffi for the OSC 11 query) |
| core (exec + fakeexec, detect, git, loader, state, diff, bun wrapper) | done: Go tests ported; state's testdata re-encodes byte for byte; nowIso reads nanoseconds (clock_gettime through bun:ffi), as Go's time.Now |
| compile (tsmanifest) | done: Go tests ported; byte-identical to the Go binary (lock, chezmoi data, partial, SDKs, warnings, refusals) on the dotfiles, `init`/`init --configs` scaffolds and child repos. `src/compile/devcompile.ts` (the differential driver) goes at cutover |
| engines | — |
| app, cli | — |
| theme, tui/style, tui/term (+ src/tui/tea.ts, key.ts: the Bubble Tea and bubbles/key slices they use) | done; style's bytes pinned to Lip Gloss's by testdata/golden.json |
| tui (the home screen) | — |
| release (workflow, install.sh unchanged names), docs, Go removed | — |
