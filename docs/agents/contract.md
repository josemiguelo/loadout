# Design contract — do not violate

Explicit user decisions; don't "improve" them away.

1. **No package-manager auto-detection, no `--pm` flag or env override.**
   The only source of variant choice is the machine and the profiles it
   extends (`withDnf(curl)` in its `install` names a program's variant
   key).
2. **Mapping = membership + strict fail-fast resolution.** A program a
   machine doesn't install is not in its loadout: converge skips it, status
   doesn't observe it, diff shows "-".
   - **Declarations** (a `machines/` folder, a file per machine and per
     profile, or one `machines.loadout.ts`): `profile("name", { … })` and
     `machine("hostname", { … })`, each with two verbs. `install: [...]`
     takes programs with exactly ONE variant (more is a compile error
     naming them: no choosing for you), named variants (`setupBrew("linux")`) and `withBrew(programs…)`, which maps each program
     to that installer's variant, mixed. `run: [...]` opts scripts
     in, `x` or with options `x({ … })`; Lists of
     references are flattened, so a shared list sits in either. A program
     installed twice or a script run twice in one machine is an error. A machine is named by its
     hostname, so the lock (and chezmoi templates reading it) find it; a
     host whose hostname can't or shouldn't be the name (proot's
     `localhost`, a work laptop's asset tag) sets `LOADOUT_MACHINE`, which
     both `--machine` and the partial read first.
   - **Profiles**: `extends: [x]` names profiles only (a machine
     is never extended); profiles may extend profiles (cycles are errors).
     A machine's profiles are combined first: two of one `extends` list
     setting a program's variant, a script's arguments or variant, or a data
     key differently is an error (equal values are fine), so their order
     never changes the result. Then the machine overrides them (mapping per
     program, scripts by name, `data` table by table, lists replace).
     Profiles are flattened, validated, then dropped: never observed,
     diffed or converged. No subtraction: a profile's entry is a promise
     every machine extending it keeps.
   - **`data`** is a typed schema: `repo({ data })` declares every key with
     its default (`work: false`, a nested `kitty: { opacity:
     0.85 }` for a table; plain values: the default's type is the key's). Its type (`typeof schema`) checks every `machine<Data>` and
     `profile<Data>` in the editor, and assembly checks a machine's or
     profile's `data: { work: true }` against the defaults again (an
     unknown key, a wrong type or a table given a non-object is an error
     naming the machine and key), recorded as written, which keeps the
     profile-conflict error. Every machine ends up with all
     declared keys (model/machinedata.ts; bare `explain` shows them); the
     lock holds each machine's merged table.

   `setup-new-machine` refuses (ResolutionException) before
   executing anything if the machine isn't declared, an EXPLICITLY
   requested program is unmapped, a mapped program's dependency is
   unmapped, or a mapped known PM's binary is absent (probed). No automatic
   `script` fallback. A variant with `addsToPath: { flatpak: true }` vouches for
   that binary to whatever installs AFTER it in the same plan (flatpak
   before every flatpak on Omarchy); one ordered after its dependents is
   refused, naming the fix. `addsToPath: { brew: "/opt/homebrew/bin" }`
   also says where it lands when a fresh shell doesn't have it on PATH:
   the probe counts as present there, and `ForMachine` records the mapped
   variants' folders in `toolPaths`, which `ResolveInstall`
   (install, check, outdated, batch oracle), `UpgradeEngine` (`ToolPathOf`)
   and the status's tool question put first on PATH for every command
   probed through that binary. On the variant, not the program: where a
   tool lands depends on how it was installed. Declared, never inferred
   from a program's name or searched for.
3. **Intent and observation never mix.** The TypeScript manifests are authored;
   `loadout.lock.json` is generated from them and committed (`loadout
   compile` writes it, and only when its content changed); the
   state directory is generated and disposable. With configs,
   compile also writes `<configs>/.chezmoidata/loadout.json` and the
   `<configs>/.chezmoitemplates/loadout/machine` partial (contract 17),
   generated and committed like the lock. It also writes
   `node_modules/@types/loadout`, the types of the SDKs the manifests
   (`"loadout"`) and TypeScript scripts (`"loadout/script"`) import, which
   are the binary's own: for the editor, never committed, and refreshed
   by every command that reads the repo, so they're never older than the
   loadout that last touched it. A repo with tool folders (contract 17)
   also gets chezmoi's sources built from them (`layout configs` and
   `root-configs`: symlinks to the tool folders' files, with the
   templates' data): derived, never committed (the repo ignores them),
   and rewritten like the types by every command that reads the repo,
   since chezmoi must never read one behind its folders. Nothing
   hand-edited goes in state, the lock or those; the tool never writes
   authored files, except `init` scaffolding and what a `loadout chezmoi`
   command the user ran wrote into a build (carried over to the tool
   folder: chezmoi would have written the source itself).
