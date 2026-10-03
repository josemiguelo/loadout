# loadout

Every machine carries a **loadout**: the programs it's equipped with, how
each one gets installed, and the maintenance steps that keep it healthy.
loadout makes it explicit: **declared** once in a shared git repo,
**converged** on every machine, **observed** continuously, and **compared**
across the fleet.

One native binary (Kotlin/Native, no JVM, no runtime dependencies) that
shells out to your package managers and `git`. Linux and macOS.

```console
$ curl -fsSL https://raw.githubusercontent.com/josemiguelo/loadout/master/install.sh | sh
```

## How it thinks

- **You declare intent** in TOML: programs with their install mechanics,
  scripts with idempotency checks, and an explicit per-machine mapping of
  who carries what, grouped by tool. Machines share small *profiles*
  (`profiles/macos.toml`, `profiles/work.toml`); a standard machine is a
  one-line file (`extends = ["macos", "work"]`).
- **Checks are the truth.** Every piece of a loadout has a re-askable check
  (`rpm -q kitty`, `chezmoi verify`, your own script). Converging means
  making the checks pass; observing means asking them again.
- **Intent and observation never mix.** You author the manifest; each
  machine writes only its own `state/<machine>.json`. Machines share state
  through plain git: no server, works offline.
- **Explicit over implicit.** No package-manager auto-detection, no
  fallbacks, no heuristics. Errors beat guesses, and the error carries the
  fix.
- **Mechanics ship with the tool; intent lives in your repo.** dnf, apt,
  pacman, omarchy, omarchy-aur, brew, brew-cask and flatpak are built in,
  so `via = ["dnf"]` works in an empty repo. `loadout installers` shows them, your own
  `[installers.<name>]` replaces one, and `--eject` copies them all into
  your repo.

## Commands

| | Command | What it does |
|---|---|---|
| **start here** | `loadout` | The home screen: what needs work. `l` opens a row; enter runs what you ticked (missing programs, pending scripts, outdated mechanisms) full-window, then the screen comes back (`v` shows a command's whole output); quitting leaves your terminal as it was. r/S/U/C re-check, sync, self-upgrade, set up. A pipe gets help instead |
| **observe** | `status` | This machine vs its loadout: every check re-asked, drift explained, state file written |
| | `explain [names]` | Programs/scripts exactly as the engine resolves them (default: all) |
| | `installers [name]` | The install mechanisms available here, built-in and your own (`--eject` copies the built-ins into your repo) |
| | `outdated` | What newer versions exist (dnf/brew/flathub/…, one batch call each), the tool itself and custom `[outdated.*]` sources included |
| | `diff` | The fleet side by side; exit 1 on drift (cron/CI-friendly) |
| **converge** | `setup-new-machine` | The whole loadout: every missing program, then the setup scripts |
| | `install <programs>` | Just those programs, dependencies first (`--all` = every program this machine maps, no scripts) |
| | `upgrade <installers>` | Newer versions, a whole mechanism at a time (`upgrade dnf brew`, `--all`), never a single package; `--item <source>/<name>` updates one item of a custom `[outdated.*]` source |
| | `run <scripts>` | Just those scripts (check-gated; `--all` = every script this machine opts into, `--force` runs them anyway) |
| **fleet** | `sync` | Pull, refresh state, commit *only this machine's state file*, push |
| | `self-upgrade` | Replace the loadout binary; needs no repo, works under a version-floor refusal |
| | `init` | Scaffold a new config repo |

## Quickstart

```console
$ loadout init ~/loadouts && cd ~/loadouts
$ $EDITOR manifest.toml manifest.d/          # declare programs and scripts
$ $EDITOR machines/$(hostname).toml          # map what this machine carries
$ loadout status                             # observe
$ loadout setup-new-machine                  # converge
$ loadout sync                               # publish (after adding a git remote)
```

## Learn more

- **[Writing your manifest](../../wiki/Writing-Your-Manifest)**: from a
  three-line loadout to installers, variants, scripts and per-OS bases.
- **[A day with loadout](../../wiki/A-Day-With-Loadout)**: the whole loop in
  practice: observing drift, maintaining, adding gear, new-machine day.
- **[Concepts](../../wiki/Home)**: the three truths and the design stance.
- **[josemiguelo/loadouts](https://github.com/josemiguelo/loadouts)**: the
  author's live config repo; every documented pattern links into it.

## Building from source

Requires a JDK (21 works); the Gradle wrapper fetches the rest.

```console
$ ./gradlew :app:linkDebugExecutableLinuxX64
$ ./app/build/bin/linuxX64/debugExecutable/loadout.kexe --help

$ ./gradlew :core:linuxX64Test :app:linuxX64Test   # unit tests
$ ./integration/run-tests.sh [pattern]             # black-box suite (real binary; pattern = only t/*pattern*.sh)
```

Targets: linux-x64, linux-arm64, macos-arm64, macos-x64 (macs build on
macs). A `v*` tag builds, strips and attaches release tarballs for
linux-x64 / macos-arm64 / macos-x64, which the install one-liner and
`loadout self-upgrade` download.

Stack: [Clikt](https://github.com/ajalt/clikt) ·
[ktoml](https://github.com/orchestr7/ktoml) · kotlinx-serialization ·
[kommand](https://github.com/kgit2/kommand) ·
[Okio](https://square.github.io/okio/) ·
[Mosaic](https://github.com/JakeWharton/mosaic) (the home screen).

Known limits: unix-like only · dependency edges have no version
constraints · linux-arm64 builds but isn't released.

## TODO

- **Wire up CI.** `.github/workflows/ci.yml` triggers on pushes to `main`
  and on pull requests, but the default branch is `master`, so it never
  runs; `release.yml` packages without testing. Fix: `branches: [master]`.
  The macOS job has never executed, so expect its first run to surface
  something.
