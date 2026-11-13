# loadout

Every machine carries a **loadout**: the programs it's equipped with, how
each one gets installed, and the maintenance steps that keep it healthy.
loadout makes it explicit: **declared** once in a shared git repo,
**converged** on every machine, **observed** continuously, and **compared**
across the fleet.

One static binary (Go) that shells out to your package managers and
`git`. Linux and macOS. You write the manifests in TypeScript; `loadout
compile` runs them with the bun built into loadout (nothing to install)
and turns them into a committed lock file, which every other command
reads.

```console
$ curl -fsSL https://raw.githubusercontent.com/josemiguelo/loadout/master/install.sh | sh
```

## How it thinks

- **You declare intent** in TypeScript: programs with their install
  mechanics, scripts with idempotency checks, and an explicit per-machine
  list of what each one installs and runs. Every declaration is a typed
  reference other files import (`ripgrep`), so a typo in a name is an
  error in your editor, and go to definition finds it; the language's own
  mistakes name the file, line and column. Machines share small
  *profiles*; a standard machine is one line
  (`machine("laptop", { extends: [macos, work] })`).
- **One repo, laid out the way you choose.** `loadout.ts` at its root
  includes the other manifests (`include("loadouts/**/*.loadout.ts")`)
  and ends with `repo({ … })`. A tool's file can sit beside its dotfiles
  (`loadouts/.config/tmux/.tmux.loadout.ts` next to `tmux.conf`), and
  every path in it is relative to its folder. `init
  --configs` lays a repo out that way: everything in `loadouts/`, each
  tool where its files land, and what lands outside your home (system
  packages, hardware) in `loadouts/.etc/<concern>/`.
- **Your dotfiles are part of the loadout.** With `configs: …` in `repo()`, the
  repo holds chezmoi's source: `status` shows each config as applied or
  drifted, `diff` compares them across machines, `apply` writes them, and
  `sync` applies them before publishing this machine's state.
- **Scripts in TypeScript, on a bare machine.** loadout is a bun: every
  command it runs finds `bun` first on PATH, and that bun is loadout
  itself, so a `#!/usr/bin/env bun` script works from the first step of a
  new machine, before anything is installed. Your own bun, if any, stays
  yours. `loadout bun --version` says which bun that is; a new loadout
  brings a new bun.
- **A private repo can build on a public one.** A child repo names its
  parent in `repo({ parent: { name, path } })` and imports the parent's
  programs, scripts and profiles from its checkout, adding its own machines,
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
  so `install: [dnf]` works in an empty repo. `loadout installers` shows
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
| **converge** | `setup-new-machine` | The whole loadout: every missing program, then the setup scripts; what's marked `later` (slow, optional) comes after all of it (`--skip-later` stops before) |
| | `install <programs>` | Just those programs, dependencies first (`--all` = every program this machine maps, no scripts) |
| | `upgrade <installers>` | Newer versions, a whole mechanism at a time (`upgrade dnf brew`, `--all`), never a single package; `--item <source>/<name>` updates one item of a custom `outdated` source |
| | `run <scripts>` | Just those scripts (check-gated; `--all` = every script this machine opts into, `--force` runs them anyway) |
| | `apply [configs]` | Write the repo's configs here through chezmoi (default: all); stops on files edited on this machine unless `--force` |
| **fleet** | `sync` | Pull, apply configs, refresh state, commit *only this machine's state file*, push; upgrades loadout first when the pulled repo needs a newer one, and ends naming what's left to install or run |
| | `self-upgrade` | Replace the loadout binary; needs no repo, works under a version-floor refusal |
| | `compile` | Run the repo's TypeScript manifests into `loadout.lock.json`, which every other command reads; warns about what no machine uses, and about `transitional` scripts every machine has done |
| | `init` | Scaffold a new config repo (`loadout.ts`, a tsconfig and a few example files); `--configs` holds your dotfiles too; `--parent <path>` makes a child repo of a compiled one |
| | `bun [args…]` | The bun built into loadout, the one scripts run with: `loadout bun --version`, `loadout bun run x.ts`; needs no repo |

## Quickstart

```console
$ loadout init ~/loadouts && cd ~/loadouts
$ $EDITOR programs/ machines/               # declare programs; say what this machine installs
$ loadout compile                            # writes loadout.lock.json (commit it)
$ loadout status                             # observe
$ loadout setup-new-machine                  # converge
$ loadout sync                               # publish (after adding a git remote)
```

```ts
// programs/cli.loadout.ts
import { brew, dnf, pacman, program } from "loadout";

export const ripgrep = program("ripgrep", {
  description: "fast grep",
  install: [dnf, pacman, brew],
});

// machines/machines.loadout.ts
import { dnf, machine, via } from "loadout";
import { ripgrep } from "../programs/cli.loadout.ts";

machine("laptop", { install: [via(dnf, [ripgrep])] });
```

## Editor support

Scripts can be TypeScript too: `import { main } from "loadout/script"`
gives a managed script loadout's `check`/`install` protocol, `oracle()` an
outdated source's rows and `update`, and `env` the variables loadout sets
(`loadout.script.ts`, which compile writes beside the manifests' SDK).

Manifests are plain TypeScript, so any editor with TypeScript support
works: completion of every setting (with the SDK's docs on hover),
references imported from the files that declare them, go to definition,
and a typo or a wrong type underlined as you type. `loadout compile`
writes the SDK beside your manifests (`loadout.sdk.ts`, which tsconfig's
`paths` maps to `"loadout"`); `bun install` gives the editor bun's own
types. See [Writing your manifest](../../wiki/Writing-Your-Manifest).

## Learn more

- **[Writing your manifest](../../wiki/Writing-Your-Manifest)**: from a
  three-line loadout to installers, variants, scripts and profiles.
- **[Repo layout](../../wiki/Repo-Layout)**: `loadout.ts`, manifest
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
[Bun](https://bun.sh) (the manifests) ·
[Bubble Tea](https://github.com/charmbracelet/bubbletea),
[Lip Gloss](https://github.com/charmbracelet/lipgloss) and
[Bubbles](https://github.com/charmbracelet/bubbles) (the home screen, in
[Crush](https://github.com/charmbracelet/crush)'s style and Charmtone colours;
its run panel is a pseudo-terminal read through
[x/vt](https://github.com/charmbracelet/x/tree/main/vt)).

Known limits: unix-like only · dependency edges have no version
constraints.
