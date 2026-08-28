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

## Commands

| | Command | What it does |
|---|---|---|
| **observe** | `status` | This machine vs its loadout: every check re-asked, drift explained, state file written |
| | `explain [names]` | Any program/script exactly as the engine resolves it (default: everything) |
| | `outdated` | Ask the remotes (dnf/brew/flathub/…, one batch call each) what newer versions exist — the tool itself and any custom `[outdated.*]` sources included |
| | `diff` | The fleet side by side; exit 1 on drift (cron/CI-friendly) |
| **converge** | `setup-new-machine` | The whole loadout: every missing program, then the setup scripts |
| | `install <programs>` | Just those programs, dependencies first |
| | `run <scripts>` | Just those scripts (check-gated; `--force` overrides) |
| | `maintain` | Interactive picker over the maintenance scripts, live-streamed logs, checks as verdicts |
| **fleet** | `sync` | Pull, refresh state, commit *only this machine's state file*, push |
| | `upgrade` | Update the loadout binary itself — needs no repo, works even under a version-floor refusal |
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
macs). CI runs units + integration on Linux and macOS; a `v*` tag builds,
strips, and attaches release tarballs for linux-x64 / macos-arm64 /
macos-x64 — which is what the install one-liner and `loadout upgrade` serve.

Stack: [Clikt](https://github.com/ajalt/clikt) ·
[ktoml](https://github.com/orchestr7/ktoml) · kotlinx-serialization ·
[kommand](https://github.com/kgit2/kommand) ·
[Okio](https://square.github.io/okio/) ·
[Mosaic](https://github.com/JakeWharton/mosaic) (the maintain screen).

Known limits: unix-like only · dependency edges have no version constraints
· linux-arm64 builds but isn't released.
