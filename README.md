# loadout

Every machine you own carries a **loadout** — the programs it's equipped
with, how each one gets installed, and the maintenance steps that keep it
healthy. On most machines that loadout is implicit: shell history, memory,
and drift. loadout makes it explicit — **declared** once in a shared git
repo, **converged** on every machine, **observed** continuously, and
**compared** across the fleet.

One native binary (Kotlin/Native — no JVM, no runtime dependencies) that
shells out to your package managers and `git`. Linux and macOS.

```console
$ curl -fsSL https://raw.githubusercontent.com/josemiguelo/loadout/master/install.sh | sh
```

## How it thinks

- **You declare intent** in TOML: programs with their install mechanics,
  scripts with idempotency checks, and an explicit per-machine mapping of
  who carries what. Machines of the same OS share a *base loadout*; a
  standard-issue machine is a one-line file (`extends = "macos"`).
- **Checks are the truth.** loadout never trusts "it ran once" — every piece
  of a loadout has a re-askable check (`rpm -q kitty`, `chezmoi verify`,
  your own script), convergence means making the checks pass, and
  observation means asking them again.
- **Intent and observation never mix.** You author the manifest; each
  machine writes only its own `state/<machine>.json`. Machines share state
  through plain git — no server, works offline.
- **Explicit over implicit.** No package-manager auto-detection, no
  fallbacks, no heuristics. Errors beat guesses, and the error message
  carries the fix.
- **Mechanics ship with the tool; intent lives in your repo.** dnf, apt,
  pacman, brew, brew-cask and flatpak are built in, so `via = ["dnf"]`
  works in an empty repo — `loadout installers` shows what they mean, your
  own `[installers.<name>]` replaces one, and `--eject` hands you the lot.

## Commands

| | Command | What it does |
|---|---|---|
| **start here** | `loadout` | The home screen: what needs working on; `l` opens a row's detail, and inside it enter runs what you ticked — pending scripts, outdated mechanisms — in a floating pane; r/S/U/C re-check, sync, upgrade or set up this machine (a pipe gets help instead) |
| **observe** | `status` | This machine vs its loadout: every check re-asked, drift explained, state file written |
| | `explain [names]` | Any program/script exactly as the engine resolves it (default: everything) |
| | `installers [name]` | The install mechanisms available here — loadout's built-ins plus your own (`--eject` copies the built-ins into your repo) |
| | `outdated` | Ask the remotes (dnf/brew/flathub/…, one batch call each) what newer versions exist — the tool itself and any custom `[outdated.*]` sources included (a source with an `upgrade` command can update its items one by one from the home screen) |
| | `diff` | The fleet side by side; exit 1 on drift (cron/CI-friendly) |
| **converge** | `setup-new-machine` | The whole loadout: every missing program, then the setup scripts |
| | `install <programs>` | Just those programs, dependencies first (`--all` = every program this machine maps, no scripts) |
| | `upgrade <installers>` | Move installed programs to newer versions, a whole mechanism at a time (`upgrade dnf brew`, or `--all` for every mechanism this machine maps) — never a single package |
| | `run <scripts>` | Just those scripts (check-gated; `--all` = every script this machine opts into, `--pending` = the ones status didn't find done, `--force` overrides) |
| **fleet** | `sync` | Pull, refresh state, commit *only this machine's state file*, push |
| | `self-upgrade` | Replace the loadout binary — needs no repo, works even under a version-floor refusal |
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

- **[Writing your manifest](../../wiki/Writing-Your-Manifest)** — start with
  a three-line loadout, grow through installers, variants, scripts, and
  per-OS bases.
- **[A day with loadout](../../wiki/A-Day-With-Loadout)** — the whole loop in
  practice: observing drift, maintaining, adding gear, new-machine day.
- **[Concepts](../../wiki/Home)** — the three truths and the design stance.
- **[josemiguelo/loadouts](https://github.com/josemiguelo/loadouts)** — the
  author's live config repo; every documented pattern links into it.

## Building from source

Requires a JDK (21 works); the Gradle wrapper fetches the rest.

```console
$ ./gradlew :app:linkDebugExecutableLinuxX64
$ ./app/build/bin/linuxX64/debugExecutable/loadout.kexe --help

$ ./gradlew :core:linuxX64Test :app:linuxX64Test   # unit tests
$ ./integration/run-tests.sh                       # black-box suite (real binary)
```

Targets: linux-x64, linux-arm64, macos-arm64, macos-x64 (macs build on
macs). A `v*` tag builds, strips, and attaches release tarballs for
linux-x64 / macos-arm64 / macos-x64 — which is what the install one-liner
and `loadout self-upgrade` serve. The CI workflow (units + integration on Linux
and macOS) is written but not wired up — see TODO.

Stack: [Clikt](https://github.com/ajalt/clikt) ·
[ktoml](https://github.com/orchestr7/ktoml) · kotlinx-serialization ·
[kommand](https://github.com/kgit2/kommand) ·
[Okio](https://square.github.io/okio/) ·
[Mosaic](https://github.com/JakeWharton/mosaic) (the home screen).

Known limits: unix-like only · dependency edges have no version constraints
· linux-arm64 builds but isn't released.

## TODO

- **Wire up CI.** `.github/workflows/ci.yml` triggers on `push` to `main`
  and on pull requests; the default branch is `master` and there have been
  no PRs, so it has never run — every release so far was cut on locally run
  suites plus `release.yml`, which builds and packages but runs no tests.
  Fix is `branches: [master]`; expect the first real run to surface
  something, especially on the macOS job that has never executed.
