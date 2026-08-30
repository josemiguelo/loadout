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
actually has; `diff` compares the fleet. CLI + the Mosaic maintain screen
(the old dashboard TUI was deleted on 2026-08-21 — every function it had
lives in a command now; don't reintroduce it).

Renamed from `post-installer` on 2026-08-17 — the working directory and some
external references may still use the old name. Never reintroduce it in code.

## Build, run, test

```sh
./gradlew :app:linkDebugExecutableLinuxX64          # dev binary
./app/build/bin/linuxX64/debugExecutable/loadout.kexe --help
./gradlew :app:linkReleaseExecutableLinuxX64        # optimized (slow)

./gradlew :core:linuxX64Test                        # core unit tests
./gradlew :app:linuxX64Test                         # maintain-model unit tests
./integration/run-tests.sh [path-to-binary]         # black-box suite (default: debug binary)
```

All three suites must pass before claiming work done. The integration script
builds nothing — link the binary first.

**Testing the TUI without a human**: Mosaic needs a real TTY; use `script` to
fake one and pipe keys with sleeps:

```sh
(sleep 2; printf 'a'; sleep 1; printf '\r'; sleep 3; printf 'q') | script -qec "$BIN --repo <repo> maintain" /dev/null
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
  model/       Manifest, MachineState, System (@Serializable schemas; Manifest
               owns resolveInstall/checkFor — variant × installer resolution)
  manifest/    ManifestLoader — loadRepo() merges manifest.toml + manifest.d (recursive, subfolders cosmetic)
               + machines/*.toml, validates everything; parse() is single-doc, TEST-ONLY
  state/       StateStore — state/<machine>.json via Okio; pretty JSON, stable order
  exec/        ProcessRunner interface + KommandProcessRunner (kommand); ALL process
               use goes through the interface (tests use FakeProcessRunner).
               capture (blocking), inherit (sudo/progress), stream (live
               line-by-line + kill handle; default impl replays capture)
  detect/      Detection — os/distro/hostname + isPmAvailable probe (`command -v`)
  engine/      VersionChecker (concurrent checkAll), UpdateChecker (outdated
               oracles; exit code deliberately ignored), InstallEngine (plan/
               execute/executeCaptured), ScriptRunner, StatusEngine (observes
               programs AND scripts; all checks concurrent — read-only)
  diff/        DiffEngine — pure function: manifest × states -> DiffReport
  git/         GitClient — shells out to `git`, always cwd = repo root
  platform/    expect/actual posix: hostname, isatty, uname, nowIso, envVar,
               blockingDispatcher (= Dispatchers.IO)
app/   loadout
  Main.kt      Clikt dispatch (bare invocation prints help). Catches
               Manifest/Resolution/Git exceptions -> "error: ..." + exit 1
  cli/         AppContext (shared services, suspend refreshAndWriteState) +
               one file per subcommand (status/explain/setup-new-machine/install/outdated/maintain/run/diff/sync/upgrade/init).
               SelfVersion = the one remote-self-check carve-out: status
               footer (cached 6h, fail-soft) + outdated self-row (fresh);
               `upgrade` shells to INSTALL_COMMAND and needs no repo, so it
               works under a min-tool-version refusal (which points at it)
  tui/         MaintainModel (ALL state + logic, no rendering, unit-tested)
               + TuiApp.kt (Mosaic composables for the maintain screen only)
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
    decide membership. A script's optional `modes` (["setup"], ["maintain"],
    default both) scopes EXECUTION surfaces only — setup-new-machine converges
    setup-mode scripts, maintain lists maintain-mode ones; status observes all
    opted-in scripts regardless and `run` ignores modes (explicit escape
    hatch). Empty or unknown modes are load errors.
13. **Installers own mechanics; variants refine them.** `[installers.<name>]`
    (probe / install / check / outdated / regex patterns, `{pkg}` substituted) define
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
    program `[version]`); probe → installer probe (else none); outdated →
    variant outdated (explicit override), else installer `outdated-all`
    (batch: ONE command per installer printing `<pkg> <candidate text>`
    lines, per-program regex extracts the version from the text — 8x faster
    than per-pkg), else installer outdated per-pkg pattern (else no oracle —
    `loadout outdated` skips and reports it). Per-pkg oracles print ONLY the
    candidate version (shape the output in the command; the shared regex
    extracts); exit codes are ignored either way (dnf check-update exits 100
    when updates exist). Old binaries ignore `outdated-all`
    (ignoreUnknownNames) and fall back to per-pkg — keep both in config
    repos until the fleet upgrades. Repos may also declare custom
    `[outdated.<name>]` sources (command prints `<item> <current>
    <candidate> [note…]` lines — the optional tail renders as a dim
    annotation; `file:` allowed, fragment-definable, repo-unique) —
    outdated runs them concurrently and tags rows with the source name; the
    hardcoded self-version row is conceptually the first of these. UNLIKE the
    installer oracles, a custom source's exit code is NOT ignored: it is a
    plain user script and MUST exit 0 when it ran fine, so a non-zero exit is
    surfaced as a loud `outdated source [name] failed: exited N: <last
    stderr>` line (UpdateChecker.sourceRows returns SourceResult{rows,error};
    OutdatedCommand prints errors even when no updates exist) — a crashing
    oracle can't masquerade as "nothing outdated" and silently hide updates
    forever. Never write cross-variant `||` chains in checks.
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
  ever finishing (caused a q-after-refresh hang). MaintainModel owns its own
  `CoroutineScope(SupervisorJob() + blockingDispatcher)`; UI calls
  `model.dispatch(action)`. Keep it that way.
- **TUI size**: Mosaic 0.18's `LocalTerminalState.size` does NOT report the
  real TTY size — TuiApp polls `platform.terminalRows()`/`terminalColumns()`
  (TIOCGWINSZ) every 300ms instead, with 24x80 fallback; the polling effect
  is guarded by `!exit` so quit still works. Keep windowing math in the
  model file, not composables.
- **Theme is ONE source of truth**: `app/.../theme/Theme.kt` (package
  `loadout.theme`) holds the Tokyo Night / Day `ThemePalette` pairs and
  `detectDarkTerminal(bgLuma, COLORFGBG)`; the TUI maps it to Mosaic colors
  (TuiApp `toPalette()`), the CLI emits it as 24-bit ANSI (`Style` — Mordant
  may re-encode the SGR codes on output; that's normal). `MaintainState.dark`
  toggled with `t`; bgLuma is a real OSC 11 query
  (`platform.terminalBackgroundLuma()`, raw-mode /dev/tty round-trip,
  150ms fail-soft) that MUST run before runMosaic owns the terminal — CLI
  `Style` runs it lazily at first styled output, TTY-gated so piped output
  stays plain AND never queries the terminal. Color = signal: ok/warn/error/dim
  statuses, accent = headers/actions (`Style.header` = bold accent),
  machine = machine identity — never reintroduce raw ANSI codes or
  Color.* constants outside Theme.kt/Style.kt. Style AFTER padding.
- **TUI + sudo**: streamed output would swallow a sudo password prompt; the
  maintain screen refuses sudo scripts unless `sudo -n true` succeeds and
  points users at `sudo -v`.
- **Maintain screen** (`loadout maintain`, TTY-only — UsageError otherwise):
  MaintainModel drives picker (ALL opted-in scripts, check-less included) ->
  sequential FORCED runs of the scripts themselves with live-log accordion ->
  full-log viewer. Rendering is borderless and fills the whole terminal:
  width from `platform.terminalColumns()` (polled with terminalRows), footer
  pushed to the bottom with filler lines (user decision — no panel boxes
  here). After each script its `check` (when present) reruns and
  decides done/pending — surfaced as its own `checking…` state
  (RunStatus.CHECKING), since a check can take minutes and "running" after
  `exit 0` reads as a hang; check-less scripts report exit code (done/failed);
  results are MERGED into the existing state file directly (the statuses ARE
  the checks this run just executed; a full refreshAndWriteState here would
  re-probe everything for minutes — it's used only when no state file exists
  yet), skipped on cancel. `status` is the report side: it prints script
  statuses with each failing check's detail (StatusEngine.lastScriptDetail,
  surfaced like StateStore.lastWarnings). Live
  output comes from `ProcessRunner.stream`, which prepends `exec 2>&1`
  (merges stderr without a subshell so sh tail-execs and `kill()` reaches the
  real process) and reads kommand's `Child.bufferedStdout().readLine()`.
  Ceiling: kill hits the direct child only; a grandchild holding the pipe
  open delays the reader. On esc-cancel the model finalizes state immediately
  and the zombie stream return is guarded off — don't let a late return
  mutate state.
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
  is verified manually (ask the user) plus PTY smoke probes; run-tests.sh has
  a Linux-guarded `script`-driven test of the maintain screen.

## CI / release

`.github/workflows/ci.yml`: ubuntu (unit + integration + release link) and
macos (arm64 unit tests, both mac release links, integration against the
release binary). `release.yml` on `v*` tags: strip + tar.gz →
`loadout-<tag>-{linux-x64,macos-arm64,macos-x64}.tar.gz` attached to the
GitHub Release. linuxArm64 builds but is not released. `install.sh` (repo
root) is the curl|sh bootstrap over those releases — it resolves
latest via the GitHub API (pin: LOADOUT_VERSION) and installs to
~/.local/bin; keep its target names in sync with release.yml. Testable
offline via LOADOUT_DOWNLOAD_BASE=file://… against a local tarball. The repo may not be
pushed to GitHub yet — workflows are inert until then.

## Adding programs to a config repo — the recipe

Distilled from migrating the user's real repo (README "Recipe: adding a
program" is the user-facing long form). Match top-down, first fit wins:

1. Standard package → `via = [...]` listing ONLY installers where the claim
   is true (via is unverified; a false entry = a mappable lie).
2. Different package id → variant with `pkg` (flatpak app ids, renamed casks).
3. Special install command, same mechanism → variant with `command`, keyed
   by the installer so check/probe derive. Key by what it IS: a cask gets
   `brew-cask`, not `brew`.
4. Prerequisite step (tap/repo/remote) → its own program + `depends-on`,
   never `&&`-chained into another program's command.
5. Repo-script install that lands in a pm's database → variant keyed by that
   pm with `command = "file:..."`; check/probe derive; override `regex` for
   odd version formats.
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
check); prefer repetition over abstraction in config repos (the user dropped
templates for explicit per-program `via` — don't reintroduce). Verify loop:
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

- After completing any phase/feature, end with a **"Try it"** section: exact
  commands, binary path, expected output.
- Docs split (2026-08-24): **README.md** is a concise front door (concept,
  command table, quickstart, links); the GitHub **wiki** holds the guides
  (Home = concepts, Writing-Your-Manifest, A-Day-With-Loadout — local clone
  at ../loadout.wiki). Keep README, the wiki, and **this file** updated with
  every change; the wiki links into josemiguelo/loadouts as the live example,
  so renames there may break wiki links.
- The user prefers explicit over implicit in every design fork — no
  auto-detection, no fallbacks, no heuristics; errors over guesses. Propose
  designs before implementing when the user asks a question ("is this ok?"
  means assess first, don't jump to code).
