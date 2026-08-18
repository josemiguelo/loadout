# loadout

One native binary that sets up your unix-like machines from a shared, git-versioned
config repo — and tracks which programs (and which versions) every machine has.

Write a manifest once; on each machine run one command to install what's missing,
one command to publish that machine's state, and one command to see how all your
machines compare.

**Status: feature-complete for v0.1.** All commands (`init`, `status`,
`install`, `run`, `diff`, `sync`) plus the interactive TUI dashboard work on
Linux; CI covers Linux and macOS, and tagged releases ship binaries for
linux-x64, macos-arm64, and macos-x64.

No JVM, no runtime dependencies — Kotlin/Native compiled to a single executable.
It shells out to your package managers and `git`, so those must be on `PATH`.

---

## How it works

Everything revolves around a **config repo**: a git repository you create once and
clone onto every machine.

```
machines/
├── manifest.toml        # what should be installed, everywhere (you write this)
├── manifest.d/          # optional: split large manifests into fragments
│   └── dev-tools.toml   #   more [programs.*] / [scripts.*] blocks, merged in
├── machines/            # one authored config file per machine (required to install)
│   └── laptop.toml      #   which install variant laptop uses per program
├── scripts/             # your setup scripts (you write these)
└── state/
    ├── laptop.json      # written by laptop  ─┐ each machine writes only
    └── vps.json         # written by vps     ─┘ its own file → no conflicts
```

Everything above `state/` is **authored intent** (edited by you, versioned
deliberately); `state/` is **generated observation** (written by the tool,
disposable). The two never mix.

- The **manifest** declares programs (their install command variants and how to
  read their version), scripts (arbitrary setup steps with idempotency checks),
  and an explicit per-machine mapping of which install variant each machine uses.
- Each machine writes its own **state file** with what it actually has installed.
- Machines see each other by committing and pulling those state files — plain git,
  no server, works offline.

---

## A tour

### 1. Create your config repo

```console
$ loadout init ~/machines
Created ~/machines/manifest.toml
Created ~/machines/scripts/
Created ~/machines/state/
Created ~/machines/machines/ (rename example.toml.sample to <your-machine>.toml)
Created ~/machines/manifest.d/ (optional manifest fragments; see example.toml.sample)
Initialized git repository.

Next steps:
  1. Edit ~/machines/manifest.toml — add your programs and scripts
  2. Map each program to an install key in machines/<your-hostname>.toml
  3. loadout --repo ~/machines status
  4. Add a remote and push, then clone it on your other machines
```

`init` refuses to overwrite an existing `manifest.toml`, and skips `git init` if
you're already inside a repository.

All examples below assume you either `cd ~/machines`, pass `--repo ~/machines`,
or `export LOADOUT_REPO=~/machines`.

### 2. Describe a program

Open `manifest.toml`. Every program has three parts: metadata, a **version check**,
and a table of **install commands keyed by arbitrary labels** — package-manager
names by convention, but any label works:

```toml
[programs.ripgrep]
description = "fast grep"        # optional
tags = ["cli"]                   # optional, free-form
depends-on = []                  # programs that must be installed before this one

[programs.ripgrep.version]
command = "rg --version"                  # any shell command
regex = "ripgrep ([0-9][0-9a-zA-Z.-]*)"   # capture group 1 = the version

[programs.ripgrep.install]
brew = "brew install ripgrep"
dnf = "sudo dnf install -y ripgrep"
apt = "sudo apt-get install -y ripgrep"
pacman = "sudo pacman -S --noconfirm ripgrep"
```

The keys are free-form, which covers two important cases. Things no package
manager provides (a `script` entry by convention):

```toml
[programs.rustup.install]
script = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
```

…and programs that install *differently per distro*, even outside a package
manager — define one key per variant:

```toml
[programs.1password.install]
script-fedora = "sudo rpm --import https://downloads.1password.com/... && sudo dnf install -y 1password"
script-ubuntu = "curl -sS https://downloads.1password.com/... | sudo tee ... && sudo apt install -y 1password"
brew = "brew install --cask 1password"
```

