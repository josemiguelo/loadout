# AGENTS.md — loadout

Source of truth for coding agents working on this repo. The README is the
*user-facing* tour; this file is the *contributor-facing* knowledge base.
Keep both updated when behavior changes — and keep them consistent.

## What this is

`loadout` is a single Kotlin/Native binary (no JVM at runtime) that sets up
unix-like machines from a shared git "config repo" and tracks installed program
versions across machines. Users declare installers (mechanism patterns: probe/install/check),
programs (install variants over those installers) and scripts (idempotent
setup steps) in TOML; each machine
maps every program to one install variant; state files record what each machine
actually has; `diff` compares the fleet. CLI + Mosaic TUI.

Renamed from `post-installer` on 2026-08-17 — the working directory and some
external references may still use the old name. Never reintroduce it in code.

## Build, run, test

```sh
./gradlew :app:linkDebugExecutableLinuxX64          # dev binary
./app/build/bin/linuxX64/debugExecutable/loadout.kexe --help
./gradlew :app:linkReleaseExecutableLinuxX64        # optimized (slow)

./gradlew :core:linuxX64Test                        # core unit tests
./gradlew :app:linuxX64Test                         # TUI-model unit tests
./integration/run-tests.sh [path-to-binary]         # black-box suite (default: debug binary)
```

All three suites must pass before claiming work done. The integration script
builds nothing — link the binary first.

**Testing the TUI without a human**: Mosaic needs a real TTY; use `script` to
fake one and pipe keys with sleeps:

```sh
(sleep 3; printf 'r'; sleep 5; printf 'q') | script -qec "$BIN --repo <repo> tui" /dev/null
```

A run that doesn't exit usually means a coroutine kept `runMosaic` alive (see
Gotchas). Rendering changes still need a human check — ask the user to run it.

Manual testing target: the user's live config repo at `~/machines-live`
(machine name `macbook-fedora-kde`, Fedora, dnf + linuxbrew present). Fine to
run `status`/`diff`/`--dry-run` against it; don't install/remove packages or
push git without asking.

## Architecture

Two Gradle modules; all targets native (linuxX64, linuxArm64, macosX64,
macosArm64 — macosX64 is deprecated upstream but kept). Compose plugin only on
`:app` so `:core` stays Compose-free.

```
core/  loadout.core
  model/       Manifest, MachineState, System (@Serializable schemas; Manifest
               owns resolveInstall/checkFor — variant × installer resolution)
  manifest/    ManifestLoader — loadRepo() merges manifest.toml + manifest.d (recursive, subfolders cosmetic)
               + machines/*.toml, validates everything; parse() is single-doc, TEST-ONLY
  state/       StateStore — state/<machine>.json via Okio; pretty JSON, stable order
  exec/        ProcessRunner interface + KommandProcessRunner (kommand); ALL process
               use goes through the interface (tests use FakeProcessRunner)
  detect/      Detection — os/distro/hostname + isPmAvailable probe (`command -v`)
  engine/      VersionChecker (concurrent checkAll), InstallEngine (plan/execute/
               executeCaptured), ScriptRunner, StatusEngine (observes programs AND scripts)
  diff/        DiffEngine — pure function: manifest × states -> DiffReport
  git/         GitClient — shells out to `git`, always cwd = repo root
  platform/    expect/actual posix: hostname, isatty, uname, nowIso, envVar,
               blockingDispatcher (= Dispatchers.IO)
app/   loadout
  Main.kt      dispatch: no args + stdout TTY -> TUI; else Clikt. Catches
               Manifest/Resolution/Git exceptions -> "error: ..." + exit 1
  cli/         AppContext (shared services, suspend refreshAndWriteState) +
               one file per subcommand (status/show/install/run/diff/sync/init/tui)
  tui/         DashboardModel (ALL state + logic, no rendering, unit-tested) +
               TuiApp.kt (Mosaic composables only)
```

## Design contract — do not violate

These came from explicit user decisions; don't "improve" them away:

1. **No package-manager auto-detection. No `--pm` flag or env override.** The
   only source of install-variant choice is `machines/<name>.toml` (`[pm]`
   table mapping EVERY program to a key of its install table). Inline
   `[machines.*]` in manifest.toml or fragments is a validation error.
2. **Mapping = membership + strict fail-fast resolution.** A program a machine
   doesn't map is not part of that machine's loadout: converge skips it,
   status doesn't observe it, diff shows "-". `install` throws
   ResolutionException before executing anything if: machine config file
   missing, an EXPLICITLY requested program unmapped, a mapped program's
   dependency unmapped, or a mapped known PM's binary absent (probed). No
   automatic `script` fallback — everything explicit.
3. **Intent vs observation never mix.** `manifest.toml` + `manifest.d/` +
   `machines/` are authored; `state/` is generated and disposable. Nothing
   hand-edited ever goes in `state/`; the tool never writes authored files
   (except `init` scaffolding).
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
7. **Script status is observation**: on every refresh the `check` runs — exit 0
   => `done`, else `pending` — even right after a run (the check is the truth).
   `lastRun`/`exitCode` are history from tool-executed runs only. Check-less
   scripts carry only run history. Install success = exit 0 AND re-run version
   check no longer says missing.
8. **State files**: written only for this machine; `updatedAt` bumps only when
   content actually changed (keeps git history clean; makes `sync` a no-op when
   idle). Unknown JSON keys ignored on read.
9. **Errors are clean one-liners** (`error: ...`), never stack traces. New
   exception types get a catch in Main.kt.
