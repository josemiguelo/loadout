# Design contract — do not violate

Explicit user decisions; don't "improve" them away.

1. **No package-manager auto-detection, no `--pm` flag or env override.**
   The only source of variant choice is the machine and the profiles it
   extends (`via "dnf" { install = [program.curl] }` names a program's
   variant key).
2. **Mapping = membership + strict fail-fast resolution.** A program a
   machine doesn't install is not in its loadout: converge skips it, status
   doesn't observe it, diff shows "-".
   - **Declarations** (a `machines/` folder, a file per machine and per
     profile, or one `machines.loadout.hcl`): `profile "name" { … }` and
     `machine "hostname" { … }`, each with two verbs.
     `via "installer" { install = [programs…] }` maps each program to that
     installer's variant (`install` is the block's only attribute, so a
     line inside always installs through the block's installer; a body
     holds any number of `via` blocks); `install = [programs…]` outside a
     block takes programs with exactly ONE variant (more is a compile error
     naming them: no choosing for you) and named variants
     (`variant(program.setup-brew, "linux")`), mixed. `run = [scripts…]`
     with `args(script.x, "a")` opts scripts in; `variant(script.x,
     "arch")` picks a script variant. A program installed twice or a
     script run twice in one machine is an error. A machine is named by its
     hostname, so the lock (and chezmoi templates reading it) find it; a
     host whose hostname can't or shouldn't be the name (proot's
     `localhost`, a work laptop's asset tag) sets `LOADOUT_MACHINE`, which
     both `--machine` and the partial read first.
   - **Profiles**: `extends = [profile.x]` names profiles only (a machine
     is never extended); profiles may extend profiles (cycles are errors).
     A machine's profiles are combined first: two of one `extends` list
     setting a program's variant, a script's arguments or variant, or a data
     key differently is an error (equal values are fine), so their order
     never changes the result. Then the machine overrides them (mapping per
     program, scripts by name, `data` table by table, lists replace).
     Profiles are flattened, validated, then dropped: never observed,
     diffed or converged. No subtraction: a profile's entry is a promise
     every machine extending it keeps.
   - **`data`** is a typed schema: the `data { … }` block declares every key
     with its default (`work = flag(false)`, a nested `kitty { opacity =
     number(0.85) }` for a table; `flag/text/number/whole/list` exist only
     there). A machine's or profile's `data = { work = true }` is checked
     against it (an unknown key, a wrong type or a table given a non-object
     is an error naming the machine and key) and recorded as written, which
     keeps the profile-conflict error. Every machine ends up with all
     declared keys (model/machinedata.go; bare `explain` shows them); the
     lock holds each machine's merged table.

   `setup-new-machine` refuses (ResolutionException) before
   executing anything if the machine isn't declared, an EXPLICITLY
   requested program is unmapped, a mapped program's dependency is
   unmapped, or a mapped known PM's binary is absent (probed). No automatic
   `script` fallback. A variant with `provides "flatpak" {}` vouches for
   that binary to whatever installs AFTER it in the same plan (flatpak
   before every flatpak on Omarchy); one ordered after its dependents is
   refused, naming the fix. `provides "brew" { at = "/opt/homebrew/bin" }`
   also says where it lands when a fresh shell doesn't have it on PATH:
   the probe counts as present there, and `ForMachine` records the mapped
   variants' folders in `Manifest.ToolPaths`, which `ResolveInstall`
   (install, check, outdated, batch oracle), `UpgradeEngine` (`ToolPathOf`)
   and the status's tool question put first on PATH for every command
   probed through that binary. On the variant, not the program: where a
   tool lands depends on how it was installed. Declared, never inferred
   from a program's name or searched for.
3. **Intent and observation never mix.** The HCL manifests are authored;
   `loadout.lock.json` is generated from them and committed (`loadout
   compile` writes it, and only when its content changed); the
   state directory is generated and disposable. With configs,
   compile also writes `<configs>/.chezmoidata/loadout.json` and the
   `<configs>/.chezmoitemplates/loadout/machine` partial (contract 17),
   generated and committed like the lock. Nothing hand-edited goes in
   state, the lock or those two; the tool never writes authored files,
   except `init` scaffolding.
4. **Scripts: exactly one of `file` (path) or `run` (inline)**, per variant
   when a script has variants. `run` and `check` take a string or a list of
   commands, joined with `&&` (allOf); one holding `||` or `;` is grouped in
   `{ …; }` first, so the join can't change what it means (a single string
   goes through the same rule). Variant commands, installer patterns,
   oracles, `outdated` commands (program and custom source) and all check
   commands may name a repo script: `run_script("x.sh args…")` (stored with
   the `file:` prefix; `installed_by = "x.sh"` for a variant's install, and
   `managed_by`, `updates_managed_by` and a script's `file` imply it), so a
   manifest never writes `file:` itself. Every path is relative to the
   directory of the file that declared it (its `origin`; "" = the repo
   root, also for built-in installers): a declaration's origin is its
   file's folder, so moving a file with its scripts needs no edit, and file
   names need not be unique. What must run from the repo root is declared
   in `loadout.hcl`. Paths are kept as written, and validated at compile
   AND at every lock load to exist without leaving the repo (`..` inside
   one is fine: a shared helper). Expansion is centralized in
   model.ExpandFilePrefix/ShellLine, applied at the execution sites. Tokens
   after the first space are arguments, so script paths can't contain
   spaces. A file runs like an executable (`model.FileLine`): with the
   interpreter its `#!` line names (`#!/usr/bin/env bun`), else `sh`. The
   line is read by the shell when the command runs, never by loadout, and
   the file needn't be executable; what's shown to the user is the script
   and its arguments (`model.ShownLine`), not that launcher. Every script
   command and custom `outdated` source gets the machine's `provides … at`
   folders first on PATH (`ScriptStep.Path`, set by `ForMachine`), so a
   script's interpreter is found where its program put it (bun from brew
   on a fresh Mac) before any shell profile adds that folder. A variant's param value
   given as `file("repos/x.repo")` (`params = { repofile = file(…) }`) is a
   path too, relative to the program's directory and validated the same
   way; it is substituted as `$LOADOUT_REPO/<repo path>` because the
   installer pattern it lands in runs in the installer's directory.
   Plain values (a URL) pass through.
