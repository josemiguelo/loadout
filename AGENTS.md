# AGENTS.md — loadout

Knowledge base for coding agents. README is the user-facing tour; this file
is for contributors. Update both when behavior changes, and keep them
consistent.

Add an entry only when it stops a future agent from reverting a deliberate
decision (Design contract) or from rediscovering a costly failure
(Toolchain facts); everything else belongs in the commit message. State
what is true now, folded into the relevant bullet. Keep history only when
it explains a rule or guides future changes; git log holds the rest.

**Writing style** (comments, KDoc, this file, README, wiki): succinct,
direct, present tense, no important detail dropped. A past incident is
written as the rule it produced, not as a story.

## What this is

`loadout` is a single Kotlin/Native binary (no JVM at runtime) that sets up
unix-like machines from a shared git "config repo" and tracks installed
program versions across machines. In TOML, users declare installers
(mechanisms: probe/install/check), programs (install variants over those
installers) and scripts (idempotent setup steps); each machine maps every
program to one variant; state files record what each machine has; `diff`
compares the fleet.

CLI plus ONE Mosaic screen, the home screen (bare `loadout`). It observes,
then hands every action to the matching command on the real terminal and
comes back; it runs nothing itself and owns no domain logic. No other TUI:
a screen that re-displays what commands print, or a second picker for
something a home-screen row already does, is not wanted.

Formerly `post-installer`: the working directory and some external
references may still use that name. Never reintroduce it in code.

## Target design: 1.0 (in progress on branch `layout`)

The rest of this file describes the code as it is. This section is the
agreed target; each implementation step moves its part into the sections
below and deletes it here. The user approves every step before it runs.
Compatibility with 0.x config repos is not a goal: 1.0 is the second
deliberate break (contract 14).

**Goal**: one repo per user holds programs, maintenance scripts, machines,
state AND dotfiles, so a change to a tool lands in one place. Dotfiles stay
chezmoi's; a tool's loadout fragment sits beside its chezmoi config.

**Repo layout** (chezmoi clones it to its source dir, `~/.local/share/chezmoi`
on Linux and macOS; `LOADOUT_REPO` points there):

```
<repo>/
  .chezmoiroot      "configs": chezmoi reads only configs/
  loadout.toml      root marker: [meta], [layout], [data]; a root manifest.toml is refused as a 0.x repo
  programs/         installers (+ helper scripts beside them) and config-less programs
  maintenance/      config-less scripts and oracles, one folder per concern; lib/ for shared helpers
  machines/         flat: <hostname>.toml and base files
  state/            generated, <hostname>.json
  configs/          chezmoi source root; a tool's .loadout.toml + .loadout/ sit beside its config
```