4. **Scripts: exactly one of `module` or `runCommand`**. A `module` is a TypeScript
   module exporting `check(options)` and `install(options)`, run by
   `core/bun`'s module runner, with the options as one JSON argument. One that
   takes options has `rules: () => import("./x.rules.ts")`, a file exporting
   `validate(options)`: compile runs it on every call (it's a source of the
   lock) and the runner before `check` and `install`. The manifest names it `module: () =>
   import("./x.ts")`: compile calls that with every import caught by a
   plugin, so the path is Bun's own resolution of the import and the
   module never runs at compile, nor is it a source of the lock. `updates` on a script
   (`listOutdated`, `update(item)`) or a program (`newerVersion`, `update`) is a module the same way. A script in any other language is
   `runCommand: runFile("x.sh")`. `runCommand` and `checkCommand` take a string or a list of
   commands, joined with `&&` (allOf); one holding `||` or `;` is grouped in
   `{ …; }` first, so the join can't change what it means (a single string
   goes through the same rule). Variant commands, installer patterns,
   oracles, `outdated` commands (program and custom source) and all check
   commands may name a repo script: `runFile("x.sh", "args…")` (stored with
   the `file:` prefix), so a
   manifest never writes `file:` itself. Every path is relative to the
   directory of the file that declared it (its `origin`; "" = the repo
   root, also for built-in installers): a declaration's origin is its
   file's folder, so moving a file with its scripts needs no edit, and file
   names need not be unique. What must run from the repo root is declared
   in `loadout.ts`. Paths are kept as written, and validated at compile
   AND at every lock load to exist without leaving the repo (`..` inside
   one is fine: a shared helper). Expansion is centralized in
   model.expandFilePrefix/ShellLine, applied at the execution sites. Tokens
   after the first space are arguments, so script paths can't contain
   spaces. A file runs like an executable (`model.fileLine`): with the
   interpreter its `#!` line names (`#!/usr/bin/env bun`), else `sh`; a
   command in TypeScript can use `"loadout/script"` (`runStep`, `env`), never
   required. The
   line is read by the shell when the command runs, never by loadout, and
   the file needn't be executable; what's shown to the user is the script
   and its arguments (`model.shownLine`), not that launcher. Every script
   command and custom `outdated` source gets the machine's `addsToPath`
   folders first on PATH (`ScriptStep.path`, set by `ForMachine`), so a
   script's interpreter is found where its program put it (bun from brew
   on a fresh Mac) before any shell profile adds that folder. A variant's param value
   given as `repoFile("repos/x.repo")` (`withDnfRepo({ repofile: repoFile(…) })`) is a
   path too, relative to the program's directory and validated the same
   way; it is substituted as `$LOADOUT_REPO/<repo path>` because the
   installer pattern it lands in runs in the installer's directory.
   Plain values (a URL) pass through.
