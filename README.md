# loadout

Every machine carries a **loadout**: the programs it's equipped with, how
each one gets installed, and the maintenance steps that keep it healthy.
loadout makes it explicit: **declared** once in a shared git repo,
**converged** on every machine, **observed** continuously, and **compared**
across the fleet.

One binary that shells out to your package managers and `git`. Linux
(glibc) and macOS. You write the manifests in TypeScript; `loadout
compile` runs them with the bun built into loadout (nothing to install)
and turns them into a committed lock file, which every other command
reads.

```console
$ curl -fsSL https://raw.githubusercontent.com/josemiguelo/loadout/master/install.sh | sh
```

It installs `~/.local/bin/loadout` and nothing else. The binary is about
70 MB (90 MB on Linux): bun is inside it, and it is also the bun your
TypeScript scripts run with.

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
  repo holds chezmoi's source: `machine status` shows each config as applied or
  drifted, `machine diff` compares them across machines, `config apply` writes them, and
  `machine sync` applies them before publishing this machine's state. Keep them
  with their tools if you like: with `dotfiles: { tools: "loadouts/*", … }`
  each tool is one folder (its manifest, its scripts, `home/` for `$HOME`,
  `root/` for `/`), compile builds chezmoi's sources from them, files outside
  `$HOME` are applied as root, and `loadout chezmoi` runs chezmoi with the two
  kept in step.
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
  so `canBeInstalled: [withDnf]` works in an empty repo. `loadout installer list` shows
  them, and an installer of your own with the same name replaces one.

## Commands

| | Command | What it does |
|---|---|---|
| **start here** | `loadout` | The home screen: every subject (programs, scripts, configs, remote, fleet) with its verdict, its list beside it. Tick rows, press enter, confirm: the command runs in a panel inside the screen, where sudo and prompts are answered (`ctrl+]` back to the dashboard, Ctrl-C stops it). `i` explains a row, `/` filters, ctrl+p lists every command, ctrl+g every key; r/S/U/C re-check, sync, self upgrade, set up; `t` switches dark/light. A pipe gets help instead |
| **machine** | `machine status` | This machine vs its loadout: every check re-asked, drift explained, state file written |
| | `machine new` | Set it up: every missing program, then the setup scripts; what's marked `canWait` (slow, optional) comes after all of it (`--skip-later` stops before) |
| | `machine outdated` | What newer versions exist (dnf/brew/flathub/…, one batch call each), loadout itself and custom `outdated` sources included |
| | `machine sync` | Pull, apply configs, refresh state, commit *only this machine's state file*, push; upgrades loadout first when the pulled repo needs a newer one, and ends naming what's left to install or run |
| | `machine diff` | This machine beside the others, every machine's state side by side; exit 1 on drift (cron/CI-friendly) |
| | `machine explain` | The profiles it extends, what it installs and runs, its merged data |
| **program** | `program install <programs>` | Just those programs, dependencies first (`--all` = every program this machine maps, no scripts) |
| | `program explain [names]` | Programs exactly as the engine resolves them (default: all) |
| **script** | `script run <scripts>` | Just those scripts (check-gated; `--all` = every script this machine opts into, `--force` runs them anyway) |
| | `script check <scripts>` | Are those scripts done? Asks their checks with this machine's options, runs nothing, writes nothing; exit 1 unless all are (`--all` = every script this machine opts into) |
| | `script explain [names]` | Scripts exactly as the engine resolves them (default: all) |
| **config** | `config apply [configs]` | Write the repo's configs here through chezmoi (default: all; a tool's `/` files as root, `/<tool>`); stops on files edited on this machine unless `--force` |
| | `config explain [names]` | Each config's files and last verdict (default: all) |
| **installer** | `installer list [name]` | The install mechanisms available here, built-in and your own |
| | `installer upgrade <installers>` | Newer versions, a whole mechanism at a time (`installer upgrade dnf brew`, `--all`), never a single package; `--item <source>/<name>` updates one item of a custom `outdated` source |
| **repo** | `repo compile` | Run the repo's TypeScript manifests into `loadout.lock.json`, which every other command reads; warns about what no machine uses, and about `deleteOnceDone` scripts every machine has done |
| | `repo init` | Scaffold a new config repo (`loadout.ts`, a tsconfig and a few example files); `--configs` holds your dotfiles too; `--parent <path>` makes a child repo of a compiled one |
| **self** | `self upgrade` | Replace the loadout binary; needs no repo, works under a version-floor refusal |
| **tools** | `chezmoi <command> [args…]` | chezmoi over this repo's configs, from any checkout; with tool folders, a path outside `$HOME` goes to the `/` configs, and what `re-add`, `add --tool <tool>`, `merge`, `chattr` and `forget` write lands in the tool's folder |
| | `bun [args…]` | The bun built into loadout, the one scripts run with: `loadout bun --version`, `loadout bun run x.ts`; needs no repo |

