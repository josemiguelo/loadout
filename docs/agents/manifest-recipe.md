# Adding programs to a config repo — the recipe

The wiki's "Writing your manifest" is the user-facing long form. Match
top-down, first fit wins:

1. Standard package → `install_via = […]` listing ONLY installers where
   the claim is true (`install_via` is unverified; a false entry is a
   mappable lie). The named installer usually ships with loadout (`loadout
   installers`); declare one only to add a mechanism or replace a
   built-in.
2. Different package id → that installer's block with a pkg:
   `via "brew-cask" { pkg = "gcloud-cli" }`, `via "flatpak" { pkg =
   "md.obsidian.Obsidian" }`.
3. Special install command, same mechanism → that installer's block with
   `command = …`, so check/probe derive. Key by what it IS: a cask is
   `via "brew-cask" { … }`, not `via "brew" { … }`.
4. Prerequisite step (tap/repo/remote) → its own program + `depends_on`,
   never `&&`-chained into another program's command; on the variant when
   only that mechanism needs it. When EVERY program of a mechanism needs it
   (a pm's config, the flathub remote, a COPR's dnf-plugins-core), the
   installer `requires` it (`requires "flatpak" { programs =
   [program.flathub-remote] }`). When that step installs the installer's
   own tool (flatpak on a distro without it, Homebrew), its variant also
   has `provides "flatpak" {}` (plus `at = …` when it lands off PATH), or
   the plan refuses the missing probe before anything runs.
5. Repo-script install that lands in a pm's database → that pm's block
   with `installed_by = "…"`; check/probe derive; override `regex` for odd
   version formats. When several programs need the SAME shaped script (rpm
   repo + key + install, a brew tap), make it an installer with `params =
   [...]` and one `run_script(…)` pattern; the variants carry only their
   values (`via "brew-tap" { params = { tap = "owner/tap" } }`).
6. Truth not in a package db (dnf groups, virtual provides) → override the
   check (`version = "rpm -q --whatprovides …"`, a managing script, or
   `present = "…"` when there's no version), keep the rest derived.
7. No pm at all → `custom { installed_by = "x.sh" }` (or `command = …`) + a
   program-level `version = …`; `path = ["$HOME/.local/bin"]` when it lands
   off a fresh shell's PATH.
8. Nothing to "have" (dotfiles, services) → a `script` + check, run per
   machine. A *managing script* (`<file>` does the step, `<file> check`
   says whether it's done) is `managed_by = "x.sh"`. A step done
   differently per platform is one script with `variant "arch" { … }`s,
   picked by the machine.

Cross-cutting: once any variant is a block (recipes 2–5), write every
variant as one (`via "brew" {}`), never `install_via` beside them; no
`||` chains or trailing pipes in checks; versions are the mapped pm's truth (rpm's version, not the binary's self-report: expected,
not a bug); a repo script (`run_script`, `installed_by`, `managed_by`) for
every script file (existence checked at compile and load); plain values
over abstraction (contract 11). Verify loop: `explain` →
install it in a machine or profile → `loadout compile` → `setup-new-machine
--dry-run` → `status`.

Where the check lives: loadout never trusts "it ran once"; everything
converges against a re-askable check, declared where the truth lives via
the resolution chain (variant check → installer check → program
version). Program-install scripts are install-only: pm-keyed ones get the
pm-database check derived (recipe 5), pm-less ones fall back to version
(recipe 7). Only when neither holds the truth (dnf groups, recipe 6, and
every script, recipe 8) is there a hand-written check: an inline one-liner
or a managing script's `check` mode. A script file needs a check
mode only if it IS the truth's only oracle.