10. **Product code loads manifests via `ManifestLoader.loadRepo`** (merging +
    file validation). `parse()` exists for tests only.
11. **Templates** (`[templates.<name>]`): reusable program patterns with
    `{name}` substitution; used via the template's `packages` array (+
    `overrides.<pkg>`, members only) or `template = "<name>"` on a program.
    Expansion happens in ManifestLoader.expandTemplates (then expandVia)
    before validation — expanded programs are indistinguishable from
    hand-written ones, and every downstream feature must keep treating them
    that way. Template names are repo-unique; fragments may define them.
12. **Scripts are opt-in per machine**: a machine's top-level `scripts` list
    (in machines/<name>.toml, ABOVE any table header) has entries "name" or
    "name args..." parsed by MachineConfig.scriptArgs(); only opted-in
    scripts converge and are observed, `run` errors otherwise, and args become
    positional params for the file script AND its check (via `set --` — see
    ScriptRunner.withArgs). Args on inline `run` scripts are a validation
    error. No implicit script application; no os/bootc auto-detection to
    decide membership.
13. **Installers own mechanics; variants refine them.** `[installers.<name>]`
    (probe / install / check / regex patterns, `{pkg}` substituted) define
    each mechanism once, repo-unique, fragment-definable; core hardcodes NO
    package-manager knowledge (no canonical probe list). A program's install
    entry is a variant table `{installer, pkg, command, check, regex, probe}`
    — every field optional, defaulting from its installer (explicit
    `installer = ...`, else the installer its key names) with `pkg`
    defaulting to the program name; `via = [...]` is shorthand for one
    all-defaults variant per named installer (expandVia; explicit variant for
    the same key wins). Resolution lives in Manifest.resolveInstall/checkFor
    — all engines/UIs go through it. Field fallback: command → installer
    install pattern (else load error); check → installer check (else
    program `[version]`); probe → installer probe (else none). Never write
    cross-variant `||` chains in checks.
14. **Versioning contract.** Since 0.2.0 the manifest format evolves
    ADDITIVELY only (new optional fields; never repurpose existing ones) —
    0.2.0 itself broke 0.1 repos (string install values became variant
    tables). `[meta] min-tool-version`
    is enforced at loadRepo — repos requiring newer features declare their
    floor and old binaries refuse with an "upgrade loadout" error. State files
    with `schemaVersion > StateStore.SCHEMA_VERSION` are skipped with a
    warning (surfaced via `StateStore.lastWarnings` — new read paths must
    echo/log them). Bump SCHEMA_VERSION only with a real schema break, and
    handle older schemas via defaults.

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
- **Mosaic 0.18**: `runMosaicBlocking {}`; keys via
  `Modifier.onKeyEvent { it == KeyEvent("q") ... }`; styles `TextStyle.Bold/
  Dim/Invert/Italic` combined with `+`, neutral is `TextStyle.Empty` (no
  `.None`); colors `com.jakewharton.mosaic.ui.Color`. App stays alive while a
  `LaunchedEffect` runs — exit = remove the `awaitCancellation()` effect.
- **TUI coroutine rule**: async work must NOT run on the composition's scope
  (`rememberCoroutineScope`) — a lingering job there keeps `runMosaic` from
  ever finishing (caused a q-after-refresh hang). DashboardModel owns its own
  `CoroutineScope(SupervisorJob() + blockingDispatcher)`; UI calls
  `model.dispatch(action)`. Keep it that way.
- **TUI + sudo**: install output is captured for the log pane, which would
  swallow sudo prompts; the model refuses sudo plans unless `sudo -n true`
  succeeds and points users at `sudo -v` or the CLI.
- ktoml quirk insurance: manifest schema sticks to plain nested tables (no
  inline tables / dotted keys). Fallback parser if ever needed: tomlkt.
- `.toml.sample` files in `machines/` and `manifest.d/` are deliberately
  ignored by the loader (only `.toml` matches).

## Testing conventions

- Unit tests live in commonTest, run on the host native target. No real
  processes or filesystem: `FakeProcessRunner` (scripted stdout/exit codes;
  unregistered command = exit 127) and Okio `FakeFileSystem`.
- `EXAMPLE_MANIFEST` in core's ManifestLoaderTest is the shared fixture.
- Integration = `integration/run-tests.sh`: black-box, real binary, temp repo,
  local bare git remote, `manual = "..."` custom install keys so tests don't
  depend on the host's package managers. Add an `ok "..."` test there for every
  user-visible behavior change.
- TUI: reducers (`handleKey`) are unit-tested via `setStateForTest`; rendering
  is verified manually (ask the user) plus PTY smoke probes.

## CI / release

`.github/workflows/ci.yml`: ubuntu (unit + integration + release link) and
macos (arm64 unit tests, both mac release links, integration against the
release binary). `release.yml` on `v*` tags: strip + tar.gz →
`loadout-<tag>-{linux-x64,macos-arm64,macos-x64}.tar.gz` attached to the
GitHub Release. linuxArm64 builds but is not released. The repo may not be
pushed to GitHub yet — workflows are inert until then.

## Working agreements with the user

- After completing any phase/feature, end with a **"Try it"** section: exact
  commands, binary path, expected output.
- Keep **README.md** (tour-style, exhaustive, every capability shown with
  console examples) and **this file** updated with every change.
- The user prefers explicit over implicit in every design fork — no
  auto-detection, no fallbacks, no heuristics; errors over guesses. Propose
  designs before implementing when the user asks a question ("is this ok?"
  means assess first, don't jump to code).