Dot-prefixed `.loadout.toml`/`.loadout/` are invisible to chezmoi (it skips
dot entries that aren't its own special files), so no `.chezmoiignore`
rule is needed. A tool whose files land in several places keeps its fragment
in its main config folder (zsh owns `dot_zshenv.tmpl`, mise owns
`dot_default-gems`).

**`loadout.toml`**:

```toml
[meta]
name = "jm's machines"
min-tool-version = "1.0.0"

[layout]
configs   = "configs"        # optional; set => chezmoi is required
machines  = "machines"
state     = "state"
fragments = ["programs/**/*.toml", "maintenance/**/*.toml", "configs/**/.loadout.toml"]

[data]                       # every per-machine key, with its default
omarchy = false

[data.kitty]
opacity = 0.85
```

- Discovery is explicit: only `[layout] fragments` globs load (`*` one
  segment, `**` any depth, `?`; `*` never matches a leading dot; `.git` is
  never entered). A glob matching nothing, an absolute or `..` path, or a
  glob matching `loadout.toml` or a machine file is a load error.
- Fragments hold `[installers.*]`, `[programs.*]`, `[scripts.*]`,
  `[outdated.*]` only.

**Paths and cwd**: every path (`file`, every `file:` token, installer
patterns) is relative to the directory of the file that declares it, must
stay inside the repo, and is resolved to an absolute path and validated at
load; runners never see a relative path. Every manifest command runs with
cwd = the declaring file's directory and gets `LOADOUT_REPO`,
`LOADOUT_CONFIGS` (if set), `LOADOUT_FRAGMENT_DIR`, `LOADOUT_MACHINE`,
`LOADOUT_OS` (`linux`/`macos`). The `ShellCommand` value (line, cwd, env) carries
this through `ProcessRunner`.

**Machines**: flat `machines/<hostname>.toml` (chezmoi finds it by
hostname). `extends`/`base = true`, `[pm]` and the `scripts` opt-in work as
in contract 2/12. `[data]` merges per key (child over base over
`loadout.toml` defaults; lists replace, as in chezmoi); a key not declared
in `loadout.toml [data]`, or of another TOML type, is a load error. Chezmoi
templates read the same files through `configs/.chezmoitemplates/machine`
(`include "../machines/<host>.toml"`, verified to reach outside
`.chezmoiroot`) and branch on `$m.omarchy`, never on `.chezmoi.hostname`.
Nothing is generated for chezmoi.

**Configs** (chezmoi integration; required iff `[layout] configs` is set):
- unit = top-level config directory, from one `chezmoi managed
  --path-style source-relative` per refresh; units are not opted in
  (`.chezmoiignore` is chezmoi's membership);
- drift is observation (contract 7): `chezmoi verify <unit targets>`,
  detail from `chezmoi status`; a missing chezmoi is `unknown`;
- `loadout apply [unit…]` hands off `chezmoi apply --no-tty <targets>`;
- `sync` = pull → `chezmoi apply --no-tty` → refresh programs, scripts,
  configs → commit `state/<machine>.json` → push;
- state schema 2 adds `configs`; `diff` shows config drift per machine;
- home screen: a fifth subject row, "configs", same picker/hand-off rules;
- bootstrap (both OSes): install git + chezmoi → `chezmoi init --apply
  <repo>` → `install.sh` → `loadout setup-new-machine`.

**Contract changes**: 4 keeps its rule, paths now file-relative; 5 becomes
cwd = declaring file's directory plus the exported env; 6 declaration
order = order of `[layout] fragments` entries, path-sorted within one,
table order within a file; 7 extends to configs; 8 takes its dir from
`[layout] state`; 11 still holds for loadout files (`.loadout.toml` is never
rendered); 12 scripts stay opt-in, configs don't; 14 the break ships as
1.0.0. All others stand unchanged.

**Open risk**: ktoml must decode `[data]` as free-form nested tables
(today's schema avoids inline tables and dotted keys; see Toolchain facts).
Step 5 proves it first; the fallback is tomlkt.

**Steps** (each: three suites green on Linux, macOS checked by the user,
README/AGENTS/wiki re-read):
1. This section.
2. `ShellCommand(line, cwd, env)` through `exec/` and the engines (done).
3. `loadout.toml` + `[layout]` + glob discovery; machines/state dirs from
   it; 0.x root refused (done; contract 16).
4. File-relative paths, per-file cwd, exported env.
5. Flat machines, declared `[data]`, `explain` shows it.
6. 1.0.0: state schema 2, release notes, wiki "Repo layout", `install.sh`
   next steps, tag.
7. Migrate the user's repos PROGRESSIVELY, one slice at a time, never all
   at once; each slice is approved before it runs. Slice 1 is the
   backbone: the merged repo's skeleton (`loadout.toml`, `.chezmoiroot`,
   `machines/`, `state/`, the machine template partial) plus pure zsh
   dotfiles and nothing else; tool configs (kitty, nvim, tmux…) and their
   fragments follow in later slices, one tool each. Every slice decides,
   and says, whether it needs a new test.
8. `ConfigEngine`, configs in status/state/diff, `apply`, `sync`;
   `t/55-configs.sh` with a stub chezmoi.
9. Home-screen configs row.
10. Retire the config repo's `dotfiles-*` scripts; README quickstart = the
    four bootstrap commands.

## Build, run, test

```sh
./gradlew :app:linkDebugExecutableLinuxX64          # dev binary
./app/build/bin/linuxX64/debugExecutable/loadout.kexe --help
./gradlew :app:linkReleaseExecutableLinuxX64        # optimized (slow)

./gradlew :core:linuxX64Test                        # core unit tests
./gradlew :app:linuxX64Test                         # home-model unit tests
./integration/run-tests.sh [path-to-binary] [pattern] # black-box suite (default: debug binary)
./integration/run-tests.sh home                     # only t/*home*.sh
```

All three suites must pass before claiming work done. The integration
script builds nothing: link the binary first.

**Driving the TUI without a human**: Mosaic needs a real TTY; fake one
with `script` and pipe keys in. Give the screen time to bind the tty and
finish its first refresh: a key on a busy row is refused, a key before raw
mode is lost. By hand, sleeps do; the integration suite waits on the
screen instead (see Testing conventions).

```sh
# Linux: the command is one string, the log is the last argument.
(sleep 4; printf 'j'; sleep 1; printf 'l'; sleep 1; printf 'q') | script -qec "$BIN --repo <repo>" /dev/null
# macOS (BSD script): the log comes first, the command is plain argv.
(sleep 4; printf 'j'; sleep 1; printf 'l'; sleep 1; printf 'q') | script -q /dev/null "$BIN" --repo <repo>
```

A run that doesn't exit usually means an effect or coroutine kept the
composition alive (see Toolchain facts). Rendering changes still need a
human check: ask the user to run it.

Manual testing target: the user's live config repo at `~/.config/loadouts`
(machine name = hostname; the user's machines run Omarchy/Arch and macOS).
`status`/`diff`/`--dry-run` against it are fine; installing/removing
packages or pushing git needs the user's OK. Opening the home screen
writes the machine's state file there.

## Architecture

Two Gradle modules, all targets native (linuxX64, linuxArm64, macosX64,
macosArm64; macosX64 is deprecated upstream but kept). The Compose plugin
is on `:app` only, so `:core` stays Compose-free.

```
core/  loadout.core
  LoadoutException — supertype of every refusal (contract 9)
  model/       Manifest, MachineState, System (@Serializable schemas; Manifest
               owns resolveInstall/checkFor — variant × installer resolution)
  manifest/    ManifestLoader — loadRepo() merges loadout.toml + the files its
               [layout] fragments globs match + <machines>/*.toml +
               InstallerLibrary under the repo's own installers, validates
               everything; readLayout() reads [layout] alone (AppContext.layout);
               parse() is single-doc, TEST-ONLY
               Glob — the layout's glob matching and file expansion
               InstallerLibrary — the built-in installers, as TOML text
  state/       StateStore — <state>/<machine>.json via Okio; pretty JSON, stable order
  exec/        ProcessRunner interface + KommandProcessRunner (kommand); ALL
               process use goes through the interface (tests use
               FakeProcessRunner). capture (blocking), inherit (sudo/progress),
               each taking a ShellCommand (line, cwd, env); manifest commands
               always build one, plain strings are for git/probes/self-version.
               A child killed by a signal reports -1 (kommand's wait() throws
               for it); Ctrl-C during a home-screen hand-off throws
               InterruptedByUser once the child exits
  detect/      Detection — os/distro/hostname + isBinaryAvailable (`command -v`)
  engine/      VersionChecker (concurrent checkAll), UpdateChecker (outdated
               oracles; exit code deliberately ignored), InstallEngine
               (plan/execute), UpgradeEngine (planner only: which mechanisms
               this machine can upgrade, one step per command, refusals;
               `upgrade` runs and verifies, the home screen plans with it to
               describe steps and refuse early), ScriptRunner, StatusEngine
               (observes programs AND scripts; all checks concurrent, read-only)
  diff/        DiffEngine — pure: manifest × states -> DiffReport
  git/         GitClient — shells out to `git`, cwd = repo root
  platform/    expect/actual posix: hostname, isatty, uname, nowIso, envVar,
               terminal size/background, trapInterrupts/takeInterrupt (C
               SIGINT handler in nativeInterop/cinterop/signals.def),
               blockingDispatcher (= Dispatchers.IO)
app/   loadout
  Main.kt      Clikt dispatch (bare invocation without a TTY prints help).
               Catches LoadoutException (+ okio.IOException) -> "error: ..." + exit 1
  cli/         AppContext (shared services, suspend refreshAndWriteState) +
               one file per subcommand (status/explain/installers/
               setup-new-machine/install/upgrade/self-upgrade/outdated/run/
               diff/sync/init). SelfVersion is the one remote self-check:
               status footer (6h cache, Okio, fail-soft) + outdated self-row
               (fresh). `self-upgrade` shells to INSTALL_COMMAND and needs no
               repo, so it works under a min-tool-version refusal (which
               points at it)
  tui/         HomeModel (ALL state + logic, no rendering, unit-tested) +
               HomeApp.kt (composables, HomeScreen) + TuiApp.kt (palette,
               frame loop)
```

## Design contract — do not violate

Explicit user decisions; don't "improve" them away.

1. **No package-manager auto-detection, no `--pm` flag or env override.**
   The only source of variant choice is `machines/<name>.toml` (`[pm]`
   maps EVERY program to a key of its install table). Inline
   `[machines.*]` in loadout.toml or fragments is a validation error.
2. **Mapping = membership + strict fail-fast resolution.** A program a
   machine doesn't map is not in its loadout: converge skips it, status
   doesn't observe it, diff shows "-". Machine files may sit in subfolders
   (cosmetic; name = file name, unique repo-wide) and may `extends` a
   `base = true` config (pm merged per key, child wins; scripts union, a
   same-named child entry replaces). Bases are flattened at load,
   validated, then dropped; they are never machines. Machines can't extend
   machines, and there's no subtraction: a base entry is a promise every
   child keeps. `setup-new-machine` throws ResolutionException before
   executing anything if the machine file is missing, an EXPLICITLY
   requested program is unmapped, a mapped program's dependency is
   unmapped, or a mapped known PM's binary is absent (probed). No automatic
   `script` fallback.
3. **Intent and observation never mix.** `loadout.toml`, the fragments and
   the machine files are authored; the `[layout] state` directory is
   generated and disposable. Nothing hand-edited goes in state; the tool
   never writes authored files, except `init` scaffolding and `installers
   --eject` (writes exactly `programs/installers/builtin.toml`, refuses when
   no fragments glob loads it, and refuses to clobber it without `--force`).
4. **Scripts: exactly one of `file` (repo path) or `run` (inline).** `file`
   existence is validated at load (loadRepo, not parse). Variant `command`
   values and all check commands (variant `check`, program `[version]`,
   script `check`) may use the `file:` prefix, also validated; expansion is
   centralized in model.expandFilePrefix, applied at the execution sites
   (InstallEngine plan, VersionChecker.check, ScriptRunner.withArgs).
   Tokens after the first space are arguments (`file:path args…` →
   `sh 'path' args…`), so file: paths can't contain spaces.
5. **Every manifest command runs via `sh -c` with the repo root as cwd**
   (installs, scripts, version checks, `check`s), whatever the invocation
   directory.
6. **Execution order**: all programs before all scripts; programs
   topologically by `depends-on` (declaration order breaks ties:
   loadout.toml, then fragments in `[layout] fragments` glob order,
   path-sorted within one glob); scripts by `after` edges.
   Sequential, never parallel (only read-only checks run concurrently).
   `after` orders but never pulls anything in; `depends-on` pulls in
   transitively. A variant may carry its own `depends-on`, added to the
   program's only on machines mapping that variant
   (`Manifest.dependenciesOf`), so a COPR's dnf-plugins-core never lands
   on a pacman machine; validation and cycle detection count every
   variant's edges.
7. **Script status is observation**: every refresh re-runs each `check`
   (exit 0 => `done`, else `pending`), even right after a run; `lastRun`/
   `exitCode` are only history of tool-run executions. Check-less scripts
   carry only run history. Install success = exit 0 AND a re-run version
   check no longer says missing. **A check that couldn't run is not
   "missing"**: a check that goes THROUGH a tool (`VersionCheck.probe`, from
   the installer's/variant's probe) and dies with the shell's 127/126 is
   `unknown`, with `ProgramState.reason` set to the shell's line; a check
   with no probe IS the program, so its 127 means missing. (Otherwise a tool
   off PATH reports all its programs missing.) The refresh groups unknown
   rows by tool and asks about each ONCE (`command -v`):
   `StatusEngine.lastToolsDown` — `status` reports it once after the table,
   the home screen on its message line, and affected programs are never
   offered for install. Ceiling: a pipeline check (`tool | grep …`) exits
   with the LAST command's code and hides the tool's absence; write
   `x=$(tool …) && printf '%s\n' "$x" | grep …` so the failure propagates.
8. **State files**: written only for this machine; `updatedAt` bumps only
   when content changed (clean git history; `sync` is a no-op when idle).
   Unknown JSON keys are ignored on read.
9. **Errors are clean one-liners** (`error: ...`), never stack traces. Every
   refusal extends `loadout.core.LoadoutException`, caught once in Main.kt
   (plus `okio.IOException`, which isn't ours), so a new failure type needs
   no new catch block. A test asserts the hierarchy.
10. **Product code loads manifests via `ManifestLoader.loadRepo`** (merging
    + file validation). `parse()` is for tests only: it tolerates inline
    `[machines.*]` and can't check `file:` paths. Both share
    `withBuiltinInstallers`, so install resolution is identical (a test
    asserts it); anything else that must hold for both goes in that helper.
11. **No templates.** `[templates.<name>]` was removed in 0.9.0; prefer
    explicit repetition over abstraction. `template = "..."` and
    `[templates.*]` are unknown keys now, and ktoml ignores unknown keys,
    so an old manifest silently loses those programs (contract 14 is what
    makes repos bump their floor). Don't reintroduce it.
12. **Scripts are opt-in per machine**: a machine's top-level `scripts`
    list (in machines/<name>.toml, ABOVE any table header) has entries
    "name" or "name args...", parsed by `scriptEntry` (the one parser; any
    whitespace separates words, newlines included, so a long entry can be a
    TOML multi-line string; args are re-joined with single spaces because
    they're pasted into a shell command line, where a newline would run the
    next line as a command). Only opted-in scripts converge and are
    observed; `run` errors on others.
    Args become positional params for the file script AND its check (`set
    --`, see ScriptRunner.withArgs); args on inline `run` scripts are a
    validation error. No implicit script application, no os/bootc
    detection deciding membership. A script's optional `modes` (["setup"],
    ["maintain"], default both) scopes EXECUTION only: setup-new-machine
    converges setup-mode scripts, the home screen's scripts picker lists
    maintain-mode ones; status observes all opted-in scripts and `run`
    ignores modes. Empty or unknown modes are load errors.
13. **Installers own mechanics; variants refine them.** `[installers.<name>]`
    (probe / install / check / outdated / regex, `{pkg}` substituted)
    defines a mechanism once, repo-unique, fragment-definable. Core ships a
    library (`core/manifest/InstallerLibrary.kt`: dnf, brew, brew-cask,
    flatpak, pacman with oracles; apt install/check only) as TOML text,
    merged UNDER the repo's own in `loadRepo`: a repo definition of the same
    name replaces the built-in outright, and `Manifest.builtinInstallers`
    records which survived so `explain`/`installers` label `(built-in)` vs
    `(repo)`. Knowledge, never detection: nothing probes the machine to pick
    an installer. `installers --eject` writes the library into the repo; a
    repo relying on built-ins should declare `[meta] min-tool-version`.
    A program's install entry is a variant table `{installer, pkg, command,
    check, regex, probe}`, every field optional and defaulting from its
    installer; `pkg` defaults to the program name. An installer may declare
    `params = [...]`: values a variant supplies in a nested
    `[...install.<key>.with]` table, substituted like `{pkg}`. All declared,
    never inferred: a missing param, an undeclared `with` key, or a `with`
    on a variant without an installer is a load error, so an unsubstituted
    `{placeholder}` never reaches a shell. That's what lets one
    `dnf-repo`/`dnf-copr` mechanism replace near-identical install scripts
    (recipe 5). `via = [...]` is shorthand for one all-defaults variant per
    named installer.
    Resolution (`Manifest.resolveInstall`/`checkFor`, used by every
    engine/UI): command → installer install pattern (else load error);
    check → installer check (else program `[version]`); probe → installer
    probe (else none); outdated → variant override, else installer
    `outdated-all` (one batch command per installer, per-program regex
    extracts; binaries that don't know it fall back to per-pkg), else
    installer per-pkg pattern, else no oracle (`outdated` skips and says
    so). These oracles' exit codes are always ignored.
    Repos may also declare `[outdated.<name>]` custom sources (`<item>
    <current> <candidate> [note…]` lines; a URL in the note becomes the
    row's link, opened with `K`; `file:` allowed, repo-unique). Unlike
    installer oracles, a source's exit code is NOT ignored: non-zero
    surfaces as `outdated source [name] failed: ...`, so a crashing oracle
    can't hide updates.
    Installers may declare `upgrade`: the ONE command that moves everything
    the mechanism manages, with no `{pkgs}` placeholder (contract 15).
    Never write cross-variant `||` chains in checks.
    `sudo = true` (installer, variant, script, `[outdated.*]` source) is
    obsolete: parsed so existing manifests load, used nowhere.
14. **Versioning contract.** The manifest format evolves ADDITIVELY (new
    optional fields; never repurpose existing ones). The two deliberate
    breaks: 0.2.0 (string install values became variant tables) and 0.9.0
    (`[templates.*]` removed). A removal is decided once, loudly, in the
    release notes, never silently, because ktoml drops unknown keys instead
    of failing. `[meta] min-tool-version` is enforced at loadRepo: repos
    needing newer features declare their floor and old binaries refuse with
    an "upgrade loadout" error. State files with `schemaVersion >
    StateStore.SCHEMA_VERSION` are skipped with a warning
    (`StateStore.lastWarnings`; new read paths must echo/log them). Bump
    SCHEMA_VERSION only for a real schema break; handle older schemas via
    defaults.
15. **Converge installs; `upgrade` upgrades, a whole mechanism at a time.**
    `setup-new-machine`/`install` add what's MISSING and never touch a
    version already there. Moving versions is its own verb, `loadout upgrade
    <installers…>|--all` (`UpgradeEngine`), never single packages: naming a
    program is an error pointing at its mechanism. Mechanisms sharing a
    command (dnf, dnf-repo, dnf-copr all run `dnf upgrade -y`) are ONE step,
    deduped by command; the UI groups by the TOOL they drive (their probe),
    so ticking a brew row ticks casks too. `plan` refuses an installer this
    machine doesn't map, so a repo mapping nothing to brew can't sweep it.
    Custom `[outdated.<name>]` sources upgrade per item: a declared `upgrade
    = "... {item}"` runs once per row (`upgrade --item <source>/<name>`),
    since items (a pin, a clone) are independent and one failure shouldn't
    stop the rest; a source without it is read-only (`[–]`). Afterwards
    EVERY mapped program is re-checked, since the transaction can move
    packages loadout doesn't declare. The binary's own update is
    `self-upgrade`, which needs no repo, so it survives a version-floor
    refusal.
16. **The repo's shape is declared, never assumed.** The root file is
    `loadout.toml` (`--manifest` names another); a repo with only a 0.x
    `manifest.toml` is refused as one. Its `[layout]` is required, with no
    defaults: `fragments` (globs), `machines` and `state` (directories),
    `configs` optional. Only files the globs match load (`Glob`: `*` one
    segment, `?` one char, `**` any depth; wildcards never match a leading
    dot, so `.loadout.toml` loads only when a glob spells the dot; `.git` is
    never entered). A glob matching nothing is fine (a fresh repo); an
    absolute or `..` path, a wildcard in a directory key, or a glob reaching
    loadout.toml or a machine file is a load error, as is `[layout]` in a
    fragment. The min-tool-version check runs before `[layout]` is read.

## Toolchain facts — don't rediscover

- **Kotlin ≥ 2.4.0**: clikt 5.1.0 klibs use ABI 2.3.0. Mosaic 0.18.0 works
  on 2.4.0. Repos: mavenCentral + **google()** (Compose androidx deps).
- **clikt duplicate-symbol linker error**: clikt + clikt-mordant both define
  `Context.selfAndAncestors`; fixed by `disableNativeCache(...)` on **all**
  binaries (`target.binaries.all`) in app/build.gradle.kts, test binaries
  included. The `kotlin.native.cacheKind` properties don't work.
- **Kotlin nested block comments**: `/*` inside a KDoc (e.g. a glob like
  `programs/*.toml`) opens a *nested* comment and eats the file. Word
  globs differently in comments.
- **Dispatchers.IO on native** needs `import kotlinx.coroutines.IO`
  (extension); fully-qualified use resolves an internal symbol. Use the
  `platform.blockingDispatcher` wrapper.
- **Clikt 5**: `currentContext.obj` needs `import
  com.github.ajalt.clikt.core.obj`; subcommands read it via
  `requireObject<AppContext>()`.
- **Mosaic 0.18**: entry point is our `runTui {}`; keys via
  `Modifier.onKeyEvent { it == KeyEvent("q") ... }`; styles `TextStyle.Bold/
  Dim/Invert/Italic` combined with `+`, neutral is `TextStyle.Empty` (no
  `.None`); colors `com.jakewharton.mosaic.ui.Color`. The app stays alive
  while a `LaunchedEffect` runs; exit = remove the `awaitCancellation()`
  effect.
- **Every `LaunchedEffect` stops when the model says exit**: `if (!s.exit)
  { LaunchedEffect(...) }`. An effect still looping (a spinner, the size
  poll) keeps the screen alive forever, so q appears to hang.
- **Async work never runs on the composition's scope**
  (`rememberCoroutineScope`): a lingering job there keeps the screen from
  finishing. HomeModel owns `CoroutineScope(SupervisorJob() +
  blockingDispatcher)`; the UI calls `model.handleKey(key)`. That scope is
  multi-threaded, so every write goes through `HomeModel.update { it.copy(…)
  }` (keys from the UI thread included), which hands the lambda the current
  state under a spin lock (not a Mutex: keys aren't in a coroutine). A
  plain `state = state.copy(…)` races: a writer puts back a copy read
  before another write landed (e.g. the remote row's `Asking` over its
  answer, spinning forever). Never assign `state` directly; keep the lambda
  a pure copy (slow work before the call) and never call `update` inside it
  (not reentrant). `writesFromManyThreadsAreNeverLost` fails without the
  lock.
- **TUI size**: Mosaic 0.18's `LocalTerminalState.size` doesn't report the
  real TTY size; HomeApp polls `platform.terminalRows()`/`terminalColumns()`
  (TIOCGWINSZ) every 300ms, 24x80 fallback, guarded by `!exit`. Keep
  windowing math in the model file, not in composables.
- **Theme is ONE source of truth**: `app/.../theme/Theme.kt` (package
  `loadout.theme`) holds the Tokyo Night / Day `ThemePalette` pair and
  `detectDarkTerminal(bgLuma, COLORFGBG)`. The TUI maps it to Mosaic colors
  (TuiApp `toPalette()`), the CLI to 24-bit ANSI (`Style`; Mordant may
  re-encode the SGR codes, that's normal). `t` toggles `HomeState.dark`.
  bgLuma is a real OSC 11 query (`platform.terminalBackgroundLuma()`,
  raw-mode /dev/tty round-trip, ~200ms, fail-soft) that MUST run before the
  screen owns the terminal; CLI `Style` runs it lazily at first styled
  output, TTY-gated, so piped output stays plain and never queries. Color
  is signal: ok/warn/error/dim statuses, accent = headers/actions
  (`Style.header` = bold accent), machine = machine identity, idleBg/idleFg
  = unfocused buttons. No raw ANSI codes or Color.* constants outside
  Theme.kt/cli/Style.kt. Style AFTER padding. CLI presentation is four
  files: `Style.kt` (palette -> ANSI + Clikt theme), `Table.kt`
  (TableRow/echoRows), `Spinner.kt`, `Help.kt` (commandHelp); put new
  presentation where it belongs. `--help` is rendered by Clikt/Mordant, so
  RootCommand installs `Terminal(theme = Style.cliktTheme())`: the detected
  palette mapped onto Mordant's keys (warning = section titles, info =
  option/argument/command names, muted = metavars/tags, danger = errors).
  Without it help keeps Mordant's dark-only defaults and washes out on
  light terminals.
- **Never time a /dev/tty read with `poll()`**: on Darwin poll() answers
  /dev/tty with POLLNVAL, never POLLIN, so the read after a `poll() <= 0`
  guard blocks forever when no reply comes. Style initializes while
  RootCommand builds its Clikt context, so this hangs EVERY command in a
  terminal that swallows the OSC 11 query (a tmux popup running its own
  nested client, `tmux new -A -s floating`). The deadline must come from
  the terminal: cfmakeraw leaves VMIN=1, so set `VMIN=0` + `VTIME`
  (deciseconds) and read() returns 0 on silence. Any future terminal query
  does the same. To reproduce a no-reply terminal: a DETACHED tmux session
  (`tmux new-session -d`) plus `sample <pid>` on a DEBUG binary (release is
  stripped). `script`'s pty is a no-reply terminal too, so
  `t/71-terminal.sh` is the regression test: the query bytes appear
  unanswered and the command must still print its table.
- **A terminal that won't answer is TOLD: `LOADOUT_THEME=dark|light`.**
  Silence means the dark default. tmux passthrough (`ESC P tmux ;` …) does
  not reach a popup's nested client either, so there's no workaround code.
  `theme/forcedDark` is checked BEFORE `terminalBackgroundLuma()` (a told
  palette costs no query); the popup binding is where the platform
  knowledge belongs (`popup -E 'LOADOUT_THEME=$(defaults read -g
  AppleInterfaceStyle >/dev/null 2>&1 && echo dark || echo light) tmux new
  -A -s floating'`). Any other value is a refusal, checked in **Main.kt**:
  the palette is chosen in `object Style`'s initializer, and Kotlin/Native
  wraps a throw from one in `FileFailedToInitializeException` (not a
  `LoadoutException`, so it escapes as a stack trace, contract 9). Anything
  else that must refuse from an object initializer validates in Main too.
- **Unsettled rows are boxed**: `cli/Table.kt`'s `echoRows(List<TableRow>)`
  renders the `diff` and `status` tables. A row with non-null `severity`
  (false = amber, true = red) gets a rounded box; consecutive ones share a
  box (severe if any row is); a row's extra lines (a failing check's
  output) ride inside it. Plain rows get the same 2-column gutter, so
  columns line up; box width is measured with ANSI stripped. Boxed: diff's
  drift (amber) / incomplete (red), status' missing programs (red) and
  pending (amber) / failed (red) scripts, outdated's failed `[outdated.*]`
  sources (red, message clamped to the terminal width: a wrapping box is
  worse than a plain line). Not outdated's update rows: every row there is
  an update, so a highlight would contrast with nothing.
- **One converge pipeline**: `cli/Converge.kt` owns the program half of
  converging: `planPrograms` (re-check + `engine.plan`), `echoPlan` (plan
  table, `extraRows` for setup's scripts), `confirmOrAbort`,
  `installPrograms`. `install` and `setup-new-machine` are thin shells over
  it; scripts are setup's alone. Add converge behavior here, not in one
  command.
- **Slow steps wear the spinner**: anything that can look like a hang
  (version checks, state refresh/write, git pull/push) goes through
  `cli/Spinner.kt`'s `CliktCommand.spinning(message) { ... }`, never a bare
  `echo("Doing x...")` + `runBlocking`. It runs the work on
  `blockingDispatcher` (blocking runBlocking's own thread would freeze the
  spinner) and draws nothing when stdout isn't a TTY. The final line erase
  (`\r` + `ESC[K`) goes out with `print`, not `echo`: Mordant drops it, and
  a shorter line printed next keeps the spinner line's tail.
- **Home screen** (bare `loadout` on a TTY; a pipe gets help):
  `tui/HomeModel.kt` (all state + logic, unit-tested) + `HomeApp.kt`
  (composables). Four subject rows (programs, scripts, remote, fleet), each
  with its verdict and the ONE verb that resolves it. ↑↓/jk move, l/h (or
  →/←) open/close a detail, pgup/pgdn page, enter ACTS (never opens or
  closes; never fires on a busy row). Machine-wide verbs are their own
  keys: r re-check, S sync, U self-upgrade, C setup-new-machine, t theme,
  q quit.
- **One cursor for the whole screen**: `homeLines(state)` flattens the body
  into subject rows plus every OPEN detail's lines, in draw order;
  `HomeState.cursor` walks it one stop at a time (gaps/headers skipped), so
  a table never captures the arrows: `k` off its top row lands on the
  subject row and keeps going. `HomeState.open` is a SET (several details
  open at once); only h/esc on the one under the cursor closes it. `[`/`]`
  jump between headings (not `H`/`L`: a missed shift on `H` would close
  the list you're in). A closed table keeps your place
  (`HomeState.lastRow`), resolved against the CURRENT rows on reopen;
  `snapCursor` re-resolves the cursor after every reshape (nearest stop at
  or above), so an emptied picker doesn't leave the highlight on nothing.
- **esc closes, never quits**: only `q` leaves the screen. With nothing
  open under the cursor, the message line says which key does what ("esc
  closes the list you're in" / "nothing to close — q quits").
- **Remote table** is grouped by the TOOL that will act (`remoteLines`,
  from `OutdatedReport.tools`): a heading per probe (brew and brew-cask are
  one tool) with its declared programs nested under it and an amber "N
  more not in your loadout" line for the sweep's real cost, then each
  custom source as a heading with its items. space selects a tool's whole
  mechanism (ticking any row under it lights up the tool) or a source's
  one item, a selects all, u clears, enter asks and hands off (see below).
  Groups FOLD (h/l); `RemoteLine.foldable` makes an empty heading (a clean
  tool) unfoldable, since folding can't be derived at render time once its
  rows are gone. **A row is keyed by where it came from, never by name**
  (`selectionKey`/`mechanismOf`): a source item named like a mapped
  program (a plugin and a package sharing a name) must upgrade through its
  source, not the program's mechanism. `remoteSummary` names tools with
  work first, then one count of everything else, then the biggest named
  group, then "+N more"; an idle tool is never named, and the two kinds of
  count are never merged (a sweep and N independent pins are different
  work). `K` opens a row's link when its source printed one. Batch oracles
  read STDOUT ONLY: stderr can carry warnings mistaken for package names.
  `l` only opens, never dispatches, so vim keys can't start an install.
- **Scripts row**: maintain-mode scripts in run order with their last
  verdict; anything not done pre-ticked (`preselect`, re-applied after
  every refresh so picks follow verdicts). Enter hands the ticks to `run
  <names> --force`, which re-verifies via the same `refreshAndWriteState`
  the r key uses and names scripts that exited 0 but still fail their
  check ("still not done: x (<first line of its check>)"). **Programs
  row**: the same picker over what the last observation found missing,
  planned with `InstallEngine.plan` (dependencies first, the same refusals
  as `install`) and handed to `install <names>`.
- Every row's answer is in hand: `l` opens it in place, and enter says so
  when there's nothing to open (remotes unreachable, fleet in sync). The
  screen opens on the stored state, then runs a real `status` refresh
  (published like `status`) and asks the remotes, each landing as it
  finishes. The remote row uses the CACHED self-version check (GitHub's
  API is rate-limited and the screen opens constantly); `outdated` asks
  fresh. HomeModel owns no domain logic: StatusEngine/DiffEngine/
  `cli/OutdatedQuery.kt`'s `outdatedReport()` do the work, and every action
  is a real subcommand run through `cli/Actions.kt`'s `dispatch()`.
  Rendering windows `homeLines` and measures each table's column widths
  once a frame from ALL its rows, not just the visible ones.
- **Nothing runs inside the screen; every action is a hand-off.** A command
  inside the screen can't reach the keyboard, and sudo, `gum confirm`
  (`omarchy update -y` asks "Reboot?") and pagers need it.
  - `startUpgrade`/`startScripts`/`startInstalls` plan first (refusals show
    before the screen closes), then `ask()` shows the question pane: one
    row per step, name plus meaning (`upgradeItem`: "all 168 packages · 2
    in your loadout"; a script's description; an install's installer),
    never the command. Buttons Run/Cancel: ←/→, h/l or tab move focus,
    enter presses, y/n press directly, esc/q cancel. The pane is sized to
    its content (`paneLayout`, `READABLE` max width, text wraps).
  - The yes sets `HomeAction.HAND_OFF` + `Handoff(kind, args)` and exits the
    screen. `RootCommand.home` clears the screen (still the alternate one,
    see the frame loop), pauses the model (waits for background checks:
    none may run beside the command or write state after it), prints a
    `━━ loadout <command>` rule, and runs `install --yes` / `run --force` /
    `upgrade … --item <source>/<name> --yes` as a **child loadout under
    script(1)** (`cli/Recorded.kt`): the child gets a terminal, so prompts
    work, and its output is recorded to a transcript in `$XDG_RUNTIME_DIR`
    (Linux) or `$TMPDIR` (macOS). The child is found with `selfExecutable()`
    (`/proc/self/exe`; macOS: the main bundle, in `core/src/macosMain`);
    `recordCommand` builds util-linux's `script -qfec "<cmd>" <log>` or
    BSD's `script -qF <log> <argv…>` from `uname`. `PAGER`/`GIT_PAGER` are
    `cat`: a pager would leave the alternate screen when it exits. Then a
    closing rule (`✔ done` / `✘ exit N` / `interrupted`) and a one-key pause
    (`readKey`: raw `/dev/tty`, no Enter): Enter returns, `v` shows the
    transcript in `less -RX` from the top (`-X` stays on the alternate
    screen; `TRANSCRIPT_AWK` keeps each line's text after its last `\r` and
    drops util-linux's header/footer; awk because BSD sed can't read `\r`),
    `q` or Ctrl-C quits. The transcript is deleted when the user moves on.
  - `HomeScreen.resume()` reopens the same model: cursor (nearest row left,
    `lineNear`), open tables, folds and ticks kept. Rows re-read the state
    file the command wrote; an upgrade also re-asks the remotes, sync/setup
    reload everything, a failure re-checks the machine. Upgrade ticks clear
    on success only.
  - S and C hand off the same way. U (self-upgrade) ends the loop: the
    binary on disk is then a different version.
  - Ctrl-C: `trapInterrupts` installs the C SIGINT handler. A caught signal
    resets to default in children at exec (an ignored one wouldn't), so the
    command's processes stop; loadout survives, and the runner throws
    `InterruptedByUser` at the next child exit so the command stops too.
  - The pane also shows LIST (the "N more not in your loadout" packages),
    with a single Close button.
- **Own frame loop, not `runMosaicBlocking`**: `tui/TuiApp.kt`'s `runTui
  {}` binds the tty (`Tty.tryBind()` + `asTerminalIn`) and drives Mosaic's
  public `Mosaic(...)` composition itself, wrapping every frame in
  synchronized output (`?2026h`/`l`) and hiding the cursor for the app's
  lifetime. Stock Mosaic decides both from a capability handshake it SKIPS
  when the primary DA reply says VT100, which is what tmux answers; under
  tmux it then draws frames in the open with a visible cursor and the text
  flickers. Rendering mirrors Mosaic's `AnsiRendering` (cursor up,
  clear-and-write each row, clear below on shrink); Mosaic's `runMosaic` is
  not used. Needs mosaic-terminal / mosaic-tty / mosaic-tty-terminal as
  compile deps (runtime-only transitives of mosaic-runtime).
  Everything happens on the terminal's **alternate screen** (`?1049h`,
  entered by `runTui`), hand-offs included; `RootCommand.home` leaves it
  (`?1049l`) once, in a `finally`, so quitting gives back the normal screen
  exactly as it was. The alternate screen keeps no scrollback, hence the
  transcript. A command that opens its own full-screen program and quits it
  sends the terminal back to the normal screen; pagers are off for that
  reason, an editor isn't covered. The frame never fills the last row: a
  newline there would scroll the alternate screen.
- **One tty binding at a time**: Mosaic's `Tty.tryBind()` refuses a second
  binding ("Tty already bound") until `Tty.close()`; closing the `Terminal`
  from `asTerminalIn` only resets tty modes. `runTui` closes the Tty in a
  `finally`, which is what lets the hand-off loop reopen the screen in the
  same process. Keep it.
- **The picker opens on the LAST OBSERVED verdicts**: `load()` reads
  `state/<machine>.json`; the refresh that follows re-asks and updates the
  rows in place. A script's verdict is always its check.
- ktoml insurance: the manifest schema sticks to plain nested tables (no
  inline tables / dotted keys). Fallback parser if ever needed: tomlkt.
- `.toml.sample` files in `machines/` and fragment folders never load:
  machine files and the usual fragments globs only match `.toml`.

## Testing conventions

- Unit tests live in commonTest and run on the host native target. No real
  processes or filesystem: `FakeProcessRunner` (scripted stdout/exit codes;
  unregistered command = exit 127) and Okio `FakeFileSystem`.
- `EXAMPLE_MANIFEST` in core's ManifestLoaderTest is the shared fixture.
- Integration = `integration/run-tests.sh`: black-box, real binary. The
  runner sources `lib.sh` (ok/fail, fixtures, `has_pty`/`pty_run`), then
  every `t/NN-*.sh` in name order, each in its OWN fresh directory: a file
  builds its fixtures (`basic_repo`, `scripts_repo`, `scaffold_repo`, or
  inline) and never depends on another file; the numbers only fix the
  order. `manual = "..."` custom install keys keep tests off the host's
  package managers. Add an `ok "..."` test for every user-visible behavior
  change, in the file whose subject it is (new subject = new file); run
  that file with a name pattern while iterating. Never share state across
  files through `$WORK`.
- TUI: reducers (`handleKey`) and pure builders (`sectionsOf`,
  `scriptRowsOf`, `preselect`, `selectionKey`, `homeLines`, `snapCursor`,
  `paneLines`, `upgradeItem`) are unit-tested via `setStateForTest`;
  rendering is verified manually (ask the user) plus PTY probes.
  `t/70-home-screen.sh` (`has_pty`-guarded, `script`-driven) and
  `t/71-terminal.sh` (plain commands: TTY-gated colour, a terminal that
  never answers the background-colour query) run on BOTH platforms;
  `pty_run` branches on `uname` (BSD `script` takes the log then plain
  argv; Linux takes `-qec "<command>"` with the log last). EVERY home-screen
  PTY test calls `fake_release_cache` and passes `XDG_CACHE_HOME=$FAKE_CACHE`:
  the screen asks the remotes on open, and an unmocked self-version check
  is seconds of curl before the remote row settles.
  **Key feeders wait on the screen, never on fixed sleeps** (remote answer
  times vary by machine): `pty_run` flushes its capture as it's drawn (`-f`
  / BSD `-F`), and the feeder blocks on `wait_settled <log>` (every subject
  row shows its verb; busy rows show none, and the refresh starts before
  the first frame), `wait_screen <log> <ERE>…` (a picker, a prompt) and
  `wait_back <log>` (a hand-off's command finished). `seen_after_back <log>
  <ERE>` asserts on the reopened screen only; `seen` matches coloured
  output (escapes stripped). `fake_sudo` prompts on /dev/tty like the real
  one. Match a row's verb by its start: the row under the cursor clips its
  own ("install what's mis…"). Short sleeps between keys that act
  synchronously are fine.

## CI / release

`.github/workflows/ci.yml`: ubuntu (unit + integration + release link) and
macos (arm64 unit tests, both mac release links, integration against the
release binary). It triggers on `main`, but the default branch is
`master`, so it doesn't run yet (README TODO); run all suites locally
before a release. `release.yml` on `v*` tags: strip + tar.gz →
`loadout-<tag>-{linux-x64,macos-arm64,macos-x64}.tar.gz` attached to the
GitHub Release. linuxArm64 builds but isn't released.

`install.sh` (repo root) is the curl|sh bootstrap over those releases: it
resolves latest via the GitHub API (pin: LOADOUT_VERSION) and installs to
~/.local/bin; keep its target names in sync with release.yml. It reads the
installed version BEFORE overwriting, so an upgrade (including `loadout
self-upgrade`, which shells out to it) says "was vX" and skips the
first-install "Next steps". Testable offline via
LOADOUT_DOWNLOAD_BASE=file://… against a local tarball; run-tests.sh covers
both paths on both platforms, staging one stub tarball per release name so
`install.sh` resolves the host's own target (don't repeat that mapping in
the test: a Rosetta shell says x86_64 where macos-arm64 is still right).

## Adding programs to a config repo — the recipe

README's "Recipe: adding a program" is the user-facing long form. Match
top-down, first fit wins:

1. Standard package → `via = [...]` listing ONLY installers where the claim
   is true (via is unverified; a false entry is a mappable lie). The named
   installer usually ships with loadout (`loadout installers`); declare one
   only to add a mechanism or replace a built-in.
2. Different package id → variant with `pkg` (flatpak app ids, renamed casks).
3. Special install command, same mechanism → variant with `command`, keyed
   by the installer so check/probe derive. Key by what it IS: a cask gets
   `brew-cask`, not `brew`.
4. Prerequisite step (tap/repo/remote) → its own program + `depends-on`,
   never `&&`-chained into another program's command. On the variant when
   only that mechanism needs it (a COPR's dnf-plugins-core).
5. Repo-script install that lands in a pm's database → variant keyed by
   that pm with `command = "file:..."`; check/probe derive; override
   `regex` for odd version formats. When several programs need the SAME
   shaped script (rpm repo + key + install), make it an installer with
   `params` and one `file:` pattern; the variants carry only their `with`
   values.
6. Truth not in a package db (dnf groups, virtual provides) → override
   `check` (two-mode script or `--whatprovides`), keep the rest derived.
7. No pm at all → `script` key + program-level `[version]` fallback.
8. Must precede everything (pm config, e.g. dnf.conf) → a program in a
   fragment the first `[layout] fragments` glob loads first (e.g.
   `programs/00_…`): programs precede scripts,
   and dependency-free programs install in declaration order.
9. Nothing to "have" (dotfiles, services) → `[scripts.*]` + check, opted in
   per machine.

Cross-cutting: no `||` chains or trailing pipes in checks; versions are the
mapped pm's truth (rpm's version, not the binary's self-report: expected,
not a bug); `file:` for every repo script (load-time existence check);
prefer repetition over abstraction (no templates, contract 11). Verify
loop: `explain` → map in machines/<name>.toml → `setup-new-machine
--dry-run` → `status`.

Where the check lives: loadout never trusts "it ran once"; everything
converges against a re-askable check, declared where the truth lives via
the resolution chain (variant check → installer check → program
[version]). Program-install scripts are install-only: pm-keyed ones get the
pm-database check derived (recipe 5), pm-less ones fall back to [version]
(recipe 7). Only when neither holds the truth (dnf groups, recipe 6, and
every [scripts.*] step) is there a hand-written check: an inline one-liner
or the script's own two-mode `check` argument. A script file needs a check
mode only if it IS the truth's only oracle.

## Working agreements with the user

- **Everything works on Linux AND macOS** (the user runs both): the Kotlin
  and the shell, in this repo and in config repos. macOS ships BSD tools:
  no `\|` alternation in a BRE (use `sed -nE` with `|`); `cat -A`, `sed -i`
  without an argument, `timeout` and GNU `readlink -f` are absent or
  different; `script` takes its arguments the other way round (see
  `pty_run`). BSD failures tend to be SILENT (a `sed` that matches nothing
  returns empty, not an error). Test here and reason about the other
  platform before claiming done.
- **Stop the Gradle daemon when done**: `./gradlew --stop` at the end of a
  task, not after every build (it keeps rebuilds fast).
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
  and this file. The wiki links into josemiguelo/loadouts as the live
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