When install logic outgrows a one-liner, put it in a repo script and reference
it with the **`file:`** prefix — the file's existence is validated on every
manifest load, exactly like a `[scripts.*]` `file`:

```toml
[programs.1password.install]
script-fedora = "file:scripts/install-1password-fedora.sh"
script-ubuntu = "file:scripts/install-1password-ubuntu.sh"
brew = "brew install --cask 1password"
```

Which key a given machine uses is decided by that machine's mapping — the next
section. Every command in the manifest runs through `sh -c` **with the repo
root as working directory** (installs, script runs, version checks, and
`check`s alike — deterministic no matter where you invoke the tool from), so
pipes, `$HOME`, redirects and `&&` all behave as they would in your terminal.

### 3. Map each machine to its install commands

**There is no auto-detection.** Every machine has its own file under
`machines/` declaring, explicitly and per package, which entry of the install
table it uses. The filename is the machine name — its hostname, or whatever
you pass with `--machine` / `LOADOUT_MACHINE`:

```toml
# machines/laptop.toml — laptop runs Fedora
[pm]
git = "dnf"
ripgrep = "dnf"
rustup = "script"
1password = "script-fedora"
```

```toml
# machines/vps.toml — vps runs Ubuntu
[pm]
git = "apt"
ripgrep = "apt"
rustup = "script"
1password = "script-ubuntu"
```

These files are the *only* place machine configs may live — a `[machines.*]`
section in `manifest.toml` (or a fragment) is a validation error, so there is
exactly one spot to look for any machine's setup. Provisioning a machine that
resembles an existing one starts with `cp machines/laptop.toml machines/new.toml`.

This is strict by design — `install` refuses to run (before executing anything)
when:

- the machine has no `machines/<name>.toml` config file at all,
- any program in the plan has **no mapping** for this machine,
- a mapped entry names a known package manager (`brew`/`dnf`/`apt`/`pacman`)
  whose binary **isn't actually installed** on the machine (probed with
  `command -v`; e.g. `dnf` mapped on an Arch box). Custom keys like
  `script-fedora` have no binary to check and are always accepted.

```console
$ loadout install --dry-run
error: cannot build install plan:
  - program 'bat' has no pm defined for machine 'laptop' (add it to machines/laptop.toml)
  - package manager 'pacman' (mapped for ripgrep) is not installed on machine 'laptop'
```

On top of that, *every* manifest load — on any machine — validates that mappings
reference real programs and existing install keys, so typos are caught repo-wide:

```
error: Invalid manifest:
  - machines/vps.toml maps 'ripgrep' to 'atp', but programs.ripgrep.install has no 'atp' entry (has: apt, brew, dnf)
```

#### Splitting a growing manifest

When `manifest.toml` gets long, move any subset of `[programs.*]` and
`[scripts.*]` blocks into fragment files under `manifest.d/` — organized
however you want:

```
manifest.d/
├── cli-tools.toml       # [programs.ripgrep], [programs.fzf], ...
├── development.toml     # [programs.rustup], [programs.docker], ...
└── desktop.toml         # [programs.1password], [scripts.gnome-settings], ...
```

Fragments use exactly the same syntax as the manifest and are merged into it
before validation, so cross-file references (a program in one fragment
depending on a program in another, a machine file mapping them) all work.
Rules: `[meta]` may only appear in the root `manifest.toml`, machine configs
may not appear in fragments (they live in `machines/`), and defining the same
program or script twice is an error naming the offending file — splitting
never silently overrides anything.

**Validation**: the manifest is checked on every load. Unknown `depends-on`
references, unknown `after` references, dependency cycles, and unknown package
managers in `[machines.*]` are all rejected with a message naming the problem —
including the actual cycle path:

```
error: Invalid manifest:
  - dependency cycle among programs: a -> b -> c -> a
```

### 4. Describe a setup script

Scripts cover everything that isn't "install a package": cloning dotfiles,
writing configs, enabling services.

