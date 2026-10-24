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
program versions across machines. In a Kotlin DSL, users declare installers
(mechanisms: probe/install/check), programs (install variants over those
installers) and scripts (idempotent setup steps); each machine says which
variant of each program it installs and which scripts it runs. `loadout
compile` (a JVM, on the machine that edits the manifests) turns them into
`loadout.lock.json`, committed, which is all the binary reads. State files
record what each machine has; `diff` compares the fleet.

CLI plus ONE Mosaic screen, the home screen (bare `loadout`). It observes,
then hands every action to the matching command on the real terminal and
comes back; it runs nothing itself and owns no domain logic. No other TUI:
a screen that re-displays what commands print, or a second picker for
something a home-screen row already does, is not wanted.

Formerly `post-installer`: the working directory and some external
references may still use that name. Never reintroduce it in code.

## Build, run, test

```sh
./gradlew :app:linkDebugExecutableLinuxX64          # dev binary
./app/build/bin/linuxX64/debugExecutable/loadout.kexe --help
./gradlew :app:linkReleaseExecutableLinuxX64        # optimized (slow)
./gradlew bundle                                    # share dir: DSL + plugin + wrapper (build/bundle)

./gradlew :model:linuxX64Test :model:jvmTest        # model, assembly, lock
./gradlew :dsl:linuxX64Test :dsl:jvmTest            # the DSL
./gradlew :core:linuxX64Test                        # core unit tests
./gradlew :app:linuxX64Test                         # home-model unit tests
./integration/run-tests.sh [path-to-binary] [pattern] # black-box suite (default: debug binary)
./integration/run-tests.sh home                     # only t/*home*.sh
```

All suites must pass before claiming work done. The integration script
builds nothing: link the binary and run `bundle` first. A command run by
hand needs `LOADOUT_HOME=build/bundle` for `compile` and `init` (the
installed binary finds its share dir beside itself).

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

**Ctrl-C in a hand-off**: every hand-off runs its command as a child loadout
under script(1) (Recorded.kt), so the parent loadout never gets Ctrl-C. The
child is started with `LOADOUT_HANDOFF=1`: it traps SIGINT (Main.kt), stops,
and exits 130, the one exit both util-linux and BSD script pass on
unchanged. The home screen reads 130 as "interrupted". BSD script reports a
signal-killed child as the signal number (2), so don't rely on a child being
killed by SIGINT. `70-home-screen` checks Ctrl-C on both platforms.

Manual testing target: the user's live config repo (`$LOADOUT_REPO`: chezmoi's
source, `~/.local/share/chezmoi`; machine name = hostname; the user's machines run Omarchy/Arch and macOS).
`status`/`diff`/`--dry-run` against it are fine; installing/removing
packages or pushing git needs the user's OK. Opening the home screen
writes the machine's state file there.

## Architecture

Five Gradle modules. The binary's (`:app`, `:core`) are native only
(linuxX64, linuxArm64, macosX64, macosArm64; macosX64 is deprecated
upstream but kept); `:model` and `:dsl` are native AND JVM, so the binary
and `loadout compile` share one model and one set of error messages;
`:gradle-plugin` is JVM. The Compose plugin is on `:app` only.

```
model/  loadout.core (the binary's and the DSL's common ground)
  LoadoutException — supertype of every refusal (contract 9); TOOL_VERSION
               (generated from gradle.properties by `generateVersion`)
  model/       Manifest (@Serializable, what the lock holds; owns
               resolveInstall/checkFor/dependenciesOf/forMachine — variant ×
               installer resolution), shellLine (file: + PATH prefix)
  manifest/    ManifestAssembler — draft -> Manifest: built-ins merged,
               installer requires applied, profiles flattened (contract 2),
               validated, file: paths checked, maps sorted; installOrder/
               scriptOrder (ties by name). assembleWithoutFiles is TEST-ONLY
               Lock/LockFile — loadout.lock.json codec, format check, sources hash
               InstallerLibrary — the built-in installers, as Kotlin values
               ChezmoiData — the templates' data file and partial
               MachineData — data merged, validated, compared; Glob
dsl/    loadout.dsl
  Dsl.kt       repo/program/script/installer/profile/machine builders;
               Origins (a declaration's folder, from its file), Dir (another)
  MachineData  typed data schemas (delegated keys that record what was set)
  Registry     where declarations land; buildManifest/manifestOf for tests
  jvmMain Compile.kt — `loadout compile`'s last step: map each source
               file's name to its folder, initialise every compiled class,
               assemble, write the lock (and, with configs, the chezmoi
               data and partial)
gradle-plugin/  loadout.gradle.LoadoutPlugin — Kotlin/JVM over exactly the
               files `loadout { sources(…) }` globs match (our Glob), the DSL
               at the plugin's version, `loadoutCompile`, the build outside
               the repo
core/  loadout.core
  manifest/    ManifestLoader — reads the lock: missing/newer/stale/floor
               refusals, file: paths re-checked; readLayout reads it alone
  state/       StateStore — <state>/<machine>.json via Okio; pretty JSON, stable order
  exec/        ProcessRunner interface + KommandProcessRunner (kommand); ALL
               process use goes through the interface (tests use
               FakeProcessRunner). capture (blocking), inherit (sudo/progress),
               each taking a ShellCommand (line, cwd, env); manifest commands
               build one through CommandFrame (contract 5); plain strings are for
               git/probes/self-version.
               A child killed by a signal reports -1 (kommand's wait() throws
               for it); Ctrl-C during a home-screen hand-off throws
               InterruptedByUser once the child exits
  detect/      Detection — os/distro/hostname + isBinaryAvailable (`command -v`)
  engine/      VersionChecker (concurrent checkAll), UpdateChecker (outdated
               oracles; exit code deliberately ignored), InstallEngine
               (plan/execute), UpgradeEngine (planner only: which mechanisms
               this machine can upgrade, one step per command, refusals;
               `upgrade` runs and verifies, the home screen plans with it to
               describe steps and refuse early), ScriptRunner, ConfigEngine
               (chezmoi over the repo's configs dir: units, drift, edited files,
               the apply command; contract 17), StatusEngine (observes
               programs, scripts AND configs; all checks concurrent, read-only)
  diff/        DiffEngine — pure: manifest × states -> DiffReport
  git/         GitClient — shells out to `git`, cwd = repo root
  platform/    expect/actual posix: hostname, isatty, uname, nowIso, envVar,
               terminal size/background, trapInterrupts/takeInterrupt (C
               SIGINT handler in nativeInterop/cinterop/signals.def),
               blockingDispatcher (= Dispatchers.IO)
app/   loadout
  Main.kt      Clikt dispatch (bare invocation without a TTY prints help).
               Catches LoadoutException (+ okio.IOException) -> "error: ..." + exit 1
  cli/         AppContext (shared services, suspend refreshAndWriteState;
               loadManifest() is the lock as this machine sees it) + one file
               per subcommand (status/explain/installers/setup-new-machine/
               install/upgrade/self-upgrade/outdated/run/apply/diff/sync/init/
               compile). LoadoutHome finds the share dir. SelfVersion is the
               one remote self-check: status footer (6h cache, Okio,
               fail-soft) + outdated self-row (fresh). `self-upgrade` shells to
               INSTALL_COMMAND and needs no repo, so it works under a
               min-tool-version refusal (which points at it)
  tui/         HomeModel (ALL state + logic, no rendering, unit-tested) +
               HomeApp.kt (composables, HomeScreen) + TuiApp.kt (palette,
               frame loop)
```

