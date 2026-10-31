# HCL manifests: the compiler and the language server

- **Manifests are HCL, compiled by the binary; every other command reads
  JSON.** `loadout compile` is `hclconf.Compile` under a spinner: on
  success it prints `✔ wrote loadout.lock.json` and its warnings; on
  failure every diagnostic, one `error: ` line each. Nothing is written
  when anything is wrong.
- **HCL decodes in two passes; references are identities.** Pass one
  collects every block's label in every file (the namespace); pass two
  evaluates attributes against it. A reference (`program.x`,
  `script.x`, `profile.x`, `installer.x`, a bare installer name like
  `brew-cask`, `local.x`) is a value carrying only its kind and name (plus
  `variant`/`args`), so the order of files and declarations never matters
  and nothing initialises anything. An unknown name is HCL's own "Unsupported
  attribute; This object does not have an attribute named …". Locals may
  use locals (cycles are errors); user functions (`function "x" { params
  = [a] result = … }`) work in any file. Lists of references are flattened,
  so `install = [program.curl, local.everyday_cli]` works.
- **Diagnostics name the file from the repo root**: `error:
  programs/x.loadout.hcl:2,13: <summary>; <detail>`, every one of them,
  one line each (`DiagnosticsError`); a parent's files by their path.
  The language's own rules (a name declared twice, an install without
  saying how) are refused together after HCL's, as "Invalid manifest:".
- **Shell text in HCL**: `$HOME` passes through as written, but `${…}` is
  HCL interpolation and `%{…}` a template directive, so a shell `${VAR}`
  is written `$${VAR}` and a literal `%{` is `%%{`. A heredoc (`<<-EOT`)
  keeps its trailing newline in the value: wrap it in `chomp(…)` when the
  newline matters. Prefer repo scripts (`managed_by`, `run_script`) for
  anything longer than a line.
- **A name starting with a digit isn't a traversal**: `program.1password`
  is a syntax error; write `program["1password"]`. Dashes are fine
  (`program.setup-brew`).
- **One attribute per body, one argument per single-line block.** Setting
  an attribute twice is HCL's "Attribute redefined", so a machine has one
  `install` and one `run` (repeat `via` blocks, not attributes). A
  single-line block holds at most one argument (`via "pacman" { pkg =
  "github-cli" }`); two need the multi-line form.
- **HCL house style** (the dotfiles port, `init`'s scaffold and the docs):
  the label is the name (`program "ripgrep"`, `machine "<hostname>"`);
  `description` is the body's first line, on its own; a program reads one
  way: `install_via` (one line, `install_via = [brew, omarchy]`) when no
  variant needs a setting, else every variant a block, an empty `via
  "omarchy" {}` for one that needs none, never the list beside blocks; a
  one-attribute block may stay on one
  line (`via "pacman" { pkg = "github-cli" }`); `=` aligned within a group
  of attributes (hclfmt's style); a list too long for a line opens `[` and
  closes `]` on their own lines, one entry per line with a trailing comma
  (a profile's long lists of plain names may group a few related ones per
  line); a comment about an entry sits above it; a blank line between
  declarations.
- **Compile warns about what no machine uses** (hclconf/unused.go): a
  profile no machine extends, a program none installs (dependencies
  count), a script or script variant none runs, a repo installer nothing
  in use goes through. A way to install a program that no machine picks
  is reported only when some machine uses that installer for OTHER
  programs ("machine 'm' installs other programs via 'dnf', but not fzf"):
  `install_via` lists every true claim, so a variant through an installer
  nobody uses (a scaffold's ripgrep via apt, a COPR for a future Fedora
  machine) is the recipe, not a mistake. Warnings, never refusals: the lock is written either way.
  `spare = "reason"` marks one kept on purpose (on the profile, program,
  variant, script variant, installer); a spare profile's contents count as
  used, and a spare mark on something used is itself a warning, so marks
  can't go stale. A machine can't be spare.
- **Transitional scripts end themselves through compile**
  (`TransitionalWarnings`): `transitional = true` marks a script that only
  exists until every machine has done it (a cleanup after a change). It is
  a compile-time mark like `spare`, kept by the front end and never in the
  lock, so binaries are untouched. Compile reads `<state>/<machine>.json`
  for every machine that runs it and warns "delete it" once all of them
  report it `done`; a machine without a state file hasn't done it. Done
  means its check passes (contract 7), so a transitional script needs a
  check (on itself, or on every variant), and the mark goes on the script,
  never a variant. This is loadout's answer to migrations: no ledger of
  what ran, since a fresh machine's check already passes; history-only
  steps (nothing on disk can tell) stay manual instructions.
- **A profile's long list can live beside its scripts**: a user function
  in the scripts' file (`function "omarchy_bar" { params = [] result =
  [args(script.omarchy-bar, …), …] }`), called from the profile's `run`
  (`omarchy_bar()`). It returns only references, so where it lives
  changes nothing in the lock.

- **`loadout lsp` guesses; compile never does.** The no-heuristics,
  no-fallbacks rule is compile's and the CLI's; the language server is
  held to being useful while you type. So `Check` reads the entry file's
  globs from what HCL recovered of a half-typed buffer (compile refuses
  it), a file that doesn't parse still names its declarations, an error
  without a position is placed on the first `<kind> '<name>'` it names,
  and completion reads the cursor's context from a loose scan of the text
  before it. What completion offers comes from `hclconf.ShapeOf`, built
  from the decoder's own specs: a new attribute or block needs its value
  in schema.go's `shapeSpecs` (schema_test fails until it has one), and
  nothing else to be completed. Keep those out of compile's path: `readRepo`'s `tolerant` is
  false there.