```toml
[scripts.dotfiles]
description = "clone and link dotfiles"
file = "scripts/dotfiles.sh"         # a script in the repo — must exist
os = ["linux", "macos"]              # optional filter; omit = all OSes
check = "test -d $HOME/.dotfiles"    # exit 0 = already done → skipped
after = ["programs.git"]             # ordering, see below

[scripts.enable-fstrim]
run = "sudo systemctl enable --now fstrim.timer"   # inline command instead
check = "systemctl is-enabled fstrim.timer"
```

- Exactly one of **`file`** or **`run`** per script — never both, never neither:
  - `file` is a path relative to the repo root, executed as `sh '<path>'` with
    the repo root as working directory. **Its existence is validated on every
    manifest load**, so a typo'd or forgotten script file fails immediately on
    every machine — not at execution time on the one fresh machine that needed it.
  - `run` is an inline shell command, never interpreted as a path.
- `check` is the idempotency gate: if it exits 0 the script is considered done
  and skipped (unless `--force`).
- `after` lists steps that should run first *if they're part of the same run*.
  It's ordering only — it never pulls anything in.

**`depends-on` vs `after`** — they answer different questions:

|                             | `depends-on` (programs) | `after` (scripts) |
|-----------------------------|-------------------------|-------------------|
| Points to                   | programs                | programs and scripts |
| Forces the target to be included | **yes** (transitive)   | no |
| Affects order               | yes                     | yes (that's all it does) |

Installing a program is idempotent and safe to auto-include, so programs get real
dependency edges. Scripts are arbitrary shell with side effects, so they only get
the weak "sequence me later" edge — a script that truly requires git will fail on
its own, or you encode the requirement in its `check`.

### 5. See where this machine stands: `status`

```console
$ loadout status
Machine: laptop (linux/fedora, x86_64)

PROGRAM  STATUS     VERSION
git      installed  2.55.0
ripgrep  installed  15.1.0
rustup   missing    -

State written to state/laptop.json
```

What happened:

1. The machine was identified — name from the hostname (overridable with
   `--machine`), OS from `uname`, distro from `/etc/os-release`, architecture.
2. Every program's `version.command` ran (concurrently, 8 at a time) and the
   regex was applied. Statuses:
   - `installed` + version — command succeeded, regex matched
   - `installed`, no version — command succeeded, regex didn't match (fix your regex)
   - `missing` — command failed (exit ≠ 0, typically "command not found")
   - `unknown` — the program declares no `[programs.x.version]` block
3. Every applicable script's `check` command ran too, recording each script as
   `done` (check passed — whether or not the tool ever executed it) or
   `pending` (check failed). Scripts without a `check` only carry run history;
   scripts excluded by their `os` filter are absent.
4. `state/laptop.json` was written — unless nothing but the timestamp changed,
   in which case the file is left untouched (keeps git history clean).

Variants:

```console
$ loadout status --json       # print the full state document instead
$ loadout status --no-write   # check but don't touch the state file
```

### 6. Install what's missing: `install`

```console
$ loadout install
Checking current state...

Plan for laptop:
  = git  (installed 2.55.0)
  = ripgrep  (installed 15.1.0)
  + rustup  [script]  ->  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  ~ script dotfiles

Proceed? [y/N] y

==> installing rustup
info: downloading installer        ← live output; sudo prompts work
...

==> ran script dotfiles (exit 0)

Updating state...
Done: 1/1 programs installed, 1 scripts run.
```

Plan legend: `+` will install, with the machine's mapped install key in
brackets · `=` already installed · `~` script that will run. There is no
"not installable" state — an unmapped program is an error that aborts the plan
(see [the mapping rules](#3-map-each-machine-to-its-install-commands)).

The rules:

- **`install`** (no names) = converge the whole manifest: every missing program,
  then every applicable script (in `after` order, `check` gates respected).
- **`install NAME...`** = just those programs **plus their transitive
  `depends-on` closure**, dependencies first. Scripts don't run in this mode.
- Installs stream output directly to your terminal — interactive prompts and
  progress bars work. Installs are sequential (package managers hold locks;
  parallel sudo prompts would be chaos).
- After each install the version check runs again, so the plan's success is
  measured by "is it actually there now", not just the installer's exit code.
- A failed install doesn't abort the run; failures are summarized at the end and
  the exit code is 1 if anything failed.

Flags:

```console
$ loadout install --dry-run        # print the plan, do nothing
$ loadout install --yes            # skip the confirmation (for automation)
$ loadout install --skip-scripts   # programs only
$ loadout install ripgrep bat      # specific programs (+ their deps)
```

### 7. Run scripts on demand: `run`

```console
$ loadout run dotfiles
ran dotfiles (exit 0)
State updated.

$ loadout run dotfiles
skipped dotfiles: already done (check passed; use --force to run anyway)

$ loadout run dotfiles --force
ran dotfiles (exit 0)
```

Multiple scripts run in `after` order. Scripts whose `os` filter excludes this
machine are skipped with a note. Script outcomes (status `done`/`failed`, last
run time, exit code) are recorded in the state file. Exit code 1 if any script
failed.

### 8. Publish this machine: `sync`

```console
$ loadout sync
Pulling latest changes...
Refreshing state for laptop...
Committed state/laptop.json.
Pushed.
```

`sync` = `git pull --rebase --autostash` → re-run all version checks → write
`state/<machine>.json` → `git add` + commit **only that file** → `git push`.

- If nothing changed: `State unchanged; nothing to commit.` — safe to run from
  cron.
- No upstream configured? It tells you, skips pull/push, but still commits
  locally.
- `--no-push` commits without pushing; `-m "message"` overrides the default
  commit message (`laptop: update state`).
- Manifest edits are *your* commits — `sync` never touches anything except this
  machine's state file.

### 9. Compare your fleet: `diff`

Once two or more machines have synced their state:

```console
$ loadout diff
PROGRAM    laptop    vps
git        2.55.0    2.43.0    !drift
ripgrep    15.1.0    15.1.0
rustup     1.27.1    missing   !incomplete

1 program(s) with version drift, 1 with missing installs.
$ echo $?
1
```

Cell values: a version (installed) · `ok` (installed, version unparsed) ·
`missing` · `-` (that machine's state has no entry for the program — stale state
file, or the program has no version check).

Row flags: `drift` = two or more machines report *different* versions ·
`incomplete` = missing on at least one machine.

The exit code is the point: **0 = fleet in sync, 1 = something's off** — wire it
into cron or CI to get notified. `--machines laptop,vps` narrows the comparison.

To fix what `diff` reports: run `install` on the machine that's missing things,
or upgrade through your package manager, then `sync` again.

### 10. The dashboard: bare `loadout` (TUI)

Run `loadout` with no arguments in a real terminal (or `loadout
tui` with options) and you get an interactive dashboard instead of help text —
the same program × machine matrix as `diff`, live:

```
 loadout 0.1.0   ~/machines  ·  laptop

 PROGRAM     laptop    vps
 cowsay      3.8.4     missing
 ripgrep     15.1.0    15.1.0      ← selected row is an inverse-video bar

 SCRIPTS
 dotfiles    done      pending

 ✔ refreshed
 ↑↓ move · r refresh · i install/run · a all missing · s sync · d details · l log · q quit
```

Colors carry the semantics: versions green (yellow on drift), `missing`/`failed`
red, `pending` yellow, `-` dim.

Keys:

| Key | Action |
|---|---|
| `↑`/`↓` (or `k`/`j`) | Move between rows |
| `d` / `Enter` | Details pane for the selected row: version check, full install table with this machine's mapped key marked, depends-on / check / after |
| `r` | Re-run all version and script checks, update the state file (spinner while working) |
| `i` | Install the selected program (same strict plan + errors as the CLI) — or run the selected script |
| `a` | Install everything missing on this machine |
| `s` | Sync: pull → refresh → commit state → push |
| `l` | Toggle the log view (output of installs/scripts/sync; the dashboard itself stays clean) |
| `y` / `n` | Confirm / cancel a pending install or script run |
| `q` / `Esc` | Quit (from a pane: back to the dashboard) |

Everything the TUI does goes through the same engines as the CLI — identical
plans, identical strict-resolution errors (shown in the status line), identical
state files.

TUI specifics to know:

- **It needs a real terminal.** Piped/redirected output falls back to the CLI
  (bare invocation prints help); `tui` refuses with a clear error.
- **sudo:** install output is captured for the log view, which would swallow a
  password prompt. If a plan contains `sudo` commands and your credentials
  aren't cached, the TUI refuses with a hint — run `sudo -v` first, or use
  `loadout install` in the CLI where prompts work normally.
- Command output appears in the log when each step *finishes* (not streamed
  live); the status line shows a spinner plus the latest log line meanwhile.
- Bare `loadout` reads `LOADOUT_REPO`/`LOADOUT_MACHINE`;
  use `loadout --repo ... tui` to pass flags.

### 11. Multiple machines in practice

On a new machine:

```console
$ git clone git@github.com:you/machines.git ~/machines
$ export LOADOUT_REPO=~/machines     # put in your shell profile
$ loadout install --yes && loadout sync
```

Don't have a second machine handy? Simulate one — `--machine` changes which
state file is written (add a `machines/fake-vps.toml` config if you want to
test installs as it, too):

```console
$ loadout --machine fake-vps status
$ loadout diff       # now compares your real machine against fake-vps
```

(Testing without GitHub: `git init --bare ~/origin.git`, add it as a remote, and
`sync` pushes there.)

### 12. Global options

Valid on every command, before the subcommand:

| Option | Env var | Default | Meaning |
|---|---|---|---|
| `--repo PATH` | `LOADOUT_REPO` | current directory | Config repo location |
| `--manifest FILE` | — | `manifest.toml` | Manifest file inside the repo |
| `--machine NAME` | `LOADOUT_MACHINE` | hostname (first label) | Identity for state tracking and mapping lookup |
| `-v, --verbose` | — | off | Reserved (no effect yet) |

There is deliberately no `--pm` flag and no auto-detection: the only source of
truth for how a machine installs each program is its `machines/<name>.toml`
config file (see
[section 3](#3-map-each-machine-to-its-install-commands)). `--machine` changes
which config is used. Version checks are unaffected by mappings — they just
use `PATH`.

### 13. The state file

`state/<machine>.json` — written only by that machine, pretty-printed with
stable ordering so git diffs stay readable:

```json
{
  "schemaVersion": 1,
  "machine": "laptop",
  "os": "linux",
  "distro": "fedora",
  "arch": "x86_64",
  "toolVersion": "0.1.0",
  "updatedAt": "2026-08-17T12:00:00Z",
  "programs": {
    "git":     { "status": "installed", "version": "2.55.0" },
    "rustup":  { "status": "missing",   "version": null }
  },
  "scripts": {
    "dotfiles": { "status": "done", "lastRun": "2026-08-17T11:58:02Z", "exitCode": 0 }
  }
}
```

Program statuses: `installed` / `missing` / `unknown` (no version check
declared). Script statuses come from *observation*: on every refresh the
script's `check` runs, recording `done` (check passed) or `pending` (check
failed) — even for scripts the tool never executed, and even right after a run
(the check is the truth, so a "successful" run whose check still fails shows
`pending`). `lastRun`/`exitCode` are history from actual tool-executed runs
(`failed` appears only for check-less scripts whose run failed). `updatedAt`
bumps only when actual content changes. Unknown JSON keys are ignored on read,
so newer tool versions can extend the schema.

### 14. Version compatibility between the repo and the binary

Mixed fleets happen — machines upgrade loadout at different times. Two guards
keep that safe:

**The repo declares its floor.** When you start using a manifest feature that
needs a newer loadout, bump `min-tool-version` in the same commit:

```toml
[meta]
min-tool-version = "0.2.0"
```

A machine running an older binary then refuses *everything* with the right
instruction — instead of silently ignoring manifest keys it doesn't know:

```
error: this config repo requires loadout >= 0.2.0 (you have 0.1.0) — upgrade loadout on this machine
```

**Old repos keep working on new binaries.** The manifest format only evolves
additively (new optional fields), so a repo created with loadout 0.1 parses
forever. State files carry a `schemaVersion` and `toolVersion`; a state file
written by a *newer* loadout than yours is skipped with a warning
(`state/vps.json was written by a newer loadout … upgrade loadout to see this
machine`) rather than misread — and state is disposable observation anyway:
any machine can regenerate its own file with one `status`.

---

## Installing

Tagged releases ship prebuilt binaries for **linux-x64**, **macos-arm64**, and
**macos-x64** (built by the GitHub Actions release workflow):

```console
$ tar xzf loadout-v0.1.0-linux-x64.tar.gz
$ mv loadout ~/.local/bin/
```

CI runs on every push/PR: unit + integration tests on Linux, unit tests +
release builds + integration on macOS (`.github/workflows/ci.yml`); pushing a
`v*` tag builds, strips, and attaches all three tarballs to a GitHub Release
(`.github/workflows/release.yml`). linux-arm64 remains buildable from source
but isn't released yet.

## Building from source

Requires a JDK (21 works) and network for the first build; the Gradle wrapper
fetches everything else.

```console
$ ./gradlew :app:linkDebugExecutableLinuxX64     # fast build for development
$ ./app/build/bin/linuxX64/debugExecutable/loadout.kexe --help

$ ./gradlew :app:linkReleaseExecutableLinuxX64   # optimized binary
$ cp app/build/bin/linuxX64/releaseExecutable/loadout.kexe ~/.local/bin/loadout
```

Declared targets: `linuxX64`, `linuxArm64`, `macosX64`, `macosArm64`. Kotlin/
Native cannot cross-compile macOS binaries from Linux — mac builds need a mac
(or the CI planned for Phase 5).

### Tests

```console
$ ./gradlew :core:linuxX64Test     # 59 unit tests (parsing, diffing, engines — no real processes)
$ ./gradlew :app:linuxX64Test      # 8 TUI-model tests (key reducers, mode transitions)
$ ./integration/run-tests.sh       # 27 black-box tests driving the real binary
                                   # through init/status/install/run/diff/sync
                                   # against a temp repo + local bare git remote
```

### Project layout

```
core/   business logic, no CLI/TUI deps — models, manifest loader (ktoml),
        state store (Okio + kotlinx-serialization), diff engine, install/script
        engines, process runner (kommand), detection, git client
app/    Clikt CLI commands, Mosaic TUI (tui/), entry point with TTY dispatch
```

Stack: Kotlin/Native 2.4.0 · [Clikt](https://github.com/ajalt/clikt) (CLI) ·
[ktoml](https://github.com/orchestr7/ktoml) (manifest) · kotlinx-serialization
(state) · [kommand](https://github.com/kgit2/kommand) (processes) ·
[Okio](https://square.github.io/okio/) (filesystem) ·
[Mosaic](https://github.com/JakeWharton/mosaic) (TUI).

---

## Roadmap

| | Phase | Status |
|---|---|---|
| Gradle skeleton, 4 native targets | 0 | ✅ done |
| Manifest/state models, diff engine | 1 | ✅ done |
| Detection, version checks, `status` | 2 | ✅ done |
| `install` / `run` / `diff` / `sync` / `init`, per-machine PM | 3 | ✅ done |
| Mosaic TUI dashboard — bare `loadout` opens an interactive program × machine view: navigate, install, refresh, sync, log view | 4 | ✅ done |
| CI + releases — GitHub Actions (Linux + macOS runners), prebuilt binaries (linux-x64, macos-arm64, macos-x64) attached to tagged releases | 5 | ✅ done |

Known limitations today: no Windows support (unix-like only) · dependency edges
have no version constraints (`depends-on = ["git"]`, not `git >= 2.40`) ·
`--verbose` is accepted but unused · linux-arm64 builds but isn't released ·
macOS binaries are built and integration-tested in CI but haven't been used
day-to-day yet.