## Design contract — do not violate

Explicit user decisions; don't "improve" them away.

1. **No package-manager auto-detection, no `--pm` flag or env override.**
   The only source of variant choice is the machine and the profiles it
   extends (`via(dnf) { install(curl) }` names a program's variant key).
2. **Mapping = membership + strict fail-fast resolution.** A program a
   machine doesn't install is not in its loadout: converge skips it, status
   doesn't observe it, diff shows "-".
   - **Declarations** (a `machines/` folder, a file per machine and per
     profile, or one `machines.loadout.kt`): `profile(name = …) { … }` and
     `machine(hostname = …) { … }`, each with two verbs.
     `via(installer) { install(programs…) }` maps each program to that
     installer's variant (the block's only verb: a `@DslMarker` keeps the
     machine's `run` and its other `install` out of it, so a line inside
     always installs through the block's installer); `install(programs…)`
     outside a block takes programs with exactly ONE variant
     (more is a compile error naming them: no choosing for you) and named
     variants (`setupBrew.variant(name = "linux")`), mixed. `run(scripts…)` and
     `run(script, args…)` opt scripts in; `run(script.variant(name = "arch"))`
     picks a script variant. A program installed twice or a script run
     twice in one machine is an error. A machine is named by its hostname,
     so the lock (and chezmoi templates reading it) find it.
   - **Profiles**: `extends(…)` names profiles only (a machine is never
     extended); profiles may extend profiles (cycles are errors). A
     machine's profiles are combined first: two of one `extends` list
     setting a program's variant, a script's arguments or variant, or a data
     key differently is an error (equal values are fine), so their order
     never changes the result. Then the machine overrides them (mapping per
     program, scripts by name, `data` table by table, lists replace).
     Profiles are flattened, validated, then dropped: never observed,
     diffed or converged. No subtraction: a profile's entry is a promise
     every machine extending it keeps.
   - **`data`** is a typed schema: a `MachineData` class whose delegated
     properties are the keys with their defaults (`var work by
     flag(false)`, `val kitty by table(::Kitty)`), named by
     `repo(data = ::Data)`. `data { work = true }` type-checks; each
     instance records what was set, which keeps the profile-conflict error.
     Every machine ends up with all declared keys (`MachineData` in model;
     bare `explain` shows them); the lock holds each machine's merged table.

   `setup-new-machine` throws ResolutionException before
   executing anything if the machine isn't declared, an EXPLICITLY
   requested program is unmapped, a mapped program's dependency is
   unmapped, or a mapped known PM's binary is absent (probed). No automatic
   `script` fallback.
3. **Intent and observation never mix.** The Kotlin manifests are authored;
   `loadout.lock.json` is generated from them and committed (`loadout
   compile` writes it, and only when its content changed); the
   state directory is generated and disposable. With configs,
   compile also writes `<configs>/.chezmoidata/loadout.json` and the
   `<configs>/.chezmoitemplates/loadout/machine` partial (contract 17),
   generated and committed like the lock. Nothing hand-edited goes in
   state, the lock or those two; the tool never writes authored files,
   except `init` scaffolding.
4. **Scripts: exactly one of `file` (path) or `run` (inline)**, per variant
   when a script has variants. `run(…)` and `check(…)` take several
   commands, joined with `&&` (`allOf`); one holding `||` or `;` is
   grouped in `{ …; }` first, so the join can't change what it means.
   Variant commands, installer patterns, oracles, `outdated` commands
   (program and custom source) and all check commands may name a repo
   script: `runScript("x.sh args…")` (stored with the `file:` prefix;
   `installedBy("x.sh")` for a variant's install, and `managedBy`,
   `updatesManagedBy` and a script's `file(…)` imply it), so a manifest
   never writes `file:` itself. Every path is relative to the directory of
   the file that declared it (its `origin`; "" = the repo root, also for
   built-in installers): the top-level `program`/`script`/`installer`/
   `outdated` take their file's folder, so moving a file with its scripts
   needs no edit. `Dir("x").program(…)` declares for another folder (and
   is what tests and `manifestOf` use; without a compile, origins are the
   root). `loadout compile` maps each manifest file's NAME to its folder
   (`manifestFolders`; names are unique, checked) and `Origins.resolver`
   walks the stack to the first frame whose source file is a manifest
   (the JVM records the file name on every class, so top-level code, an
   `object`'s and a lambda's all count); a declaration with no manifest
   frame is refused, named. An `object` groups declarations under a
   namespace (`object Omarchy { val brave = script(…) }`, run as
   `Omarchy.brave`); inside it a member shadows a top-level name, so the
   program is `repo.brave` (the package), which is why the repo's
   `repo(…)` val isn't called `repo`. Paths are kept as written, and
   validated at compile AND at every lock load to exist without leaving
   the repo (`..` inside one is fine: a shared helper). Expansion is
   centralized in model.expandFilePrefix/shellLine, applied at the
   execution sites. Tokens after the first space are arguments
   (`file:path args…` → `sh 'path' args…`), so script paths can't contain
   spaces. A variant's param value given as `file("repos/x.repo")` is a
   path too, relative to the program's directory and validated the same
   way; it is substituted as `$LOADOUT_REPO/<repo path>` because the
   installer pattern it lands in runs in the installer's directory.
   Plain values (a URL) pass through.
5. **Every manifest command runs via `sh -c` in its declaring file's
   directory** (installs, scripts, version checks, `check`s, oracles,
   upgrades), whatever the invocation directory, with `LOADOUT_REPO`,
   `LOADOUT_FRAGMENT_DIR` (= that directory), `LOADOUT_MACHINE`,
   `LOADOUT_OS` (`linux`/`macos`) and, with configs,
   `LOADOUT_CONFIGS`, all absolute (`CommandFrame.of`, via
   `AppContext.frame`). A command takes the origin of the file that WROTE
   it: an installer pattern runs in the installer's directory, a variant's
   own `command`/`check`/`outdated` in the program's (`resolveInstall`).
6. **Execution order**: all programs before all scripts; programs
   topologically by dependencies, ties broken by NAME (installOrder sorts;
   a Kotlin repo has no natural declaration order across files: a file's
   values initialise when another file first uses them); scripts by
   `runAfter` edges, ties by name. Whatever must come first says so.
   Sequential, never parallel (only read-only checks run concurrently).
   `runAfter` orders but never pulls anything in; dependencies pull in
   transitively. A program's dependencies (`Manifest.dependenciesOf`) are
   its own `dependsOn`, the mapped variant's (a COPR's dnf-plugins-core
   never lands on a pacman machine), and what the variant's INSTALLER
   `requires` of everything it installs (`brew.requires(setupBrew)`; the
   required program is exempt from its own installer's rule). Validation
   and cycle detection count every variant's edges.
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
   A **yes/no check** (`present("…")`, `managedBy` without a version regex)
   has no regex: exit 0 is installed with no version recorded, so a setup
   step that is a program (setup-dnf, a flatpak remote) needs no fake
   version string.
8. **State files**: written only for this machine; `updatedAt` bumps only
   when content changed (clean git history; `sync` is a no-op when idle).
   Unknown JSON keys are ignored on read.
9. **Errors are clean one-liners** (`error: ...`), never stack traces. Every
   refusal extends `loadout.core.LoadoutException`, caught once in Main.kt
   (plus `okio.IOException`, which isn't ours), so a new failure type needs
   no new catch block. A test asserts the hierarchy.
10. **Product code loads manifests via `ManifestLoader.loadRepo`** (the
    lock, checked) and sees it through `Manifest.forMachine` (its script
    variants picked; `AppContext.loadManifest` does both).
    `ManifestAssembler.assembleWithoutFiles` / `manifestOf {}` are for
    tests only: they skip the `file:` checks, and everything else —
    built-ins, flattening, validation — is the production path.
11. **No templates.** Kotlin makes abstraction free; keep it to plain
    values: shared lists (`val everydayCli = listOf(…)`), a small function
    that saves repeating two `run`s (`sshKey(name)`), a typed wrapper for an
    installer's params (`tap(…)`). Nothing that generates programs or
    machines: a reader must find every program by name in one place.
12. **Scripts are opt-in per machine**: `run(script)` / `run(script,
    args…)` in a machine or profile. Each argument is one or more words;
    the machine's entries are "name args…", parsed by `scriptEntry` (args
    re-joined with single spaces because they're pasted into a shell
    command line, where a newline would run the next line as a command).
    Only opted-in scripts converge and are observed; `run` errors on others.
    Args become positional params for the file script AND its check (`set
    --`, see ScriptRunner.withArgs); `managedBy("x.sh")` checks with `x.sh
    check "$@"`, so a managing script gets them in both modes. Args on an
    inline script are an error. No implicit script application, no OS or
    bootc detection deciding membership (the old `os` filter is gone: the
    machine's opt-in decides). A script's modes (`setupOnly()`,
    `maintainOnly()`, default both) scope EXECUTION only: setup-new-machine
    converges setup-mode scripts, the home screen's scripts picker lists
    maintain-mode ones; status observes all opted-in scripts and `run`
    ignores modes. A script may declare `variant(name = …) { … }`s (its own
    file/run, check, runAfter; description, modes and needsSudo shared); a machine
    running it must pick one, and engines only see the picked one
    (`forMachine`).
13. **Installers own mechanics; variants refine them.** An installer
    (`probe`, `install`, `check`, `regex`, `outdated`, `outdatedAll`,
    `upgrade`, `needsSudo()`, `params(…)`; `{pkg}` substituted) defines a
    mechanism once, repo-unique. Core
    ships a library (`model/.../InstallerLibrary.kt`: dnf, dnf-repo,
    dnf-copr, brew, brew-cask, flatpak, pacman, omarchy, omarchy-aur with
    oracles; apt install/check only) as Kotlin values (`Builtin.dnf` in the
    DSL), merged UNDER the repo's own at assembly: a repo installer of the
    same name replaces the built-in outright, and `Manifest.builtinInstallers`
    records which survived so `explain`/`installers` label `(built-in)` vs
    `(repo)`. `Installer.requires(programs…)` adds to any installer,
    built-ins included, without redefining it. Knowledge, never detection:
    nothing probes the machine to pick an installer.
    A program lists every variant through `installVia(…)`: an installer as
    it is (`brew`), or configured where it's named (`brew(pkg = "vim")`,
    `dnfCopr(copr = …)`, `dnf { managedBy("x.sh") }`). Calling an
    installer builds an `InstallMethod` (a `ConfiguredInstaller`) and
    registers nothing; `installVia` registers what it's given, keyed by the
    installer's name, so a variant never reads like a command being run.
    `custom(name = "linux") { … }` is the one variant outside `installVia`:
    a command with no installer (named only when a program has several).
    Naming an installer twice is an error, so there is no hidden merge.
    Every field is optional and defaults from the installer; `pkg` defaults
    to the program name. An
    installer may declare `params(…)`: values a variant supplies
    (`param("copr", …)`, or a typed wrapper: `dnfCopr(copr = …)`,
    `dnfRepo(repofile = …)`), substituted like `{pkg}`. All declared, never
    inferred: a missing param or an undeclared one is an error, so an
    unsubstituted `{placeholder}` never reaches a shell.
    Resolution (`Manifest.resolveInstall`/`checkFor`, used by every
    engine/UI): command → installer install pattern (else error); check →
    variant check → installer check (else program `version`); probe →
    installer probe (else none); outdated → variant override, else
    installer `outdated-all` (one batch command per installer, per-program
    regex extracts; binaries that don't know it fall back to per-pkg), else
    installer per-pkg pattern, else no oracle (`outdated` skips and says
    so). These oracles' exit codes are always ignored. A program's
    `path(…)` puts directories first on PATH for its commands (`shellLine`),
    so a check never needs `tool || $HOME/.local/bin/tool`.
    Repos may also declare custom `outdated` sources: on the script they're
    about (inside `script { }`, named after it unless named) or alone
    (`outdated(name = …, command = …)`). The usual form is
    `updatesManagedBy("x.sh")`: `x.sh` lists, `x.sh update <item>` updates
    one row (on a program, `x.sh` prints the newest version and `x.sh
    update` updates it); `outdated(command = …, upgrade = …)` is the long
    form for anything else, a read-only source included (`<item> <current>
    <candidate> [note…]` lines; a URL in the note becomes the row's link,
    opened with `K`; `runScript(…)` allowed, repo-unique). Unlike installer
    oracles, a source's exit code is NOT ignored: non-zero surfaces as
    `outdated source [name] failed: ...`, so a crashing oracle can't hide
    updates.
    Installers may declare `upgrade`: the ONE command that moves everything
    the mechanism manages, with no `{pkgs}` placeholder (contract 15).
    Never write cross-variant `||` chains in checks.
    `needsSudo()` (installer, variant, script, `outdated` source) declares
    a command that needs sudo's password without saying `sudo` itself
    (`omarchy pkg add`, a repo script); a variant's replaces its
    installer's. `setup-new-machine`, `install`, `run` and `upgrade` ask
    for the password once, after the confirmation and before the first
    step (`askForSudoUpfront` in cli/Converge.kt), when their plan holds a
    step that needs it: declared, or a command matching `commandNeedsSudo`
    (core/engine/Sudo.kt: the word sudo, not "pseudo"). Scripts count only
    while pending (`ScriptRunner.pending` asks the check, which `run` asks
    again). Valid credentials ask nothing; a refusal stops the run before
    any step. A background shell loop then runs `sudo -n -v` every 50s
    while loadout's pid lives, checked every second (`SUDO_KEEPALIVE`), so
    a step an hour in finds them valid. Never inferred from a script's
    content: an undeclared sudo inside a repo script still prompts
    mid-run, on the terminal, as before. Home-screen hand-offs get this
    for free: each runs one of these subcommands.
14. **Versioning contract.** The deliberate breaks: 0.2.0 (string install
    values became variant mappings), 0.9.0 (`templates` removed), 2.0.0
    (TOML to YAML), 3.0.0 (YAML removed: manifests are the Kotlin DSL,
    compiled into the lock) and 3.1.0 (`install(installer, programs…)`
    removed for `via(installer) { install(…) }`; kept a minor release
    because the lock format didn't change). A removal is decided once, loudly, in the
    release notes, never silently. The DSL and the binary are one version
    (the DSL ships in the binary's share dir, so a repo compiles against
    exactly the installed binary's). The lock carries `format` (bumped only
    when an older binary could misread a lock; a newer one is refused by
    name before anything else is read) and the `toolVersion` that wrote it:
    a binary refuses a lock from a newer MINOR (patch releases never change
    what a lock means), naming `self-upgrade`. `meta minToolVersion`
    (`repo(minToolVersion = …)`) is a floor the repo declares on top.
    New lock fields are additive with defaults. State files with
    `schemaVersion > StateStore.SCHEMA_VERSION` are skipped with a warning
    (`StateStore.lastWarnings`; new read paths must echo/log them). Bump
    SCHEMA_VERSION only for a real schema break; handle older schemas via
    defaults.
15. **Converge installs; `upgrade` upgrades, a whole mechanism at a time.**
    `setup-new-machine`/`install` add what's MISSING and never touch a
    version already there. Moving versions is its own verb, `loadout upgrade
    <installers…>|--all` (`UpgradeEngine`), never single packages: naming a
    program is an error pointing at its mechanism. Mechanisms sharing a
    command (dnf, dnf-repo, dnf-copr all run `dnf upgrade -y`; omarchy and
    omarchy-aur both `omarchy update -y`) are ONE step,
    deduped by command; the UI groups by the TOOL they drive (their probe),
    so ticking a brew row ticks casks too. `plan` refuses an installer this
    machine doesn't map, so a repo mapping nothing to brew can't sweep it.
    Custom `outdated` sources upgrade per item: their update command
    (`x.sh update <item>` under `updatesManagedBy`, or `upgrade = "… {item}"`)
    runs once per row (`upgrade --item <source>/<name>`),
    since items (a pin, a clone) are independent and one failure shouldn't
    stop the rest; a source without it is read-only (`[–]`). Afterwards
    EVERY mapped program is re-checked, since the transaction can move
    packages loadout doesn't declare. The binary's own update is
    `self-upgrade`, which needs no repo, so it survives a version-floor
    refusal. Both refusals of a too-old binary (floor, newer minor) are
    `ToolTooOldException`, carrying the version needed. `sync` catches it
    after its pull: it refuses when the latest release is still below it,
    else runs the install and then the same sync with the binary it was
    started from (its path read BEFORE the install: Linux names a replaced
    `/proc/self/exe` "(deleted)"), under `LOADOUT_SYNC_UPGRADED=1`, which
    turns a second refusal into an error instead of another upgrade. The
    home screen ends after an S whose repo now refuses its binary
    (`ManifestLoader.toolTooOld`), like after U. Only `sync` upgrades by
    itself: it is the command that pulls, so it's the one that meets a
    repo moved ahead of the binary.
16. **The repo's shape is declared, never assumed.** A config repo is a
    Gradle project (settings.gradle.kts + build.gradle.kts as `init`
    scaffolds them, plus the wrapper); `loadout { sources(…) }` in
    build.gradle.kts lists the manifest globs, and only files they match
    compile (`Glob`: `*` one segment, `?` one char, `**` any depth;
    wildcards never match a leading dot, so `.tmux.loadout.kt` compiles only
    when a glob spells the dot; `.git` is never entered). The plugin hands
    Kotlin exactly the files our Glob matches (not Gradle's Ant patterns,
    whose `*` does match a leading dot), so the compiled set is the hashed
    set. `repo(state = …, configs = …)` names the state and chezmoi dirs;
    `state` is required, with no default. The lock records the globs and
    a sha256 of the files they match (path + content); a binary that finds
    them changed refuses with "run: loadout compile", so a lock never
    silently lags its sources. The source root is the repo itself (narrowed
    by includes), and an editor's Gradle import (kotlin-lsp's) drops the
    includes and indexes everything under it: a build/ in the repo is a
    second copy of every declaration. So the plugin builds in
    `${XDG_CACHE_HOME:-~/.cache}/loadout/build/<folder>-<path hash>` (set
    before the build script runs, so a repo's own setting wins), and
    `compile` names a leftover `build/classes` for deletion. The suite runs
    with its own XDG_CACHE_HOME (seeded with a release, so `status` doesn't
    ask GitHub), so its compiles never land in the developer's cache.
17. **Configs are chezmoi's, observed like everything else.** `repo(configs = …)`
    names chezmoi's source directory inside the repo; unset, there
    is no configs concept and chezmoi is never called. Every chezmoi call is
    `chezmoi --source <repo>/<configs> --no-pager …` (`ConfigEngine`), so a
    `--repo` worktree is observed and applied from that worktree, never
    from chezmoi's own configured source.
    - **Units**: `.config/<name>/…` is unit `<name>`, any other target its
      first path segment (`.zshenv`, `.local`), from one `chezmoi managed
      --include files,symlinks` per refresh. Not opted in: `.chezmoiignore`
      is chezmoi's membership. A unit may share a program's name (tmux);
      `explain <name>` shows both.
    - **Drift is observation** (contract 7): one `chezmoi status --include
      files,symlinks` per refresh. Its second column is what `apply` would
      change (the same answer as `chezmoi verify`, in one call); a unit with
      any such file is `drifted`, with them in `ConfigState.files`. Its
      first column marks a file edited since chezmoi last wrote it.
    - **chezmoi can't answer** (absent: exit 127; a template error): the
      units last seen are `unknown` with chezmoi's line as the reason, and
      `status` says it once (`StatusEngine.lastConfigsDown`); never a
      refusal for status.
    - **Writing**: `apply [unit…]` and `sync` run `chezmoi apply --no-tty`
      (a unit = its targets, absolute via `chezmoi target-path`). Without a
      terminal chezmoi aborts the whole apply on a file edited in place
      (it would ask), so both refuse first when a file they'd replace is
      edited AND drifted (`refuseEdited`), naming the files: keep them with
      `chezmoi re-add`, or replace them with `apply --force`. `sync` =
      pull → (upgrade loadout, contract 15) → refuse edited → apply →
      refresh → name what's left (missing programs, scripts not done) →
      commit → push; nothing is committed after a refusal or a failed
      apply. It never installs or runs scripts itself.
    - **State**: `MachineState.configs`, left out of the file when empty
      (`@EncodeDefault(NEVER)`), so repos without configs write what they
      always did and older readers ignore it (schema stays 1). `diff`
      shows a CONFIG table (`-` = the machine doesn't report that unit)
      and exits 1 on config drift.
    - **Templates' data**: `loadout compile` writes `<configs>/
      .chezmoidata/loadout.json` (`ChezmoiData`), which chezmoi loads into
      every template as `.loadout`: `loadout.defaults` (every declared key)
      and `loadout.machines.<hostname>` (each machine's merged table). That
      shape is the contract with templates; the lock's layout stays
      loadout's own (templates reading the lock broke on any change to it).
      Compile also writes the partial that picks this host's table,
      `<configs>/.chezmoitemplates/loadout/machine` (`ChezmoiData.PARTIAL`:
      `get .loadout.machines .chezmoi.hostname | default
      .loadout.defaults`), so a repo's templates read their machine with
      `includeTemplate "loadout/machine" . | fromJson` and the partial
      always matches the data's shape. The `loadout/` folder keeps it apart
      from the repo's own templates. Every load re-renders both from the
      lock and refuses a missing or different file ("run: loadout
      compile"), so dotfiles never render from data the manifests don't
      say. `init --configs` scaffolds such a repo (`repo(configs =
      "configs")`, a `.chezmoiroot`, `configs/`).

## Toolchain facts — don't rediscover

- **Kotlin ≥ 2.4.0**: clikt 5.1.0 klibs use ABI 2.3.0. Mosaic 0.18.0 works
  on 2.4.0. Repos: mavenCentral + **google()** (Compose androidx deps).
- **clikt duplicate-symbol linker error**: clikt + clikt-mordant both define
  `Context.selfAndAncestors`; fixed by `disableNativeCache(...)` on **all**
  binaries (`target.binaries.all`) in app/build.gradle.kts, test binaries
  included. The `kotlin.native.cacheKind` properties don't work.
- **Kotlin nested block comments**: `/*` inside a KDoc (e.g. a glob like
  `programs/*.loadout.kt`) opens a *nested* comment and eats the file. Word
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
  pending (amber) / failed (red) scripts, outdated's failed custom `outdated`
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
  (composables). Subject rows (programs, scripts, configs — only with
  `repo(configs = …)` —, remote, fleet), each with its verdict and the ONE
  verb that resolves it; tests find a row by subject, never by position. ↑↓/jk move, l/h (or
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
- **Configs row**: every unit the last observation saw, with its verdict
  and drifted files; drifted ones pre-ticked (`preselectConfigs`). Enter
  first asks chezmoi which ticked files were edited on this machine
  (`ConfigEngine.edited`): any, and the message line names them and the
  screen stays (the choice between `chezmoi re-add` and `apply --force`
  is made in a terminal, never from the screen); none, and it asks, then
  hands off `apply <names>`. The fleet row and its table count config
  drift too (`FleetLine`: a program or a config).
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
  - S and C hand off the same way. U (self-upgrade) ends the loop, and so
    does an S that upgraded: the binary on disk is then a different version.
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
- **Manifests are Kotlin, compiled on the JVM; the binary reads JSON.**
  `loadout compile` runs `./gradlew -q loadoutCompile` in the repo with
  `LOADOUT_HOME` set, output held until it fails (a spinner otherwise);
  on success only its `warning: ` lines are shown.
  The plugin is resolved from `$LOADOUT_HOME/maven` at `$LOADOUT_HOME/
  VERSION` (settings.gradle.kts reads it), and adds that repo for the DSL.
  Inside `pluginManagement { plugins { } }`, `java` is the java plugin's
  accessor: compute the version outside that block (`java.io.File(...)`
  there doesn't resolve). Compile.kt initialises every compiled class in
  name order (`Class.forName(name, true, …)`); top-level declarations
  register as their file's facade initialises, a cross-file reference
  initialises the other file first, and an initialiser's throw is
  unwrapped so a DSL mistake prints as `error: …`.
- **Named arguments are the house style**: declarations and calls with a
  non-obvious string say what each is (`program(name = …, description =
  …)`, `machine(hostname = …)`, `custom(name = …)`, `variant(name = …)`,
  `version(command = …, regex = …)`, `brew(pkg = …)`, `tap(tap = …)`).
  Kotlin can't require them; the repo, `init`'s scaffold and the docs use
  them. A call with both a name and a description puts each on its own
  line, however short (`program(⏎ name = …,⏎ description = …,⏎) {⏎ … ⏎}`),
  with a blank line between it and the next declaration. A program's body
  is always on its own lines, even a single statement, nested variant
  blocks included (one statement per line, no `;`). `installVia(…)` lists
  every entry on its own line with a trailing comma, even one; a program
  has one `installVia`, a comment about an entry sitting beside or above it
  inside. Obvious one-argument calls (`file`, `run`, `check`, `managedBy`,
  `present`, `runAfter`) stay positional.
- **Kotlin `$` in shell strings**: both `"…"` and `"""…"""` substitute
  `$name`. The DSL's `HOME` and `USER` constants are the shell's own
  `$HOME`/`$USER`, so `"$HOME/.local/bin"` reads as shell and reaches it
  unchanged; any other shell variable is written `\$1`, and a raw string
  needs `${'$'}`.
  Prefer repo scripts (`managedBy`, `runScript`) for anything longer than
  a line.
- **Manifest file names are unique**, and compile refuses two of one name:
  every manifest is in `package repo` (no imports between them), Kotlin
  compiles each file's top-level code into a class named after the file,
  and a declaration finds its folder by its file's name. A manifest beside
  a config is `.<unit>.loadout.kt` (the leading dot keeps chezmoi from
  deploying it; the glob `configs/**/.*.loadout.kt` spells the dot).
- **References go one way between a file and its object**: Kotlin
  initialises a file's top-level values when any is first read, and an
  `object`'s members when it's first read. A member that reads a top-level
  value of its own file while a top-level value there reads the member
  sees null (mise's file had both: `Mise.tools` after `mise`, and
  `javaMacosIntegration` after `Mise.tools`). Everything that refers to an
  object's members goes inside it. The DSL turns the null into "<who>
  refers to something not declared yet" (`declared`), since Kotlin's own
  failure is a `NoWhenBranchMatchedException` deep in the DSL.
- **Compile warns about what no machine uses** (`dsl/Unused.kt`): a
  profile no machine extends, a program none installs (dependencies
  count), a script or script variant none runs, a repo installer nothing
  in use goes through. A way to install a program that no machine picks
  is reported only when some machine uses that installer for OTHER
  programs ("machine 'm' installs other programs via 'dnf', but not fzf"):
  `installVia` lists every true claim, so a variant through an installer
  nobody uses (a scaffold's ripgrep via apt, a COPR for a future Fedora
  machine) is the recipe, not a mistake. Warnings, never refusals: the lock is written either way.
  `spare(reason = …)` marks one kept on purpose (on the profile, program,
  variant, script variant, installer); a spare profile's contents count as
  used, and a spare mark on something used is itself a warning, so marks
  can't go stale. A machine can't be spare.
- **Transitional scripts end themselves through compile**
  (`dsl/Transitional.kt`): `transitional()` marks a script that only
  exists until every machine has done it (a cleanup after a change). It is
  a compile-time mark like `spare`, kept in the Registry and never in the
  lock, so binaries are untouched. Compile reads `<state>/<machine>.json`
  for every machine that runs it and warns "delete it" once all of them
  report it `done`; a machine without a state file hasn't done it. Done
  means its check passes (contract 7), so a transitional script needs a
  check (on itself, or on every variant), and the mark goes on the script,
  never a variant. This is loadout's answer to migrations: no ledger of
  what ran, since a fresh machine's check already passes; history-only
  steps (nothing on disk can tell) stay manual instructions.
- **A profile's long block can live beside its scripts**: `fun
  MachineScope.omarchyBar() { run(…) }` in the scripts' file, called from
  the profile. The calls record only references, so where the function
  lives changes nothing in the lock.
- **The lock always says its format**: the lock's Json drops defaults
  (short, diffable), so `Lock.format` carries `@EncodeDefault(ALWAYS)`;
  without it format 1 vanished and an old binary couldn't refuse a newer
  lock by name.
- **JVM 17**: `:model`, `:dsl` and `:gradle-plugin` target JVM 17, what a
  config repo's Gradle may run on; the build itself uses JDK 21.

## Testing conventions

- Unit tests live in commonTest and run on the host native target. No real
  processes or filesystem: `FakeProcessRunner` (scripted stdout/exit codes;
  unregistered command = exit 127) and Okio `FakeFileSystem`.
- Fixtures are written in the DSL: `manifestOf { … }` (TEST-ONLY,
  contract 10) in engine and screen tests, `buildManifest { … }` plus
  `ManifestAssembler.assemble` over a FakeFileSystem where `file:` checks
  matter (dsl's AssemblyTest). `EXAMPLE_MANIFEST` in core's
  commonTest/ExampleManifest.kt is the shared fixture. Validation and
  assembly behaviour is tested in `:dsl`/`:model` (JVM and native), the
  lock reader in core's ManifestLoaderTest.
- Integration = `integration/run-tests.sh`: black-box, real binary. The
  runner sources `lib.sh` (ok/fail, fixtures, `has_pty`/`pty_run`), then
  every `t/NN-*.sh` in name order, each in its OWN fresh directory: a file
  builds its fixtures (`basic_repo`, `scripts_repo`, `scaffold_repo`, or
  inline) and never depends on another file; the numbers only fix the
  order. Fixtures are Kotlin repos: `kt_repo` (the Gradle skeleton, copied
  from one `loadout init` the runner makes, plus a minimal loadout.kt),
  `kt_file` (a manifest with the package/import header), then
  `compile_repo`, which compiles with the real binary and caches the lock
  by a hash of the sources (`kt_key`), so identical fixtures compile once
  per run (a compile is ~1–2s on a warm daemon). The runner needs
  `build/bundle` (`./gradlew bundle`) and points LOADOUT_HOME at it. A
  `manual` custom variant with a failing command keeps tests off the
  host's package managers. Add an `ok "..."` test for every user-visible
  behavior change, in the file whose subject it is (new subject = new file); run
  that file with a name pattern while iterating. Never share state across
  files through `$WORK`. Configs tests (`t/55-configs.sh`) put a stub
  `chezmoi` on PATH for each command only (`cz_loadout`: the files are
  sourced into one shell, so an exported PATH would leak), answering from
  files and logging its calls; a real chezmoi would read and write the
  developer's own dotfiles, so "chezmoi missing" is the stub's exit 127,
  never a PATH without it.
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

`.github/workflows/ci.yml`: ubuntu (unit tests of every
module, debug binary + bundle, integration, both linux release links) and macos
(arm64 unit tests, both mac release links + bundle, integration against
the release binary). It runs on pushes to `master` and on pull requests.
Runners differ from a desktop: Ubuntu's `/bin/sh` is dash ("not found", not
bash's "command not found"), and `TERM` is unset (Linux) or unusable
(macOS), so `pty_run` sets its own.
Reproduce the Linux job locally in an `ubuntu:24.04` container as a non-root user.
`release.yml` on `v*` tags: strip + tar.gz of the binary AND
`share/loadout` (the `bundle` output: `maven/` with the DSL, model and
plugin JVM artifacts, `gradle/` with the wrapper `init` copies, `VERSION`)
→ `loadout-<tag>-{linux-x64,linux-arm64,macos-arm64,macos-x64}.tar.gz`
attached to the GitHub Release. linux-arm64 cross-compiles on the x64
runner (stripped with `binutils-aarch64-linux-gnu`); nothing runs it
before release. It packages without testing: let CI pass before tagging.
**The version lives in ONE place**, `gradle.properties`' `version`: the
DSL and plugin publish at it, `bundle` writes it to VERSION, and model's
`generateVersion` writes `TOOL_VERSION` from it (build/generated/version;
the IDE sees it after a Gradle sync). Each of those tasks declares the
version as an input, or a bump leaves its output stale. release.yml's
first job refuses a tag that isn't `v<version>`. A release = bump that
line, commit, tag.

`install.sh` (repo root) is the curl|sh bootstrap over those releases: it
resolves latest via the GitHub API (pin: LOADOUT_VERSION) and installs the
binary to ~/.local/bin and the share dir to ~/.local/share/loadout
(`<parent of the bin dir>/share/loadout`, replaced whole: it holds one
version, the binary's; `LoadoutHome` looks there); keep its target names in
sync with release.yml. It refuses a tarball without `share/loadout`. It
reads the installed version BEFORE overwriting, so an upgrade (including
`loadout self-upgrade`, which shells out to it) says "was vX" and skips the
first-install "Next steps". Testable offline via
LOADOUT_DOWNLOAD_BASE=file://… against a local tarball; run-tests.sh covers
both paths on both platforms, staging one stub tarball per release name so
`install.sh` resolves the host's own target (don't repeat that mapping in
the test: a Rosetta shell says x86_64 where macos-arm64 is still right).

## Adding programs to a config repo — the recipe

The wiki's "Writing your manifest" is the user-facing long form. Match
top-down, first fit wins:

1. Standard package → `installVia(…)` listing ONLY installers where the
   claim is true (`installVia` is unverified; a false entry is a mappable
   lie). The named
   installer usually ships with loadout (`loadout installers`); declare one
   only to add a mechanism or replace a built-in.
2. Different package id → the variant with a pkg:
   `brewCask(pkg = "gcloud-cli")`, `flatpak(pkg = "md.obsidian.Obsidian")`
   inside `installVia(…)`.
3. Special install command, same mechanism → that installer's variant with
   `command = …`, so check/probe derive. Key by what it IS: a cask is
   `installVia(brewCask { … })`, not `installVia(brew { … })`.
4. Prerequisite step (tap/repo/remote) → its own program + `dependsOn`,
   never `&&`-chained into another program's command; on the variant when
   only that mechanism needs it. When EVERY program of a mechanism needs it
   (a pm's config, the flathub remote, a COPR's dnf-plugins-core), the
   installer `requires` it.
5. Repo-script install that lands in a pm's database → that pm's variant
   with `installedBy("…")`; check/probe derive; override `regex` for odd
   version formats. When several programs need the SAME shaped script (rpm
   repo + key + install, a brew tap), make it an installer with `params`
   and one `runScript(…)` pattern, plus a typed wrapper
   (`tap(tap = "owner/tap")`); the variants carry only their values.
6. Truth not in a package db (dnf groups, virtual provides) → override the
   check (`version(command = "rpm -q --whatprovides …")`, a managing
   script, or `present("…")` when there's no version), keep the rest
   derived.
7. No pm at all → `custom { installedBy("x.sh") }` (or `command = …`) + a
   program-level `version(…)`;
   `path("$HOME/.local/bin")` when it lands off a fresh shell's PATH.
8. Nothing to "have" (dotfiles, services) → a `script` + check, run per
   machine. A *managing script* (`<file>` does the step, `<file> check`
   says whether it's done) is `managedBy("x.sh")`. A step done differently
   per platform is one script with `variant(name = "arch") { … }`s, picked
   by the machine.

Cross-cutting: no `||` chains or trailing pipes in checks; versions are the
mapped pm's truth (rpm's version, not the binary's self-report: expected,
not a bug); a repo script (`runScript`, `installedBy`, `managedBy`) for
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
