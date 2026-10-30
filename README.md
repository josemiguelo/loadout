# loadout

Every machine carries a **loadout**: the programs it's equipped with, how
each one gets installed, and the maintenance steps that keep it healthy.
loadout makes it explicit: **declared** once in a shared git repo,
**converged** on every machine, **observed** continuously, and **compared**
across the fleet.

One static binary (Go, no runtime dependencies) that shells out to your
package managers and `git`. Linux and macOS. You write the manifests in
HCL; `loadout compile` turns them into a committed lock file, which every
other command reads.

```console
$ curl -fsSL https://raw.githubusercontent.com/josemiguelo/loadout/master/install.sh | sh
```

## How it thinks

- **You declare intent** in HCL: programs with their install mechanics,
  scripts with idempotency checks, and an explicit per-machine list of what
  each one installs and runs. Everything refers to everything else by name
  (`program.ripgrep`), and a typo in a name doesn't compile: the error
  names the file, line and column. Machines share small *profiles*; a
  standard machine is one line
  (`machine "laptop" { extends = [profile.macos, profile.work] }`).
- **One repo, laid out the way you choose.** `loadout.hcl` at its root
  holds the `repo` block, whose `sources` globs name the other manifest
  files. A tool's file can sit beside its dotfiles
  (`loadouts/.config/tmux/.tmux.loadout.hcl` next to `tmux.conf`), and
  every path in it is relative to its folder. `init
  --configs` lays a repo out that way: everything in `loadouts/`, each
  tool where its files land, and what lands outside your home (system
  packages, hardware) in `loadouts/.etc/<concern>/`.
- **Your dotfiles are part of the loadout.** With `configs = …` in the `repo` block, the
  repo holds chezmoi's source: `status` shows each config as applied or
  drifted, `diff` compares them across machines, `apply` writes them, and
  `sync` applies them before publishing this machine's state.
- **A private repo can build on a public one.** A child repo names its
  parent in its `repo` block (`parent { name = …, path = … }`) and uses the parent's
  programs, scripts and profiles by name, adding its own machines,
  programs and dotfiles; nothing of it is ever written into the parent. A
  work laptop's employer-specific setup stays out of your public dotfiles.
- **Checks are the truth.** Every piece of a loadout has a re-askable check
  (`rpm -q kitty`, `chezmoi verify`, your own script). Converging means
  making the checks pass; observing means asking them again.
- **Intent and observation never mix.** You author the manifest; each
  machine writes only its own `machines/state/<machine>.json`. Machines share state
  through plain git: no server, works offline.
- **Explicit over implicit.** No package-manager auto-detection, no
  fallbacks, no heuristics. Errors beat guesses, and the error carries the
  fix.
- **Mechanics ship with the tool; intent lives in your repo.** dnf, apt,
  pacman, omarchy, omarchy-aur, brew, brew-cask and flatpak are built in,
  so `install_via = [dnf]` works in an empty repo. `loadout installers` shows
  them, and an installer of your own with the same name replaces one.

## Commands