Every command is a noun and its verb; only `chezmoi` and `bun`, other tools' command lines passed
through, stand alone.

On a terminal, the commands that run steps (`machine new`, `program install`, `script run`,
`installer upgrade`) show them live: one line per finished step, the running one with a spinner
and its last lines (a prompt it asks shows there, and what you type goes to it), a failed one's
whole output kept. Every step's whole output also goes to the run's log, in
`~/.local/state/loadout/runs/`, which the run names when it ends. `LOADOUT_PLAIN=1` prints every
step's output as it comes instead.

## Quickstart

```console
$ loadout repo init ~/loadouts && cd ~/loadouts
$ $EDITOR programs/ machines/               # declare programs; say what this machine installs
$ loadout repo compile                            # writes loadout.lock.json (commit it)
$ loadout machine status                             # observe
$ loadout machine new                  # converge
$ loadout machine sync                               # publish (after adding a git remote)
```

```ts
// programs/cli.loadout.ts
import { program, withBrew, withDnf, withPacman } from "loadout";

export const ripgrep = program("ripgrep", {
  description: "fast grep",
  canBeInstalled: [withDnf, withPacman, withBrew],
});

// machines/machines.loadout.ts
import { machine, withDnf } from "loadout";
import { ripgrep } from "../programs/cli.loadout.ts";

machine("laptop", { install: [withDnf(ripgrep)] });
```

## Editor support

Scripts can be TypeScript too: a module's `check` and `install` get the
options the machine calls it with, checked by its types, and an `updates`
module's `listOutdated` and `update` say what's behind. `"loadout/script"` gives them
helpers, and `env` the variables loadout sets
(both SDKs are built into loadout, and so are their types).

Manifests are plain TypeScript, so any editor with TypeScript support
works: completion of every setting (with the SDK's docs on hover),
references imported from the files that declare them, go to definition,
and a typo or a wrong type underlined as you type. The SDKs run inside
loadout, which writes their types where your editor finds them with no
setup (`node_modules/@types/loadout`, out of git) whenever it reads the
repo, so they're never older than your loadout; `bun
install` gives it bun's own types. See [Writing your manifest](../../wiki/Writing-Your-Manifest).

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

Requires [bun](https://bun.sh), the version in `package.json`'s
`packageManager`; nothing else.

```console
$ bun install --frozen-lockfile
$ bun run build                                     # build/loadout
$ ./build/loadout --help

$ bunx tsc --noEmit -p . && bun test src            # types and unit tests
$ ./integration/run-tests.sh [binary] [pattern]    # black-box suite (default build/loadout; pattern = only t/*pattern*.sh)
```

Targets: linux-x64, linux-arm64, macos-arm64, macos-x64, all
cross-compiled from one machine (`bun build --compile --target=…`). A `v*` tag builds and attaches a release
tarball for each (the binary alone), which the install one-liner and
`loadout self upgrade` download.

Stack: TypeScript on [Bun](https://bun.sh), compiled to one executable
per target · the home screen draws itself (in
[Crush](https://github.com/charmbracelet/crush)'s style and Charmtone
colours); its run panel is a pseudo-terminal (`Bun.Terminal`) read through
[@xterm/headless](https://www.npmjs.com/package/@xterm/headless).

Known limits: unix-like only · dependency edges have no version
constraints.