5. **Every manifest command runs via `sh -c` in its declaring file's
   directory** (installs, scripts, version checks, `check`s, oracles,
   upgrades), whatever the invocation directory, with `LOADOUT_REPO`,
   `LOADOUT_FRAGMENT_DIR` (= that directory), `LOADOUT_MACHINE`,
   `LOADOUT_OS` (`linux`/`macos`) and, with configs,
   `LOADOUT_CONFIGS`, all absolute (`exec.FrameOf`, via
   `AppContext.Frame`). A command takes the origin of the file that WROTE
   it: an installer pattern runs in the installer's directory, a variant's
   own `command`/`check`/`outdated` in the program's (`ResolveInstall`).
   In a child repo (contract 18) a parent's declaration runs in the
   parent's checkout with the parent's `LOADOUT_REPO`/`LOADOUT_CONFIGS`,
   and every command sees `LOADOUT_PARENT` (the parent's root).
6. **Execution order**: all programs before all scripts; programs
   topologically by dependencies, ties broken by NAME (InstallOrder sorts;
   where a declaration sits carries no meaning: files decode in glob order,
   but a reference is an identity, never a position); scripts by
   `run_after` edges, ties by name. Whatever must come first says so.
   Sequential, never parallel (only read-only checks run concurrently).
   `run_after` orders but never pulls anything in; dependencies pull in
   transitively. A program's dependencies (`Manifest.DependenciesOf`) are
   its own `depends_on`, the mapped variant's (a COPR's dnf-plugins-core
   never lands on a pacman machine), and what the variant's INSTALLER
   `requires` of everything it installs (`requires "brew" { programs =
   [program.setup-brew] }`; the required program is exempt from its own
   installer's rule). Validation and cycle detection count every variant's
   edges. An install whose dependency failed (or was itself skipped) is
   skipped, not tried (`InstallOutcome.SkippedFor`), and counts as a
   failure: the run says what it skipped and why, and exits 1.
7. **Script status is observation**: every refresh re-runs each `check`
   (exit 0 => `done`, else `pending`), even right after a run; `lastRun`/
   `exitCode` are only history of tool-run executions. Check-less scripts
   carry only run history. Install success = exit 0 AND a re-run version
   check no longer says missing. **A check that couldn't run is not
   "missing"**: a check that goes THROUGH a tool (`VersionCheck.Probe`, from
   the installer's/variant's probe) and dies with the shell's 127/126 is
   `unknown`, with `ProgramState.Reason` set to the shell's line; a check
   with no probe IS the program, so its 127 means missing. (Otherwise a tool
   off PATH reports all its programs missing.) The refresh groups unknown
   rows by tool and asks about each ONCE (`command -v`):
   `StatusEngine.LastToolsDown` — `status` reports it once after the table,
   the home screen in a toast, and affected programs are never
   offered for install. Ceiling: a pipeline check (`tool | grep …`) exits
   with the LAST command's code and hides the tool's absence; write
   `x=$(tool …) && printf '%s\n' "$x" | grep …` so the failure propagates.
   A **yes/no check** (`present = "…"`, `managed_by` without a `regex`)
   has no regex: exit 0 is installed with no version recorded, so a setup
   step that is a program (setup-dnf, a flatpak remote) needs no fake
   version string.
8. **State files**: written only for this machine; `updatedAt` bumps only
   when content changed (clean git history; `sync` is a no-op when idle).
   Unknown JSON keys are ignored on read.
9. **Errors are clean one-liners** (`error: ...`), never stack traces or
   panics. Every refusal implements `model.Refusal`, and cmd/loadout/main.go
   prints any error that reaches it as one `error: ` line (an OS error
   too), so a new failure type needs no new case. A test asserts that every
   refusal type implements it (loader_test.go).
10. **Product code loads manifests via `loader.LoadRepo`** (the lock,
    checked) and sees it through `Manifest.ForMachine` (its script
    variants picked; `AppContext.LoadManifest` does both).
    `assemble.AssembleWithoutFiles`, `hcltest.ManifestOf` and
    `coretest.ManifestOf` are for tests only: they skip the `file:` checks,
    and everything else — built-ins, flattening, validation — is the
    production path.
11. **No templates.** HCL's abstractions are the allowed ones, kept to
    plain values: `locals` (shared lists: `everyday_cli = [program.bat,
    program.eza]`) and user functions (`function "ssh_key"`, which saves
    repeating two `args(…)` entries in every machine). Nothing that
    generates programs or machines: every block is written out, so a
    reader finds every program by name in one place.
12. **Scripts are opt-in per machine**: `run = [script.x, args(script.x,
    "a")]` in a machine or profile. Each argument is one or more words;
    the machine's entries are "name args…", parsed by `ScriptEntry` (args
    re-joined with single spaces because they're pasted into a shell
    command line, where a newline would run the next line as a command).
    Only opted-in scripts converge and are observed; `run` errors on others.
    Args become positional params for the file script AND its check (`set
    --`, see engine.WithArgs); `managed_by = "x.sh"` checks with `x.sh
    check "$@"`, so a managing script gets them in both modes. Args on an
    inline script are an error. No implicit script application, no OS or
    bootc detection deciding membership (the old `os` filter is gone: the
    machine's opt-in decides). A script's modes (`setup_only = true`,
    `maintain_only = true`, default both) scope EXECUTION only:
    setup-new-machine converges setup-mode scripts, the home screen's
    scripts picker lists maintain-mode ones; status observes all opted-in
    scripts and `run` ignores modes. A script may declare `variant "name" {
    … }`s (its own file/run, check, run_after; description, modes and
    needs_sudo shared); a machine running it must pick one, and engines
    only see the picked one (`ForMachine`).
13. **Installers own mechanics; variants refine them.** An installer
    (`probe`, `install`, `check`, `regex`, `outdated`, `outdated_all`,
    `upgrade`, `needs_sudo`, `params`; `{pkg}` substituted) defines a
    mechanism once, repo-unique. Loadout
    ships a library (`internal/model/installerlibrary.go`: dnf, dnf-repo,
    dnf-copr, brew, brew-cask, flatpak, pacman, omarchy, omarchy-aur with
    oracles; apt install/check only) as Go values, named in manifests as
    they are (`dnf`, `brew-cask`, or `installer.dnf`), merged UNDER the
    repo's own at assembly: a repo installer of the same name replaces the
    built-in outright (and the bare name then refers to it), and
    `Manifest.BuiltinInstallers` records which survived so
    `explain`/`installers` label `(built-in)` vs `(repo)`. `requires "x" {
    programs = [...] }` adds to any installer, built-ins included, without
    redefining it. Knowledge, never detection: nothing probes the machine
    to pick an installer.
    A program lists its variants as `install_via = [brew, omarchy]` (an
    installer as it is) and `via "brew" { pkg = "vim" }` blocks (configured
    where it's named: `via "dnf-copr" { params = { copr = "x/y" } }`, `via
    "dnf" { managed_by = "x.sh" }`), so a variant never reads like a
    command being run. `custom "linux" { … }` is the variant with no
    installer: a command of its own (`custom { … }` is named "custom", for
    a program with one). Naming an installer twice, across the list and the
    blocks, is an error, so there is no hidden merge. Variants keep their
    source order. Every field is optional and defaults from the installer;
    `pkg` defaults to the program name. An installer may declare `params =
    ["copr"]`: values a variant supplies (`params = { copr = … }`),
    substituted like `{pkg}`. All declared, never inferred: a missing param
    or an undeclared one is an error, so an unsubstituted `{placeholder}`
    never reaches a shell.
    Resolution (`Manifest.ResolveInstall`/`CheckFor`, used by every
    engine/UI): command → installer install pattern (else error); check →
    variant check → installer check (else program `version`); probe →
    installer probe (else none); outdated → variant override, else
    installer `outdated_all` (one batch command per installer, per-program
    regex extracts; binaries that don't know it fall back to per-pkg), else
    installer per-pkg pattern, else no oracle (`outdated` skips and says
    so). These oracles' exit codes are always ignored. A program's
    `path = [...]` puts directories first on PATH for its commands
    (`ShellLine`), so a check never needs `tool || $HOME/.local/bin/tool`.
    Repos may also declare custom `outdated` sources: on the script they're
    about (an `outdated { }` block inside `script`, named after it unless
    it says `name`) or alone (`outdated "name" { command = … }`). The usual
    form is `updates_managed_by = "x.sh"`: `x.sh` lists, `x.sh update
    <item>` updates one row (on a program, `x.sh` prints the newest version
    and `x.sh update` updates it); `command`/`upgrade` is the long form for
    anything else, a read-only source included (`<item> <current>
    <candidate> [note…]` lines; a URL in the note becomes the row's link,
    opened with `K`; `run_script(…)` allowed, repo-unique). Unlike
    installer oracles, a source's exit code is NOT ignored: non-zero
    surfaces as `outdated source [name] failed: ...`, so a crashing oracle
    can't hide updates.
    Installers may declare `upgrade`: the ONE command that moves everything
    the mechanism manages, with no `{pkgs}` placeholder (contract 15).
    Never write cross-variant `||` chains in checks.
    `needs_sudo = true` (installer, variant, script, `outdated` source)
    declares a command that needs sudo's password without saying `sudo`
    itself (`omarchy pkg add`, a repo script); a variant's replaces its
    installer's. `setup-new-machine`, `install`, `run` and `upgrade` ask
    for the password once, after the confirmation and before the first
    step (`askForSudoUpfront` in cli/converge.go), when their plan holds a
    step that needs it: declared, or a command matching `CommandNeedsSudo`
    (core/engine/sudo.go: the word sudo, not "pseudo"). Scripts count only
    while pending (`ScriptRunner.Pending` asks the check, which `run` asks
    again). Valid credentials ask nothing; a refusal stops the run before
    any step. A background shell loop then runs `sudo -n -v` every 50s
    while loadout's pid lives, checked every second (`SudoKeepalive`), so
    a step an hour in finds them valid. Never inferred from a script's
    content: an undeclared sudo inside a repo script still prompts
    mid-run, on the terminal, as before. Home-screen runs get this for
    free: each runs one of these subcommands, in the run panel.
14. **Versioning contract.** The deliberate breaks: 0.2.0 (string install
    values became variant mappings), 0.9.0 (`templates` removed), 2.0.0
    (TOML to YAML), 3.0.0 (YAML removed: manifests are the Kotlin DSL,
    compiled into the lock), 3.1.0 (`install(installer, programs…)`
    removed for `via(installer) { install(…) }`; kept a minor release
    because the lock format didn't change) and 4.0.0 (the Kotlin DSL
    removed: manifests are HCL, compiled by the binary itself, no JDK or
    Gradle; a Kotlin repo is refused by name; the lock format is
    unchanged, so a 3.x lock still reads). A removal is decided once,
    loudly, in the release notes, never silently. The manifest language
    and the binary are one version: compile is the binary's own, so a repo
    compiles against exactly the installed binary. The lock carries
    `format` (bumped only when an older binary could misread a lock; a
    newer one is refused by name before anything else is read) and the
    `toolVersion` that wrote it: a binary refuses a lock from a newer MINOR
    (patch releases never change what a lock means), naming
    `self-upgrade`. `meta minToolVersion` (`repo { min_tool_version = … }`)
    is a floor the repo declares on top.
    New lock fields are additive with defaults. State files with
    `schemaVersion > coremodel.SchemaVersion` are skipped with a warning
    (`StateStore.LastWarnings`; new read paths must echo/log them). Bump
    SchemaVersion only for a real schema break; handle older schemas via
    defaults.
15. **Converge installs; `upgrade` upgrades, a whole mechanism at a time.**
    `setup-new-machine`/`install` add what's MISSING and never touch a
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
    (`x.sh update <item>` under `updates_managed_by`, or `upgrade = "…
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
    (`loader.ToolTooOld`), like after U. Only `sync` upgrades by
    itself: it is the command that pulls, so it's the one that meets a
    repo moved ahead of the binary.
16. **The repo's shape is declared, never assumed.** A config repo is
    `loadout.hcl` at its root, always compiled, plus the files its `repo {
    sources = [...] }` globs match, and only those (`Glob`: `*` one
    segment, `?` one char, `**` any depth; wildcards never match a leading
    dot, so `.tmux.loadout.hcl` compiles only when a glob spells the dot;
    `.git` is never entered). Nothing else: no build files, no build
    folder, nothing outside the repo. `repo { state = …, configs = … }`
    names the state and chezmoi dirs; `state` is required, with no
    default. The lock records the globs (`loadout.hcl` first) and a sha256
    of the files they match (path + content); a binary that finds them
    changed refuses with "run: loadout compile", so a lock never silently
    lags its sources. A repo with `loadout.kt` or `build.gradle.kts` and no
    `loadout.hcl` is a loadout 3 repo: compile refuses it by name. The suite runs with its own
    XDG_CACHE_HOME (seeded with a release, so `status` doesn't ask
    GitHub), never the developer's.
17. **Configs are chezmoi's, observed like everything else.** `repo {
    configs = … }` names chezmoi's source directory inside the repo; unset,
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
      files,symlinks` per refresh. Its second column is what `apply` would
      change (the same answer as `chezmoi verify`, in one call); a unit with
      any such file is `drifted`, with them in `ConfigState.Files`. Its
      first column marks a file edited since chezmoi last wrote it.
    - **chezmoi can't answer** (absent: exit 127; a template error): the
      units last seen are `unknown` with chezmoi's line as the reason, and
      `status` says it once (`StatusEngine.LastConfigsDown`); never a
      refusal for status.
    - **Writing**: `apply [unit…]` and `sync` run `chezmoi apply --no-tty`
      (a unit = its targets, absolute via `chezmoi target-path`). Without a
      terminal chezmoi aborts the whole apply on a file edited in place
      (it would ask), so both refuse first when a file they'd replace is
      edited AND drifted (`refuseEdited`, cli/apply.go), naming the files:
      keep them with `chezmoi re-add`, or replace them with `apply
      --force`. `sync` = pull → (upgrade loadout, contract 15) → refuse
      edited → apply → refresh → name what's left (missing programs,
      scripts not done) → commit → push; nothing is committed after a
      refusal or a failed apply. It never installs or runs scripts itself.
      Its pull (or a parent's, through the child's compile) can rename the
      repo's folders, so `sync` calls `AppContext.ReloadLayout()` after
      them: everything read from the layout (configs and state folders, the
      parent, chezmoi's sources) is read again, never kept from before the
      pull.
    - **State**: `MachineState.Configs`, left out of the file when empty,
      so repos without configs write what they always did and older
      readers ignore it (schema stays 1). `diff` shows a CONFIG table (`-` =
      the machine doesn't report that unit) and exits 1 on config drift.
    - **Templates' data**: `loadout compile` writes `<configs>/
      .chezmoidata/loadout.json` (`model.ChezmoiDataFiles`), which chezmoi
      loads into every template as `.loadout`: `loadout.defaults` (every
      declared key) and `loadout.machines.<hostname>` (each machine's
      merged table). That shape is the contract with templates; the lock's
      layout stays loadout's own (templates reading the lock broke on any
      change to it). Compile also writes the partial that picks this host's
      table, `<configs>/.chezmoitemplates/loadout/machine`
      (`model.ChezmoiPartial`): the machine loadout runs as
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
      say. `init --configs` scaffolds such a repo (`configs =
      "loadouts"`, a `.chezmoiroot`, `loadouts/`), every manifest in
      `loadouts/`, laid out where files land: a tool's manifest sits at its
      destination (beside its dotfiles; with none, a dot-file, or a
      dot-folder for one with scripts, since chezmoi deploys no dot entry
      and a plain folder holding only a manifest would land empty in
      `$HOME`), and what lands outside `$HOME` and belongs to no tool
      (system packages, hardware) is a folder per concern in `.etc/`
      (`.etc/dnf/`).
      No `system/` beside it: one folder holds the whole loadout. `**`
      never enters a dot folder, so the scaffold's globs spell it
      (`loadouts/**/.*/.*.loadout.hcl`) beside
      `loadouts/**/.*.loadout.hcl`, and `.etc/`'s folders get
      `loadouts/.etc/*/.*.loadout.hcl`. Plain `init` keeps `programs/` and
      `maintenance/`.

18. **A child repo inherits a parent; nothing flows back.** A private repo
    names a public one in its `loadout.hcl`, `repo { parent { name = …,
    path = … } }` (`~/…`, absolute, or relative to the child), and its
    manifests use the parent's installers, programs, scripts, outdated
    sources, profiles and data schema by name (`program.x`, checked at
    compile like its own). One level, one parent; any number of children,
    none of which the parent knows.
    - **Compile** (hclconf/compile.go): the parent's own lock names its
      globs; compile refuses a parent that has no lock, whose lock is stale
      (its manifests' hash differs: an unknown file set), that is itself a
      child, or whose manifests are Kotlin. It decodes the parent's files
      as a parent (every origin `parent:`), then the child's against the
      parent's namespace, and merges them (`assemble.DraftOver`): the
      parent's machines, meta and layout stay out; a name both declare, a
      machine in both and a child data schema are errors; the floor is the
      higher `min_tool_version`. A parent's mistakes are reported prefixed
      `parent <name>: `. Unused and transitional warnings are the child's
      own declarations' only.
    - **Lock**: `layout.parent` (name, path as written, state, configs,
      globs, hash of the parent's manifests); a parent declaration's origin
      is `parent:<folder>` (`Origin`), its `file` values `$LOADOUT_PARENT/…`
      (a built-in installer that takes them runs in the child). A repo
      without a parent writes exactly what it did. A parent edit the child
      hasn't compiled is refused at load like a stale lock, and a missing
      parent by name and path.
    - **Runtime**: commands as in contract 5; configs are two chezmoi
      sources, the parent's then the child's (`ConfigEngine`): units span
      both, a target both manage is `unknown` and refused by `apply`, and
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