| | Command | What it does |
|---|---|---|
| **start here** | `loadout` | The home screen: every subject (programs, scripts, configs, remote, fleet) with its verdict, its list beside it. Tick rows, press enter, confirm: the command runs in a panel inside the screen, where sudo and prompts are answered (`ctrl+]` back to the dashboard, Ctrl-C stops it). `i` explains a row, `/` filters, ctrl+p lists every command, ctrl+g every key; r/S/U/C re-check, sync, self-upgrade, set up; `t` switches dark/light. A pipe gets help instead |
| **observe** | `status` | This machine vs its loadout: every check re-asked, drift explained, state file written |
| | `explain [names]` | Programs, scripts or configs exactly as the engine resolves them (default: every program and script) |
| | `installers [name]` | The install mechanisms available here, built-in and your own |
| | `outdated` | What newer versions exist (dnf/brew/flathub/…, one batch call each), the tool itself and custom `outdated` sources included |
| | `diff` | The fleet side by side; exit 1 on drift (cron/CI-friendly) |
| **converge** | `setup-new-machine` | The whole loadout: every missing program, then the setup scripts |
| | `install <programs>` | Just those programs, dependencies first (`--all` = every program this machine maps, no scripts) |
| | `upgrade <installers>` | Newer versions, a whole mechanism at a time (`upgrade dnf brew`, `--all`), never a single package; `--item <source>/<name>` updates one item of a custom `outdated` source |
| | `run <scripts>` | Just those scripts (check-gated; `--all` = every script this machine opts into, `--force` runs them anyway) |
| | `apply [configs]` | Write the repo's configs here through chezmoi (default: all); stops on files edited on this machine unless `--force` |
| **fleet** | `sync` | Pull, apply configs, refresh state, commit *only this machine's state file*, push; upgrades loadout first when the pulled repo needs a newer one, and ends naming what's left to install or run |
| | `self-upgrade` | Replace the loadout binary; needs no repo, works under a version-floor refusal |
| | `compile` | Turn the repo's HCL manifests into `loadout.lock.json`, which every other command reads; warns about what no machine uses, and about `transitional` scripts every machine has done |
| | `init` | Scaffold a new config repo (`loadout.hcl` and a few example files); `--configs` holds your dotfiles too; `--parent <path>` makes a child repo of a compiled one |

## Quickstart

```console
$ loadout init ~/loadouts && cd ~/loadouts
$ $EDITOR programs/ machines/               # declare programs; say what this machine installs
$ loadout compile                            # writes loadout.lock.json (commit it)
$ loadout status                             # observe
$ loadout setup-new-machine                  # converge
$ loadout sync                               # publish (after adding a git remote)
```

```hcl
# programs/cli.loadout.hcl
program "ripgrep" {
  description = "fast grep"
  install_via = [dnf, pacman, brew]
}

# machines/machines.loadout.hcl
machine "laptop" {
  via "dnf" {
    install = [program.ripgrep]
  }
}
```

## Learn more

- **[Writing your manifest](../../wiki/Writing-Your-Manifest)**: from a
  three-line loadout to installers, variants, scripts and profiles.
- **[Repo layout](../../wiki/Repo-Layout)**: `loadout.hcl`, manifest
  files beside their dotfiles, machines, profiles, the lock and configs.
- **[A day with loadout](../../wiki/A-Day-With-Loadout)**: the whole loop in
  practice: observing drift, maintaining, adding gear, new-machine day.
- **[Concepts](../../wiki/Home)**: the three truths and the design stance.
- **[josemiguelo/.dotfiles](https://github.com/josemiguelo/.dotfiles)**: the
  author's live config repo, dotfiles included; every documented pattern
  links into it.

## Building from source

Requires Go (the version in `go.mod`); nothing else.

```console
$ go build -o build/loadout ./cmd/loadout
$ ./build/loadout --help

$ go vet ./... && go test ./...                    # unit tests
$ ./integration/run-tests.sh [binary] [pattern]    # black-box suite (default build/loadout; pattern = only t/*pattern*.sh)
```

Targets: linux-x64, linux-arm64, macos-arm64, macos-x64, all
cross-compiled from one machine. A `v*` tag builds and attaches a release
tarball for each (the binary alone), which the install one-liner and
`loadout self-upgrade` download.

Stack: [cobra](https://github.com/spf13/cobra) ·
[HCL](https://github.com/hashicorp/hcl) ·
[Bubble Tea](https://github.com/charmbracelet/bubbletea),
[Lip Gloss](https://github.com/charmbracelet/lipgloss) and
[Bubbles](https://github.com/charmbracelet/bubbles) (the home screen, in
[Crush](https://github.com/charmbracelet/crush)'s style and Charmtone colours;
its run panel is a pseudo-terminal read through
[x/vt](https://github.com/charmbracelet/x/tree/main/vt)).

Known limits: unix-like only · dependency edges have no version
constraints.
