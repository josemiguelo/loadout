# loadout

One native binary that sets up your unix-like machines from a shared, git-versioned
config repo — and tracks which programs (and which versions) every machine has.

Write a manifest once; on each machine run one command to install what's missing,
one command to publish that machine's state, and one command to see how all your
machines compare.

**Status: feature-complete.** All commands (`init`, `status`, `setup-new-machine`,
`outdated`, `check`, `maintain`, `run`, `diff`, `sync`) plus the interactive
TUI dashboard work on Linux; CI covers Linux and macOS, and tagged releases
ship binaries for linux-x64, macos-arm64, and macos-x64.

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
you're already inside a repository. The scaffold ships ready-to-use
[installers](#2-describe-a-program) (dnf/apt/pacman/brew) plus a `pkg`
[template](#templates-many-packages-no-boilerplate) as
`manifest.d/00_installers.toml`, so most programs are declared in 1–2 lines
from day one while `manifest.toml` stays a minimal `[meta]`.

All examples below assume you either `cd ~/machines`, pass `--repo ~/machines`,
or `export LOADOUT_REPO=~/machines`.

### 2. Describe a program

Two concepts split the work. **Installers** define each install *mechanism*
once per repo — its availability probe, install command pattern, and version
check pattern, with `{pkg}` standing for the package id:

```toml
[installers.dnf]
probe = "dnf"                        # binary that must exist before installing
install = "sudo dnf install -y {pkg}"
check = "rpm -q {pkg}"               # version check; capture group 1 = the version
regex = "([0-9]+\\.[0-9][0-9.]*)"
```

**Programs** then say which mechanisms deliver them. For a standard package —
same name everywhere, standard commands — that's one line:

```toml
[programs.ripgrep]
description = "fast grep"        # optional
tags = ["cli"]                   # optional, free-form
depends-on = []                  # programs that must be installed before this one
via = ["dnf", "apt", "pacman", "brew"]
```

`via` expands to one install key per installer, with everything inherited:
command, check, and probe. `{pkg}` defaults to the program name.

When something deviates, declare an **install variant** — a table keyed by a
free-form label; the machine's mapping picks which key it uses. Every field is
optional and falls back to the variant's installer (an explicit `installer =`
reference, or the installer its key names):

```toml
[programs.jetbrains-toolbox.install.brew-linux]
installer = "brew-cask"                # mechanics: check + probe from here
pkg = "jetbrains-toolbox-linux"        # package id differs from the program name
command = "brew tap ublue-os/tap && brew trust ublue-os/tap && brew install --cask jetbrains-toolbox-linux"

[programs.jetbrains-toolbox.install.brew-macos]
installer = "brew-cask"                # everything else derived: installs the
                                       # 'jetbrains-toolbox' cask, checks it, probes brew
```

Variants also cover things no package manager provides (a `script` key by
convention, with no installer at all) and per-distro install flows:

```toml
[programs.rustup.install.script]
command = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"

[programs.1password.install.script-fedora]
command = "sudo rpm --import https://downloads.1password.com/... && sudo dnf install -y 1password"

[programs.1password.install.script-ubuntu]
command = "curl -sS https://downloads.1password.com/... | sudo tee ... && sudo apt install -y 1password"
```

A variant can override just one piece of its installer's mechanics — the
classic case is a virtual provide, where only the check deviates:

```toml
[programs.zlib-devel]
via = ["dnf"]

[programs.zlib-devel.install.dnf]      # refines via's entry for the same key
check = "rpm -q --whatprovides zlib-devel"   # regex + probe still inherited
```

For a program with no resolvable check (script variants without an installer),
the program-level `[version]` block is the fallback:

```toml
[programs.rustup.version]
command = "rustup --version"
regex = "rustup ([0-9.]+)"
```

**Resolution per mapped key** — most specific wins, field by field:

| field   | variant | else installer | else            |
|---------|---------|----------------|-----------------|
| command | `command` | `install` pattern | error at load |
| check   | `check` (+ `regex`) | `check` pattern | program `[version]`, else status `unknown` |
| probe   | `probe` | `probe`        | no probe        |

When install logic outgrows a one-liner, put it in a repo script and reference
it with the **`file:`** prefix — the file's existence is validated on every
manifest load, exactly like a `[scripts.*]` `file`. It works in `command` and
in every check command (variant `check`, program `[version]`, script `check`)
alike. Anything after the first space is passed to the script as arguments (so
one script can serve several roles); the path itself therefore can't contain
spaces:

```toml
[programs.dev-deps.install.dnf]
command = "file:scripts/dev-deps.sh install"   # runs: sh 'scripts/dev-deps.sh' install
check = "file:scripts/dev-deps.sh check"       # runs: sh 'scripts/dev-deps.sh' check
```

Which key a given machine uses is decided by that machine's mapping — the next
section. Every command in the manifest runs through `sh -c` **with the repo
root as working directory** (installs, script runs, version checks, and
`check`s alike — deterministic no matter where you invoke the tool from), so
pipes, `$HOME`, redirects and `&&` all behave as they would in your terminal.

#### Templates: many packages, no boilerplate

With installers carrying the mechanics, a template is mostly a **package
list**: declare the shared `via` once, then one word per package:

```toml
[templates.pkg]
via = ["dnf", "apt", "pacman", "brew"]
packages = ["vlc", "okular", "htop"]

[templates.pkg.overrides.vlc]          # per-package deviations, validated
description = "VLC media player"       #   (overriding a non-member is an error)
```

Programs anywhere in the repo (e.g. spread across `manifest.d/` topic
fragments) can also opt in by reference:

```toml
[programs.solaar]
template = "pkg"
description = "Logitech device manager"
```

**What expansion creates:** every entry becomes a full standalone program at
manifest load, as if you had written `via = [...]` (and any other template
fields) on it by hand. Nothing downstream knows a template was involved:
individual status/diff rows, individual versions, individual machine mappings,
identical validation. Explicit fields win over template fields; `version` is
replaced whole; `install` variant tables merge per key; `{name}` in a
template's string fields is substituted with the program name. Templates are
repo-unique (defining the same name twice is an error) and can live in
fragments.

One shell footgun to know when writing custom check commands: don't end them
with a pipe (`... --version | head -1`) — a pipeline's exit code is the *last*
command's, which would make missing programs look installed.

#### Inspecting the expanded manifest: `show`

`loadout show <name>...` prints any program or script **as the engine sees
it** — templates and `via` expanded, every variant fully resolved through its
installer (command, check, probe), this machine's mapped key marked, plus the
last observed state:

```console
$ loadout show solaar
program solaar  — Logitech device manager
  version      (none — status will always be 'unknown')
  install.dnf  sudo dnf install -y solaar  [installer: dnf]   <- laptop
  check.dnf    rpm -q solaar  =~ /([0-9]+\.[0-9][0-9.]*)/
  probe.dnf    dnf
  install.brew  brew install solaar  [installer: brew]
  check.brew   brew list --versions solaar  =~ /([0-9]+\.[0-9][0-9.]*)/
  probe.brew   brew
  observed     installed 1.1.20  (state/laptop.json)
```

Use it whenever you're unsure what a `template`/`via` line produced, which
command `install` would actually run, or why a mapping fails. (The TUI's `d`
details pane shows the same data interactively.)

#### Recipe: adding a program

Every program is one question asked repeatedly: *how does each machine get it,
and how do we verify it's there?* Match your case top-down — the first shape
that fits is the right one:

**1. Standard package, standard name** → one `via` line, listing only the
installers where the claim is *actually true* (the tool won't verify it —
a wrong entry becomes a failed install on whatever machine maps it):

```toml
[programs.ripgrep]
description = "fast grep"
via = ["dnf", "brew"]
```

**2. Package id differs from the program name** (flatpak reverse-DNS ids,
renamed casks) → a variant with `pkg`; everything else derives:

```toml
[programs.obsidian.install.flatpak]
pkg = "md.obsidian.Obsidian"
```

**3. Delivered by a mechanism, but the install command is special** (taps,
extra flags) → a variant with `command`, keyed by the installer so check and
probe still derive. Name the key after what it truly is (`brew-cask`, not
`brew`, for a cask):

```toml
[programs.tpack.install.brew-cask]
command = "brew install tmuxpack/tpack/tpack"
```

**4. Install needs a prerequisite step** (a tap, a repo, a remote) → make the
prerequisite its **own program** and wire `depends-on` — don't chain `&&`
into one command. Each step then has its own check and shows its own status:

```toml
[programs.ublue-os-tap.install.brew]
command = "brew tap ublue-os/tap && brew trust ublue-os/tap"
check = "brew tap | grep -x ublue-os/tap"
regex = "(ublue-os/tap)"

[programs.jetbrains-toolbox]
depends-on = ["ublue-os-tap"]

[programs.jetbrains-toolbox.install.brew-linux]
installer = "brew-cask"
pkg = "jetbrains-toolbox-linux"
```

**5. Install is a repo script that integrates with a package manager**
(adds a yum repo then dnf-installs, say) → key the variant by that installer:
the `file:` script overrides only the command, while the rpm check and probe
still derive. Override `regex` if the version format is unusual:

```toml
[programs.sublime-text.install.dnf]
command = "file:scripts/install-sublime-fedora.sh"
regex = "([0-9]+)"                      # build numbers, not dotted versions
```

**6. The truth isn't in any package database** (dnf groups, meta-steps) →
override the `check` with a two-mode script; one list in one script serves
both modes:

```toml
[programs.virtualization.install.dnf]
command = "file:scripts/virtualization.sh install"
check = "file:scripts/virtualization.sh check"
```

The same trick handles virtual provides — override just the check
(`check = "rpm -q --whatprovides zlib-devel"`), keep everything else derived.

**7. No package manager involved at all** (curl-pipe-sh, hand-rolled
installs) → a `script`-keyed variant with only a `command`, plus a
program-level `[version]` so status has something to observe:

```toml
[programs.cursor-agent.version]
command = "cursor-agent --version 2>/dev/null || $HOME/.local/bin/cursor-agent --version"
regex = "([0-9]+\\.[0-9][0-9.]*)"

[programs.cursor-agent.install.script]
command = "curl https://cursor.com/install -fsS | bash"
```

**8. Must run before everything else** (package-manager config like dnf.conf
tweaks) → a program (programs precede all scripts) declared in a fragment
that sorts first (`manifest.d/00_…`), since dependency-free programs install
in declaration order.

**Not a program at all?** If there's nothing to *have* — dotfiles cloning,
service enablement, config edits — it's a `[scripts.*]` step with a `check`,
opted into per machine.

**Where the check lives** — the invariant behind all these shapes: loadout
never trusts "it ran once"; everything converges against a check it can
re-ask. But an install script never needs a check *mode* of its own — the
check is declared where the truth lives, via the resolution chain (variant
`check` → installer `check` → program `[version]`):

- script keyed under a package manager (shape 5) → the pm database is the
  truth, the installer's check (`rpm -q {pkg}`) derives;
- script with no pm behind it (shape 7) → the binary's self-report is the
  truth, the `[version]` block observes it;
- truth in neither place (shape 6, and every `[scripts.*]` step) → only then
  does the check become yours to write: an inline one-liner, or the script's
  own two-mode `check` argument.

Rules that hold for every shape: never write cross-variant `||` chains in
checks (the mapped key picks one true check; a chain masks which source owns
the program — and expect the version to be *the package manager's* truth,
e.g. rpm's `1.23.2`, not the binary's self-reported number). Never end a
check in a pipe (the pipeline's exit code would make missing look installed).
Prefer `file:` for any repo script so a missing file fails at load, not as an
eternal `pending`.

Then close the loop — every new program needs its machine mapping, and `show`
tells you what you actually built:

```console
$ loadout show newprog        # resolved commands/check/probe per key
$ vi machines/$(hostname).toml   # map it: newprog = "<key>"
$ loadout setup-new-machine --dry-run   # plan shows the exact command, deps first
$ loadout status              # observation agrees?
```

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

Machine files also declare which scripts the machine runs (see the
[scripts opt-in](#4-describe-a-setup-script) — a `[scripts]` table next to
`[pm]`). These files are the *only* place machine configs may live — a
`[machines.*]` section in `manifest.toml` (or a fragment) is a validation
error, so there is exactly one spot to look for any machine's setup. Provisioning a machine that
resembles an existing one starts with `cp machines/laptop.toml machines/new.toml`.

**The mapping is also membership**: a program a machine doesn't map is simply
not part of that machine's loadout — converge skips it, `status` doesn't
observe it, and `diff` shows `-` for that machine. That's how the same
manifest serves machines with different subsets.

This is strict by design — `install` refuses to run (before executing anything)
when:

- the machine has no `machines/<name>.toml` config file at all,
- an **explicitly requested** program has no mapping for this machine, or a
  mapped program's **dependency** is unmapped,
- a mapped entry names a known package manager (`brew`/`dnf`/`apt`/`pacman`)
  whose binary **isn't actually installed** on the machine (probed with
  `command -v`; e.g. `dnf` mapped on an Arch box). Custom keys like
  `script-fedora` have no binary to check and are always accepted.

```console
$ loadout setup-new-machine --dry-run
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

Fragments can be nested in **subfolders to any depth** — the folder structure
is purely organizational (merge order is by full path, and error messages name
the full path):

```
manifest.d/
├── 00_installers.toml
├── dev/
│   ├── editors.toml
│   └── toolchain.toml
└── apps/office.toml
```

Fragments use exactly the same syntax as the manifest and are merged into it
before validation, so cross-file references (a program in one fragment
depending on a program in another, `via` using an installer defined in a
different fragment, a machine file mapping them) all work. Rules: `[meta]` may
only appear in the root `manifest.toml`, machine configs
may not appear in fragments (they live in `machines/`), and defining the same
program, script, template, or installer twice is an error naming the
offending file — splitting never silently overrides anything.

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

- **Scripts run only on machines that opt in.** Each machine's
  `machines/<name>.toml` lists its scripts as a top-level array — one entry
  per script, arguments inline after the name:

  ```toml
  scripts = [
    "dotfiles",              # opted in, no arguments
    "setup-ssh fedora",      # rest of the entry becomes $1, $2… in the script AND its check
  ]

  [pm]
  # ... (keep `scripts` above any table header — TOML puts later top-level
  #      keys inside the preceding table)
  ```

  A script no machine opts into runs nowhere; `run <name>` on a machine that
  hasn't opted in is an error naming the fix. Arguments are only valid for
  `file` scripts (validated at manifest load, as are unknown names and
  duplicates). This mirrors the program mapping: every behavior a machine
  gets is declared in its machine file.
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
2. Every program **this machine maps** had its `version.command` run
   (concurrently, 8 at a time) and the regex applied. Statuses:
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

### 6. Set the machine up: `setup-new-machine`

```console
$ loadout setup-new-machine
Checking current state...

Plan for laptop:
  = git       2.55.0
  = ripgrep   15.1.0
  + rustup    [script] curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  ~ dotfiles  script

Proceed? [y/N] y

==> installing rustup
info: downloading installer        ← live output; sudo prompts work
...

==> ran script dotfiles (exit 0)

Updating state...
Done: 1/1 programs installed, 1 scripts run.
```

Plan legend (aligned as a name/detail table): `+` will install, with the
machine's mapped install key in brackets before the command · `=` already
installed, showing its version · `~` script that will run. There is no
"not installable" state — an unmapped program is an error that aborts the plan
(see [the mapping rules](#3-map-each-machine-to-its-install-commands)).

The rules:

- **`install`** (no names) = converge this machine's loadout: every missing
  **mapped** program, then every opted-in script (in `after` order, `check`
  gates respected).
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
$ loadout setup-new-machine --dry-run        # print the plan, do nothing
$ loadout setup-new-machine --yes            # skip the confirmation (for automation)
$ loadout setup-new-machine --skip-scripts   # programs only
$ loadout setup-new-machine ripgrep bat      # specific programs (+ their deps)
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

### 9. Ask the remotes for updates: `outdated`

Installers can declare a third mechanic besides `install`/`check`: an
**`outdated`** pattern — a command that asks the remote source (the dnf
repos, brew's API, flathub) what version it offers for `{pkg}`, printing just
the candidate (nothing when current). The shared `regex` extracts it:

```toml
[installers.dnf]
outdated = "dnf -q --cacheonly check-update {pkg} | awk 'NF>=3 {print $2}'"

[installers.brew]
outdated = "HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --verbose {pkg} | grep '^{pkg} ' | awk '{print $NF}'"

[installers.flatpak]
outdated = "flatpak --user remote-info --cached flathub {pkg}"   # regex grabs Version:
```

`loadout outdated` then asks, concurrently, for every program *this machine*
maps and has installed — each through its own mapped installer's oracle:

```console
$ loadout outdated
Checking 45 programs against their remote sources...

  kitty            0.47.1     -> 0.48.2    [dnf]
  slack            4.51.180   -> 4.51.191  [dnf]
  tpack            2.0.4      -> 2.0.5     [brew-cask]
  yq               4.53.3     -> 4.53.6    [brew]

4 update(s) available. `loadout setup-new-machine` won't upgrade — use the package manager, then `loadout status`.
(3 installed programs have no outdated oracle: asdf, jumpkwapp, ngrok)
```

The exit code of the oracle is ignored on purpose (`dnf check-update` exits
100 exactly when updates exist) — only the extracted candidate matters, and a
candidate equal to the installed version means up to date. Variants can
override `outdated` per program like any other field; programs whose variant
resolves no oracle (script installs) are listed as unchecked rather than
guessed at.

### 10. See what script checks are missing: `check`

`status` tells you a script is `pending`; `check` tells you **why**. It runs
this machine's opted-in script checks and relays each failing check's output —
so checks that print what's missing (the two-mode list-script pattern) become
a structured report:

```console
$ loadout check
  chezmoi-init           done
  asdf-tools             done
  asdf-default-packages  pending
                           missing: nodejs 16.20.0 npm firebase-tools
                           missing: nodejs 18.16.0 npm firebase-tools
  setup-completions      done

1 pending — converge with: loadout maintain  (or loadout run <name>)
```

Exits 1 when anything is pending (like `diff` on drift). Name scripts to
check just those: `loadout check asdf-default-packages`. Read-only — it never
runs the scripts themselves and never writes state. Running the fix is the
next command's job.

### 11. Run maintenance interactively: `maintain`

`maintain` is the hands-on counterpart to `check`: pick which of this
machine's scripts to run, then watch them run. It opens a picker listing
every opted-in script (all unselected); `space` toggles, `a`/`n` select
all/none, and `enter` runs only what you picked — one at a time, each
script's output streaming live into a collapsible box under its row (the
accordion collapses when the next script starts), with a ticking elapsed
counter for quiet stretches. `esc` cancels a stuck script.

Selecting a script means you want it run, so there is no check gate on the
way in — but after each script finishes, its `check` (when it has one) reruns
and has the final word: `done` when it now passes, `pending` when it still
fails. Check-less scripts report their exit code (`done`/`failed`). Results
are recorded to this machine's state file, like `loadout run`.

When the run finishes, move the cursor onto any row and press `enter` to open
its **full** log and scroll through it (`↑/↓`, `PgUp`/`PgDn`) — the live view
only tails, but everything is kept. Every log records the command, its
output, and the exit code. Scripts that would need a sudo password are
refused up front (run `sudo -v` first), same as the dashboard. `maintain` is
TTY-only; for scripting use `loadout run <name>` (execute) or `loadout check`
(report).

### 12. Compare your fleet: `diff`

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

### 13. The dashboard: bare `loadout` (TUI)

Run `loadout` with no arguments in a real terminal (or `loadout
tui` with options) and you get an interactive dashboard instead of help text —
the same program × machine matrix as `diff`, live:

```
 loadout v0.2.0 │ machine laptop │ repo ~/machines │ tracking 2 machines

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

The dashboard picks a dark (Tokyo Night) or light palette at startup by
asking the terminal for its background color (OSC 11), falling back to the
`COLORFGBG` hint — unknown means dark — and `t` flips it any time. Colors are semantic: in-sync versions calm green,
drift amber, `missing`/`failed` red, structure dim.

Lists longer than the terminal scroll in a viewport that keeps the selection
centered: the panel title shows the position (`programs 31/88`) and dim
`↑ N more` / `↓ N more` indicators mark what's off-screen. The window follows
the terminal's live height (polled from the TTY; 24-row fallback when it
can't be read).

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
| `t` | Toggle dark/light theme (starts on the detected terminal theme) |
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
  `loadout setup-new-machine` in the CLI where prompts work normally.
- Command output appears in the log when each step *finishes* (not streamed
  live); the status line shows a spinner plus the latest log line meanwhile.
- Bare `loadout` reads `LOADOUT_REPO`/`LOADOUT_MACHINE`;
  use `loadout --repo ... tui` to pass flags.

### 14. Multiple machines in practice

On a new machine:

```console
$ git clone git@github.com:you/machines.git ~/machines
$ export LOADOUT_REPO=~/machines     # put in your shell profile
$ loadout setup-new-machine --yes && loadout sync
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

### 15. Global options

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

### 16. The state file

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

### 17. Version compatibility between the repo and the binary

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

**Old repos keep working on new binaries.** From 0.2.0 on, the manifest format
only evolves additively (new optional fields), so a repo stays parseable by
every later loadout. (0.2.0 itself was the one breaking change: install values
became variant tables backed by `[installers.*]`; 0.1-era repos need their
`install` entries converted.) State files carry a `schemaVersion` and
`toolVersion`; a state file
written by a *newer* loadout than yours is skipped with a warning
(`state/vps.json was written by a newer loadout … upgrade loadout to see this
machine`) rather than misread — and state is disposable observation anyway:
any machine can regenerate its own file with one `status`.

---

## Installing

On a brand-new machine, one line — no sudo, no dependencies beyond `curl`:

```console
$ curl -fsSL https://raw.githubusercontent.com/josemiguelo/loadout/master/install.sh | sh
```

`install.sh` detects the platform (including Rosetta on Apple Silicon),
downloads the latest release tarball, sanity-runs the binary, and installs it
to `~/.local/bin/loadout` — then prints the bootstrap steps (clone your config
repo, write `machines/<hostname>.toml`, `loadout setup-new-machine`). Pin a version with
`LOADOUT_VERSION=v0.2.0`, or change the destination with
`LOADOUT_INSTALL_DIR`.

Tagged releases ship prebuilt binaries for **linux-x64**, **macos-arm64**, and
**macos-x64** (built by the GitHub Actions release workflow); manual install
is just:

```console
$ tar xzf loadout-v0.2.0-linux-x64.tar.gz
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
$ ./gradlew :core:linuxX64Test     # 93 unit tests (parsing, diffing, engines — no real processes)
$ ./gradlew :app:linuxX64Test      # 15 TUI-model tests (key reducers, viewport, theme)
$ ./integration/run-tests.sh       # 34 black-box tests driving the real binary
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
