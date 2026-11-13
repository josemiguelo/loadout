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

## Status

| Part | State |
|---|---|
| skeleton, build, Ink + xterm in a compiled binary | done |
| model, assemble, coremodel, coretest, version | — |
| core (exec, platform, detect, git, loader, state, diff, bun wrapper) | — |
| compile (tsmanifest) | — |
| engines | — |
| app, cli | — |
| theme, tui/style, tui/term, tui | — |
| release (workflow, install.sh unchanged names), docs, Go removed | — |
