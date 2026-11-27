# Adding programs to a config repo — the recipe

The wiki's "Writing your manifest" is the user-facing long form. Match
top-down, first fit wins:

1. Standard package → `canBeInstalled: [withDnf, withBrew, …]` listing ONLY installers
   where the claim is true (it's unverified; a false entry is a mappable
   lie). The installer usually ships with loadout (`loadout installer list`;
   the SDK exports it); declare one only to add a mechanism or replace a
   built-in.
2. Different package id → that installer configured where it's named:
   `withBrewCask({ packageName: "gcloud-cli" })`, `withFlatpak({ packageName:
   "md.obsidian.Obsidian" })`.
3. Special install command, same mechanism → `<installer>({ command:
   … })`, so check/probe derive. Key by what it IS: a cask is
   `withBrewCask({ … })`, not `withBrew({ … })`.
4. Prerequisite step (tap/repo/remote) → its own program + `dependsOn`,
   never `&&`-chained into another program's command; on the variant when
   only that mechanism needs it. When EVERY program of a mechanism needs it
   (a pm's config, the flathub remote, a COPR's dnf-plugins-core), the
   installer `requires` it (`withFlatpak.needs(flathubRemote)`). When
   that step installs the installer's own tool (flatpak on a distro
   without it, Homebrew), its variant also has `addsToPath: { flatpak: true }`
   (plus `at: …` when it lands off PATH), or the plan refuses the missing
   probe before anything runs.
5. Repo-script install that lands in a pm's database → `<pm>({
   module: () => import("./x.ts") })`; check/probe derive; override `versionRegex` for odd
   version formats. When several programs need the SAME shaped script (rpm
   repo + key + install, a brew tap), make it an installer with `installerParams:
   [...]` and one `runFile(…)` pattern; the variants carry only their
   values (`withBrewTap({ tap: "owner/tap" })`).
6. Truth not in a package db (dnf groups, virtual provides) → override the
   check (`versionCommand: "rpm -q --whatprovides …"`, a managing script, or
   `isInstalled: "…"` when there's no version), keep the rest derived.
7. No pm at all → `withCustomSteps({ installCommand: … })` (or `module`) + a
   program-level `versionCommand: …`; `searchPath: ["$HOME/.local/bin"]` when it lands
   off a fresh shell's PATH.
8. Nothing to "have" (dotfiles, services) → a `script()` + check, run per
   machine. In TypeScript it's `module: () => import("./x.ts")`, exporting
   `check(options)` and `install(options)`; in anything else, `run` and
   `check` with `runFile("x.sh")`.
   A step done differently per platform is an option of its module, or two
   scripts.

Cross-cutting: no `||` chains or trailing pipes in checks; versions are
the mapped pm's truth (rpm's version, not the binary's self-report:
expected, not a bug); a repo script (`runFile`, `module`) for every script file (existence checked at compile and
load); plain values over abstraction (contract 11): a const for a shared
list, a function for repeated arguments, never one that generates
declarations. Every declaration is `export const x = program(…)`, so other
files import it. Verify loop: `program explain` (or `script explain`) → install it in a machine or
profile → `loadout repo compile` (and the editor's type check) →
`machine new --dry-run` → `machine status`.

Where the check lives: loadout never trusts "it ran once"; everything
converges against a re-askable check, declared where the truth lives via
the resolution chain (variant check → installer check → program
version). Program-install scripts are install-only: pm-keyed ones get the
pm-database check derived (recipe 5), pm-less ones fall back to version
(recipe 7). Only when neither holds the truth (dnf groups, recipe 6, and
every script, recipe 8) is there a hand-written check: an inline one-liner
or a managing script's `check` mode. A script file needs a check
mode only if it IS the truth's only oracle.