5. **Every manifest command runs via `sh -c` in its declaring file's
   directory** (installs, scripts, version checks, `check`s, oracles,
   upgrades), whatever the invocation directory, with `LOADOUT_REPO`,
   `LOADOUT_FRAGMENT_DIR` (= that directory), `LOADOUT_MACHINE`,
   `LOADOUT_OS` (`linux`/`macos`) and, with configs,
   `LOADOUT_CONFIGS`, all absolute (`exec.frameOf`, via
   `AppContext.frame`). A command takes the origin of the file that WROTE
   it: an installer pattern runs in the installer's directory, a variant's
   own `command`/`check`/`outdated` in the program's (`ResolveInstall`).
   In a child repo (contract 18) a parent's declaration runs in the
   parent's checkout with the parent's `LOADOUT_REPO`/`LOADOUT_CONFIGS`,
   and every command sees `LOADOUT_PARENT` (the parent's root).
   Every one of them gets loadout's bun folder first on PATH, and in
   `LOADOUT_BUN_DIR`, which `model.shellLine` puts ahead of the `addsToPath
   … at` folders (brew's bin may hold a bun of its own);
   `model.shownLine` leaves it out. The folder holds a `bun` wrapper
   (`BUN_BE_BUN=1 exec <loadout> "$@"`): loadout is the bun its scripts
   run with, the one it was built with, and the wrapper's preload gives
   every file it runs the SDKs as modules. `AppContext.bunDir` writes it
   once per process (`core/bun` `ensure`: `$XDG_DATA_HOME/loadout/bin`,
   only when missing or different, through a rename). With `$LOADOUT_BUN`
   (a bun binary) the wrapper execs that bun instead, with the same
   preload; the folder on PATH stays the wrapper's.
6. **Execution order**: in two phases, core then later; in each, all
   programs before all scripts; programs
   topologically by dependencies, ties broken by NAME (InstallOrder sorts;
   where a declaration sits carries no meaning: files decode in glob order,
   but a reference is an identity, never a position); scripts by
   `run_after` edges, ties by name. Whatever must come first says so.
   Sequential, never parallel (only read-only checks run concurrently).
   `run_after` orders but never pulls anything in; dependencies pull in
   transitively. A program's dependencies (`dependenciesOf`) are
   its own `depends_on`, the mapped variant's (a COPR's dnf-plugins-core
   never lands on a pacman machine), and what the variant's INSTALLER
   `requires` of everything it installs (`withBrew.needs(setupBrew)`; the required program is exempt from its own
   installer's rule). Validation and cycle detection count every variant's
   edges. An install whose dependency failed (or was itself skipped) is
   skipped, not tried (`InstallOutcome.skippedFor`), and counts as a
   failure: the run says what it skipped and why, and exits 1.
   **Phases**: `canWait: "why"` on a program or script (the declaration, so
   every machine; never a variant) puts it in setup-new-machine's later
   phase, after every core program and script, so a slow, optional step
   never holds up the rest (the prompts a setup asks are all in core
   steps). The reason is required and lands in the lock. A core step that
   depends on or runs after a later one (any variant's edge, an
   installer's `requires` included) is refused at assembly, never moved;
   a later step after a core one is the point. "Programs before scripts"
   holds within a phase only: a core script runs before every later
   program, so a script that acts on whatever installs leave (not one
   program) belongs in the later phase. A later install whose
   dependency failed in the core phase is skipped
   (`InstallEngine.executeAfter`). `--skip-later` stops after the core
   phase; `install-program`, `run-script` and `status` ignore phases. `canWait` on a
   `maintain_only` script is refused: it isn't part of setup.
7. **Script status is observation**: every refresh re-runs each `check`
   (exit 0 => `done`, else `pending`), even right after a run; `lastRun`/
   `exitCode` are only history of tool-run executions. Check-less scripts
   carry only run history. `check-script` asks the same checks for the
   scripts it names, with the machine's options, and writes nothing.
   Install success = exit 0 AND a re-run version check no longer says
   missing. **A check that couldn't run is not
   "missing"**: a check that goes THROUGH a tool (`VersionCheck.probe`, from
   the installer's/variant's probe) and dies with the shell's 127/126 is
   `unknown`, with `ProgramState.reason` set to the shell's line; a check
   with no probe IS the program, so its 127 means missing. (Otherwise a tool
   off PATH reports all its programs missing.) The refresh groups unknown
   rows by tool and asks about each ONCE (`command -v`):
   `StatusEngine.lastToolsDown` — `status` reports it once after the table,
   the home screen in a toast, and affected programs are never
   offered for install. Ceiling: a pipeline check (`tool | grep …`) exits
   with the LAST command's code and hides the tool's absence; write
   `x=$(tool …) && printf '%s\n' "$x" | grep …` so the failure propagates.
   A **yes/no check** (`isInstalled: "…"`, a `module` without a `versionRegex`)
   has no regex: exit 0 is installed with no version recorded, so a setup
   step that is a program (setup-dnf, a flatpak remote) needs no fake
   version string.
8. **State files**: written only for this machine; `updatedAt` bumps only
   when content changed (clean git history; `sync` is a no-op when idle).
   Unknown JSON keys are ignored on read.
9. **Errors are clean one-liners** (`error: ...`), never stack traces or
   panics. Every refusal extends `model.Refusal`, and src/main.ts
   prints any error that reaches it as one `error: ` line (an OS error
   too), so a new failure type needs no new case. A test asserts that every
   refusal type extends it (loader.test.ts).
10. **Product code loads manifests via `loader.loadRepo`** (the lock,
    checked) and sees it through `forMachine` (its script
    variants picked; `AppContext.loadManifest` does both).
    `assemble.assembleWithoutFiles` and `coretest.manifestOf` are for
    tests only: they skip the `file:` checks,
    and everything else — built-ins, flattening, validation — is the
    production path.
11. **Declarations are written out, by convention.** Manifests are
    TypeScript, so the language allows anything; the
    convention is plain values: consts (shared lists: `everydayCli = [bat,
    eza]`) and functions that build references or arguments (`sshKey(name)`,
    which saves repeating two entries with the same argument in every machine). Nothing
    that generates programs or machines: every `program()`, `script()` and
    `machine()` is written out, so a reader finds every one by name in one
    place. A manifest reads no files, network or clock: compile runs it
    with nothing of the caller's environment but PATH and HOME, so its
    output doesn't depend on who compiles it; the rest is the author's
    discipline, which bun can't enforce.
12. **Scripts are opt-in per machine**: `run: [x, y({ … })]` in a
    machine or profile. A run is its script's name and, for a module, its `options` (any
    JSON); the shell text is made, quoted, only when it runs
    (`model.optionsWord`).
    Only opted-in scripts converge and are observed; `run-script` and `check-script` refuse others.
    A module's `check` and `install` get the options; a `run` script takes
    none. No implicit script application, no OS or
    bootc detection deciding membership (the
    machine's opt-in decides). A script's modes (`setupOnly: true`,
    `notDuringSetup: true`, default both) scope EXECUTION only:
    setup-new-machine converges setup-mode scripts, the home screen's
    scripts picker lists maintain-mode ones; status observes all opted-in
    scripts and `run-script` ignores modes.
13. **Installers own mechanics; variants refine them.** An installer
    (`neededBinary`, `installCommand`, `checkCommand`, `versionRegex`, `outdatedCommand`, `allOutdatedCommand`,
    `upgradeCommand`, `needsSudo`, `installerParams`; `{packageName}` substituted) defines a
    mechanism once, repo-unique. Loadout
    ships a library (`src/model/installerlibrary.ts`: dnf, dnf-repo,
    dnf-copr, brew, brew-cask, flatpak, pacman, omarchy, omarchy-aur with
    oracles; apt install/check only) as values, which the SDK exports as
    references (`dnf`, `brewCask`), merged UNDER the repo's own at
    assembly: a repo installer of the same name replaces the built-in
    outright, and
    `Manifest.builtinInstallers` records which survived so
    `explain`/`installers` label `(built-in)` vs `(repo)`. `x.needs(programs…)` adds to any installer, built-ins included, without
    redefining it. Knowledge, never detection: nothing probes the machine
    to pick an installer.
    A program lists its variants in `canBeInstalled: [...]`: an installer as it
    is (`withBrew`), `withBrew({ packageName: "vim" })` for one configured where it's
    named (`withDnfCopr({ copr: "x/y" })`, `withDnf({
    module: () => import("./x.ts") })`), so a variant never reads like a command being
    run, and `withCustomSteps("linux", { … })`, the variant with no installer: a
    command of its own (`withCustomSteps({ … })` is named "custom", for a program
    with one). Naming an installer twice is an error, so there is no hidden
    merge. Variants keep their order. Every field is optional and defaults from the installer;
    `pkg` defaults to the program name. An installer may declare `installerParams:
    ["copr"]`: values a variant supplies (`withDnfCopr({ copr: … })`),
    substituted like `{packageName}`. All declared, never inferred: a missing param
    or an undeclared one is an error, so an unsubstituted `{placeholder}`
    never reaches a shell.
    Resolution (`resolveInstall`/`CheckFor`, used by every
    engine/UI): command → installer install pattern (else error); check →
    variant check → installer check (else program `version`); probe →
    installer probe (else none); outdated → variant override, else
    installer `allOutdatedCommand` (one batch command per installer, per-program
    regex extracts; binaries that don't know it fall back to per-pkg), else
    installer per-pkg pattern, else no oracle (`outdated` skips and says
    so). These oracles' exit codes are always ignored. A program's
    `searchPath: [...]` puts directories first on PATH for its commands
    (`ShellLine`), so a check never needs `tool || $HOME/.local/bin/tool`.
    Repos may also declare custom `outdated` sources: on the script they're
    about (`outdated: [{ … }]` in `script()`, named after it unless it
    says `name`) or alone (`outdated("name", { command: … })`). The usual
    form is `updates: () => import("./x.ts")`, whose `listOutdated()` lists and
    `update(item)` updates one row (on a program, `newerVersion()` gives the newest
    version and `update()` updates it; a script with several sources names
    each: `updates: { name: () => import(…) }`); `command`/`upgrade` is the long form for
    anything else, a read-only source included (`<item> <current>
    <candidate> [note…]` lines; a URL in the note becomes the row's link,
    opened with `K`; `runFile(…)` allowed, repo-unique). Unlike
    installer oracles, a source's exit code is NOT ignored: non-zero
    surfaces as `outdated source [name] failed: ...`, so a crashing oracle
    can't hide updates.
    Installers may declare `upgrade`: the ONE command that moves everything
    the mechanism manages, with no `{pkgs}` placeholder (contract 15).
    Never write cross-variant `||` chains in checks.
    `needsSudo: true` (installer, variant, script, `outdated` source)
    declares a command that needs sudo's password without saying `sudo`
    itself (`omarchy pkg add`, a repo script); a variant's replaces its
    installer's. `setup-new-machine`, `install-program`, `run-script` and `upgrade` ask
    for the password once, after the confirmation and before the first
    step (`askForSudoUpfront` in cli/converge.ts), when their plan holds a
    step that needs it: declared, or a command matching `commandNeedsSudo`
    (core/engine/sudo.ts: the word sudo, not "pseudo"). Scripts count only
    while pending (`ScriptRunner.pending` asks the check, which `run-script` asks
    again). Valid credentials ask nothing; a refusal stops the run before
    any step. A background shell loop then runs `sudo -n -v` every 50s
    while loadout's pid lives, checked every second (`SudoKeepalive`), so
    a step an hour in finds them valid. Never inferred from a script's
    content: an undeclared sudo inside a repo script still prompts
    mid-run, on the terminal, as before. Home-screen runs get this for
    free: each runs one of these subcommands, in the run panel.
14. **Versioning contract.** Breaks are deliberate: a removal is decided
    once, loudly, in the release notes, never silently. Manifests are
    TypeScript, run by loadout itself as bun, the one it was built with;
    the TypeScript language server gives editors completion,
    hover and errors. The manifest language
    and the binary are one version: compile is the binary's own, so a repo
    compiles against exactly the installed binary. The lock carries
    `format` (bumped only when an older binary could misread a lock; a
    newer one is refused by name before anything else is read) and the
    `toolVersion` that wrote it: a binary refuses a lock from a newer MINOR
    (patch releases never change what a lock means), naming
    `self-upgrade`. `minLoadoutVersion` (`repo({ minLoadoutVersion: … })`)
    is a floor the repo declares on top.
    New lock fields are additive with defaults. State files with
    `schemaVersion > coremodel.schemaVersion` are skipped with a warning
    (`StateStore.lastWarnings`; new read paths must echo/log them). Bump
    SchemaVersion only for a real schema break; handle older schemas via
    defaults.
15. **Converge installs; `upgrade` upgrades, a whole mechanism at a time.**
    `setup-new-machine`/`install-program` add what's MISSING and never touch a
    version already there. Moving versions is its own verb, `loadout upgrade
    <installers…>|--all` (`UpgradeEngine`), never single packages: naming a
    program is an error pointing at its mechanism. Mechanisms sharing a
    command (dnf, dnf-repo, dnf-copr all run `dnf upgrade -y`; omarchy and
    omarchy-aur both `omarchy update -y`) are ONE step,
    deduped by command; the UI groups by the TOOL they drive (their probe),
    so ticking a brew row ticks casks too. `PlanUpgrade` refuses an
    installer this machine doesn't map, so a repo mapping nothing to brew
    can't sweep it.
    Custom `outdated` sources upgrade per item: their update command
    (`update(item)` of its `updates` module, or `upgrade: "…
    {item}"`) runs once per row (`upgrade --item <source>/<name>`),
    since items (a pin, a clone) are independent and one failure shouldn't
    stop the rest; a source without it is read-only (`[–]`). Afterwards
    EVERY mapped program is re-checked, since the transaction can move
    packages loadout doesn't declare. The binary's own update is
    `self-upgrade`, which needs no repo, so it survives a version-floor
    refusal. Both refusals of a too-old binary (floor, newer minor) are
    `model.ToolTooOldException`, carrying the version needed. `sync`
    catches it after its pull: it refuses when the latest release is still
    below it, else runs the install and then the same sync with the binary
    it was started from (its path read BEFORE the install: Linux names a
    replaced `/proc/self/exe` "(deleted)"), under `LOADOUT_SYNC_UPGRADED=1`,
    which turns a second refusal into an error instead of another upgrade.
    A child's sync that compiled before the refusal also passes
    `LOADOUT_SYNC_RECOMPILED=1`: the sync it starts finds the lock already
    compiled (the parent unchanged since) and must still commit it. The
    home screen ends after an S whose repo now refuses its binary
    (`loader.toolTooOld`), like after U. Only `sync` upgrades by
    itself: it is the command that pulls, so it's the one that meets a
    repo moved ahead of the binary.
16. **The repo's shape is declared, never assumed.** A config repo is
    `loadout.ts` at its root, run by compile with loadout itself as bun
    (through the wrapper, which `$LOADOUT_BUN` points elsewhere), plus
    what it imports and `include()`s (`include("loadouts/**/*.loadout.ts")`:
    Bun.Glob, dot files included, path order), and only those; it ends
    with `repo({ … })`, which prints the draft. Nothing else: no build
    files, no build folder, no npm. `repo({ state, configs })` names the
    state and chezmoi dirs; `state` is required, with no default.
    `dotfiles: { tools, home, root, from }` declares tool folders instead
    of an authored chezmoi dir (contract 17): every folder the `tools`
    glob matches is a tool.
    Manifests import the SDK as `"loadout"` (the binary's, registered by
    the wrapper's preload; `node_modules/@types/loadout`, which compile writes, types it)
    and each other by relative path; a declaration's origin is the file that called it. The lock
    records the sources (every file the entry and its includes reach
    through static imports, helpers included) and a sha256 of them (path +
    content); a binary that finds them changed refuses with "run: loadout
    compile", so a lock never silently lags its sources. A repo without
    `loadout.ts` is refused. The suite runs with its own
    XDG_CACHE_HOME (seeded with a release, so `status` doesn't ask
    GitHub), never the developer's.
17. **Configs are chezmoi's, observed like everything else.** `repo({
    configs })` names chezmoi's source directory inside the repo; unset,
    there is no configs concept and chezmoi is never called. Every chezmoi
    call is `chezmoi --source <repo>/<configs> --no-pager …`
    (`ConfigEngine`), so a `--repo` worktree is observed and applied from
    that worktree, never from chezmoi's own configured source.
    - **Units**: `.config/<name>/…` is unit `<name>`, any other target its
      first path segment (`.zshenv`, `.local`), from one `chezmoi managed
      --include files,symlinks` per refresh. Not opted in: `.chezmoiignore`
      is chezmoi's membership. A unit may share a program's name (tmux);
      `explain <name>` shows both.
    - **Drift is observation** (contract 7): one `chezmoi status --include
      files,symlinks` per refresh. Its second column is what `apply-config` would
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
      edited AND drifted (`refuseEdited`, cli/apply-config.ts), naming the files:
      keep them with `loadout chezmoi re-add`, or replace them with `apply
      --force`. `sync` = pull → (upgrade loadout, contract 15) → refuse
      edited → apply → refresh → name what's left (missing programs,
      scripts not done) → commit → push; nothing is committed after a
      refusal or a failed apply. It never installs or runs scripts itself.
      Its pull (or a parent's, through the child's compile) can rename the
      repo's folders, so `sync` calls `AppContext.reloadLayout()` after
      them: everything read from the layout (configs and state folders, the
      parent, chezmoi's sources) is read again, never kept from before the
      pull.
    - **State**: `MachineState.configs`, left out of the file when empty,
      so repos without configs write what they always did and older
      readers ignore it (schema stays 1). `diff` shows a CONFIG table (`-` =
      the machine doesn't report that unit) and exits 1 on config drift.
    - **Templates' data**: `loadout compile` writes `<configs>/
      .chezmoidata/loadout.json` (`model.chezmoiDataFiles`), which chezmoi
      loads into every template as `.loadout`: `loadout.defaults` (every
      declared key) and `loadout.machines.<hostname>` (each machine's
      merged table). That shape is the contract with templates; the lock's
      layout stays loadout's own (templates reading the lock broke on any
      change to it). Compile also writes the partial that picks this host's
      table, `<configs>/.chezmoitemplates/loadout/machine`
      (`model.chezmoiPartial`): the machine loadout runs as
      (`LOADOUT_MACHINE`, else the hostname, so a plain `chezmoi apply`
      agrees with `--machine`); for a machine this repo's data lacks, its
      table from the lock of `LOADOUT_REPO` (a child repo declaring it,
      contract 18), else the defaults. The partial reads loadout's lock
      because compile writes both and every load checks the partial; no
      user template may. So a repo's templates read their machine with
      `includeTemplate "loadout/machine" . | fromJson` and the partial
      always matches the data's shape. The `loadout/` folder keeps it apart
      from the repo's own templates. Every load re-renders both from the
      lock and refuses a missing or different file ("run: loadout
      compile"), so dotfiles never render from data the manifests don't
      say. `init --configs` scaffolds such a repo (`configs:
      "loadouts"`, a `.chezmoiroot`, `loadouts/`), every manifest in
      `loadouts/`, laid out where files land: a tool's manifest sits at its
      destination (beside its dotfiles; with none, a dot-file, or a
      dot-folder for one with scripts, since chezmoi deploys no dot entry
      and a plain folder holding only a manifest would land empty in
      `$HOME`), and what lands outside `$HOME` and belongs to no tool
      (system packages, hardware) is a folder per concern in `.etc/`
      (`.etc/dnf/`).
      No `system/` beside it: one folder holds the whole loadout, and
      `include("loadouts/**/*.loadout.ts")` finds a manifest in any dot
      folder. Plain `init` keeps `programs/` and `maintenance/`.
    - **Tool folders** (`repo({ dotfiles: { tools, home, root, from } })`,
      core/configbuild): every folder `tools` matches is a tool, named
      after its folder; its `home/` is chezmoi source rooted at `$HOME`,
      its `root/` chezmoi source rooted at `/`, both optional, so a tool's
      manifest, scripts and files sit in one folder. A non-dot folder in
      a tool that isn't `home/` or `root/` is a compile warning (a
      misspelling would otherwise deploy nothing). Compile builds every
      `home/` (and `from`, an authored chezmoi tree merged as it stands,
      apart from every tool folder) into `home` (`layout configs`, what
      the rest of this contract reads) and every `root/` into `root`
      (`layout root-configs`): real folders and relative symlinks to the
      files (chezmoi follows a symlinked file, not a symlinked folder),
      each part's `.chezmoiignore`/`.chezmoiremove` joined into one, the
      root build linking the templates' data from the home build. A
      target two tools land, two names for one target, a tool's `root/`
      under `/home` or `/Users`, `from` overlapping a tool, a build inside
      `from`, the state folder or a tool folder (it would build itself), a
      dangling symlink and a tool shipping loadout's own data are refused.
      Names are read as chezmoi reads them (attr.go: each prefix once, in
      its order, `run_`'s and `create_`'s only after them; the encrypted
      suffix kept, since it goes only with an encryption loadout doesn't
      read), so a clash is a real one. The builds and their data are never committed: compile
      writes them, and so does every command as it reads the layout
      (`AppContext.layout`, configbuild.refreshBuilds), so a fresh
      checkout or a pulled change needs no step of its own, and plain
      chezmoi works once any loadout command has run there (a repo's
      bootstrap runs one before `chezmoi init --apply`). What a chezmoi
      command wrote into a build (a symlink turned file: re-add, merge;
      a file from no tool: add) is never overwritten: the refresh leaves
      that build alone and every load refuses it, naming `loadout chezmoi
      re-add <target>` (which carries it, from the plan, even when chezmoi
      wrote it before this command) or deleting the build's file (the next
      command relinks it; never `git restore`: builds aren't tracked);
      compile refuses it too. A joined `.chezmoiignore`/`.chezmoiremove` no
      part has any more is a leftover the refresh removes, never a stray.
      A build left behind (a checkout loadout can't write) is refused with
      "run: loadout compile". The loader compares builds from the canonical
      repo root, as the refresh makes them, so a checkout reached through a
      symlink loads.
    - **Root configs**: a root build is one more `ConfigEngine` source
      (the parent's, then the child's), after `$HOME`'s. Its targets are
      absolute (`/etc/…`) and its units are the tools they came from
      (`/keychron`). Observing runs chezmoi as the user with an empty
      config and root's state (left readable) and cache (`/var/lib/loadout`,
      `/var/cache/loadout`; macOS `/var/db/loadout`, `/Library/Caches/loadout`),
      retrying with `sudo -n` for a target the user can't read, else
      `unknown`; only a `permission denied` is retried as root (a template
      error is chezmoi's answer, never re-run as root), and when sudo wants
      a password the source is `unknown` with "(it needs sudo)"
      (`ConfigNeedsSudoException`): one source chezmoi can't answer for takes
      down its own units only. A command that applies (`apply-config`,
      `sync`, setup) asks for the password on that and tries again
      (`withSudo`). Both sides run under `umask 022`, since chezmoi computes
      a file's mode from the umask: an observer with another umask would
      see every file drifted. Applying runs it as root (`sudo sh -c 'umask
      022 && exec env HOME=… LOADOUT_* chezmoi …'`, so `.chezmoi.homeDir` is
      the user's) in two passes: chezmoi sets every
      folder in its source to its own mode and replaces a symlinked
      folder (macOS `/etc`), so pass one applies only the folders not
      there yet and those whose source name carries an attribute, pass
      two everything else with `--exclude dirs`. Pass 1 takes only the
      folders on the way to the targets asked for (another tool's aren't
      this apply's), each with `--recursive=false` (chezmoi would descend
      into folders already there); a folder this user can't look at counts
      as there (`pathThere`), so it's left alone, never applied as root.
      chezmoi runs by the path the user finds it at, since sudo's
      `secure_path` may not have it. Both sides get `LOADOUT_USER`, so a
      `root/` template names the user the same applied (as root) and
      observed (as the user), which `.chezmoi.username` doesn't. The two
      passes run in a subshell that leaves
      root's state (and its folder) readable whatever the passes did. A
      root source with
      nothing pending isn't applied, so nothing asks for sudo;
      `apply-config` and `sync` ask once, first (askForSudoUpfront).
      `setup-new-machine` applies drifted root configs after the core
      programs (no package overwrites them) and before the core scripts
      (which may read them), shown as `config` rows in its plan; when the
      plan can't read them (chezmoi not installed yet, or sudo needed) they
      are one "configs outside $HOME" row, worked out after the core
      programs, and sudo is asked up front. Every
      machine gets them; a tool's `.chezmoiignore` keeps them off one.
      `LOADOUT_ROOT_DESTINATION` stands a folder in for `/`, applied
      without sudo: for the integration suite.
    - **`loadout chezmoi <command> [args…]`** (cli/chezmoi.ts): chezmoi
      over this repo's own sources (never a parent's), with the source,
      `LOADOUT_REPO` and `LOADOUT_MACHINE` given, so a worktree works as
      everywhere else. Its arguments are read knowing chezmoi's flags that
      take a value, so a value is never the command or a path (`--color off
      update` is refused as update). A target argument of a command that
      takes them is a path, `~/` and relative ones resolved from the
      working directory: outside `$HOME` it goes to the root source, inside
      to `$HOME`'s; with none, the commands about every target (apply,
      diff, status, managed, verify, re-add, merge-all…) run over both. The
      flags that point chezmoi elsewhere (`--source`, `--config`,
      `--persistent-state`, `--cache`, `--working-tree`, `--destination`)
      are loadout's and refused. A path to `/` names a target or a folder of
      them, on the destination (a stand-in's too); one that names none is
      refused. Other commands on `/` run as the user over a temporary copy of
      root's state, which isn't the user's to write; `edit` runs with
      `--hardlink=false` (a hard link to a build's relative symlink dangles
      in chezmoi's temporary folder). `manage` and `unmanage` are add's and
      forget's aliases, carried the same way.
      `apply` to `/` goes through `applyCommand` (two passes, sudo first),
      with the user's flags (`--dry-run`, `--verbose`, `--force`) on both;
      `--include`/`--exclude` are refused there, the passes choose. re-add,
      add, merge, merge-all, chattr, forget and edit are wrapped: each build
      is snapshotted before and compared after (configbuild.carryOver), and
      what chezmoi did is carried over (a file where the plan has a symlink
      is the tool file's content, a symlink renamed is the tool file renamed,
      gone is the tool file deleted, a new file goes into `--tool <name>`'s
      folder, checked before chezmoi runs), every change worked out before
      any is made: a new file with no tool leaves everything as it is.
      Folders a rename or deletion empties are pruned up to the tool's
      `home/`/`root/` (or `from`); then the builds are rewritten. `source-path`
      prints the tool's file, `cd` opens the tools' folder. init, update,
      upgrade, purge, git, push, destroy and import are refused, each with
      what to run instead (push would commit and push from a build). Every
      scaffold has a `tsconfig.json`, the SDKs' types (`node_modules/@types/loadout`), a `.gitignore` for node_modules, and a
      `package.json` whose `@types/bun` only the editor needs.

18. **A child repo inherits a parent; nothing flows back.** A private repo
    names a public one in its `loadout.ts`, `repo({ parent: { name, path }
    })` (`~/…`, absolute, or relative to the child), and its manifests
    import the parent's installers, programs, scripts, profiles and data
    schema from the parent's checkout (tsconfig's `"parent/*"` alias, which
    `init --parent` writes), typed like its own. One level, one parent; any number of children,
    none of which the parent knows.
    - **Compile** (compile/compile.ts): compile refuses a parent that
      has no lock, whose lock is stale (its sources' hash differs), that is
      itself a child, or whose manifests aren't TypeScript. It runs the
      parent's loadout.ts as a parent (`LOADOUT_AS_PARENT`: every origin
      `parent:`) and the child's, whose SDK records only declarations in
      the child's own files (what it imports from the parent are
      references; the parent's modules import the same SDK module, whose
      state is on `globalThis`: one set of variants),
      and merges them (`assemble.draftOver`): the
      parent's machines, meta and layout stay out; a name both declare, a
      machine in both and a child data schema are errors; the floor is the
      higher `minLoadoutVersion`, and the bun is the child's, else the
      parent's. A parent's mistakes are reported prefixed
      `parent <name>: `. Unused and transitional warnings are the child's
      own declarations' only.
    - **Lock**: `layout.parent` (name, path as written, state, configs,
      sources, hash of the parent's manifests); a parent declaration's origin
      is `parent:<folder>` (`Origin`), its `file` values `$LOADOUT_PARENT/…`
      (a built-in installer that takes them runs in the child). A repo
      without a parent writes exactly what it did. A parent edit the child
      hasn't compiled is refused at load like a stale lock, and a missing
      parent by name and path.
    - **Runtime**: commands as in contract 5; configs are two chezmoi
      sources, the parent's then the child's (`ConfigEngine`). A parent
      with tool folders (`layout.parent.build`) has no committed build to
      read, so the child builds the parent's tool folders into its own
      `.loadout-parent/home` and `/root` (ignored, refreshed as its own
      builds are), and its scripts' `LOADOUT_CONFIGS` points there. Units span
      both, a target both manage is `unknown` and refused by `apply-config`, and
      chezmoi runs with `LOADOUT_REPO` (the child) and `LOADOUT_MACHINE` so
      the parent's partial finds the child's machine. `diff` and the fleet
      row are the parent's machines and the child's (the parent's state
      read-only). `sync` pulls the parent, never commits or pushes it, and
      when the parent's manifests changed compiles the child and commits its
      lock with the state.
    - **Privacy**: nothing a command run on a child does writes under the
      parent (compile's and the state store's `WriteIfChanged` assert the
      child root; the parent's `StateStore` is read-only; its git only
      pulls). `integration/t/110-parent-repo.sh` checksums the parent
      around every command. `init --parent <path> [--name n]` scaffolds a
      child.
