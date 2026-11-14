# TypeScript manifests: the SDK and compile

- **Manifests are TypeScript, run by bun; every other command reads JSON.**
  `loadout compile` is compile/compile.ts's `compile` under a spinner: it writes the
  SDKs' types (`node_modules/@types/loadout`, generated from
  `src/compile/sdk/`) into the repo, runs `bun run loadout.ts` there with nothing of the caller's
  environment but PATH and HOME (and `LOADOUT_COMPILE=1`), reads the draft
  the SDK's `repo()` prints, assembles it, and writes the lock (and, with
  configs, the chezmoi data and partial) only when changed. On success it
  prints `✔ wrote loadout.lock.json` and its warnings; on failure one
  `error: ` line. Nothing is written when anything is wrong (the SDKs'
  types are written first: they're the compiling binary's, whatever
  happens next).
- **Which bun**: loadout itself, through the `bun` wrapper in
  `$XDG_DATA_HOME/loadout/bin` (core/bun), in a cleared environment whose
  PATH starts with that folder; with `$LOADOUT_BUN` (a bun binary, for
  tests and developers) the wrapper execs that instead.
- **The SDKs are the binary's**: `"loadout"` and `"loadout/script"` are
  virtual modules the wrapper's preload registers from the sources embedded
  in loadout; no SDK code is in a repo, so a repo always runs with the SDK
  of the loadout that compiles it. The repo gets only their types, in
  `node_modules/@types/loadout`, out of git: `src/compile/sdk/loadout.d.ts`, which `bun run sdk-types`
  (compile/sdktypes.ts) emits from the sources with the pinned tsc, doc
  comments included, wrapped in one `declare module` block per name. Edit
  the sources, then regenerate: sdktypes.test.ts fails on a stale file. A `repo()` setting that doesn't exist is
  refused where it's declared.
- **The draft is the lock's own shapes** (`model.encodeDraft`/
  `DecodeDraft`): the manifest before assembly (machines unflattened,
  built-ins not merged), the profiles, the installers' extra requires, and
  what only compile reads: `spares`, `transitional`, `parent`. The SDK
  desugars exactly as the lock reads: `managedBy` on a script is `file` +
  `check: "file:x check \"$@\""`, on a variant `command: "file:x
  install"`, `check: "file:x check"`, `present` unless a `regex` reads a
  version; `installedBy` and `runScript()`/`file()` are the `file:`
  prefix; a version check gets `VERSION_REGEX` by default (installers
  always, as the built-ins); check and run lists are joined with `&&`, one
  holding `||` or `;` grouped in `{ …; }` (a single string too).
- **References are values.** `program()`, `script()`, `installer()`,
  `profile()` return `{ kind, name }`; files import them from the file that
  declared them (`export const x = …`), so a misspelt name is a type error
  and go-to-definition works. Lists of references are flattened wherever
  they're read (`Many<T>`), so a shared const of programs sits in any list.
  A declaration's origin is the folder of the file that called the SDK
  (the first stack frame with a path: the SDK's own frames name its
  module), from the repo root.
- **One SDK state per process, on `globalThis`**: a child repo imports
  its parent's modules, which import the same SDK module; both see one set
  of declarations. The SDK records only declarations
  whose file is in the repo (`ownFile`); the parent's are references, and
  compile gets the parent's draft by running the parent as a parent
  (`LOADOUT_AS_PARENT`: every origin `parent:`).
- **Sources are the import graph**: the entry and every file `include()`d
  (Bun.Glob, dot files included, path order), and every repo file they
  reach through static imports (`Bun.Transpiler.scanImports`), helpers and
  the data schema included; never `"loadout"`/`"loadout/script"` (the
  binary's) nor anything in node_modules. The lock hashes them; any edit makes it
  stale.
- **The language's own rules are the SDK's** (`fail()`), checked where
  they're declared and reported as `<file>:<line>,<col>: <message>` (the
  caller's stack frame), one line, which compile prints as `error: …`:
  a name declared twice (naming the first), a program with no way to
  install it, two variants of one key, settings that can't go together
  (`version`/`present`/`managedBy`, `command`/`installedBy`/`managedBy`,
  `file`/`managedBy`, `check`/`managedBy`, `setupOnly`/`maintainOnly`,
  `outdated`/`updatesManagedBy`), `upgrade` without `outdated`, a `regex`
  without `version`, an empty `later`/`spare` reason, a transitional script
  without a check (or on a variant), a machine marked spare, a machine
  installing a program twice, one with several variants without
  `variant()`, a script run twice. Assembly's refusals (cycles, a variant a
  machine doesn't have, data against the schema) come after, as before.
- **Gotchas.** Within one file a list can't use a declaration further down
  (the temporal dead zone): declare what a list uses first. Across files,
  import cycles have the same problem; keep machines and profiles importing
  tools, never the reverse. A name that's a JavaScript reserved word or an
  SDK export gets a suffix when exported (`tryProgram`, `omarchyProfile`).
  `include()` awaits imports, so `loadout.ts` uses top-level await before
  `repo()`, which must come last.
- **House style** (the dotfiles, `init`'s scaffolds, the docs): the
  name is the first argument (`program("ripgrep", …)`), the export its
  camelCase (`export const gitDelta = program("git-delta", …)`);
  `description` first; `install` lists the variants in the order they're
  tried to read (installers as they are, `via()` when one needs a setting,
  `custom()`); a machine's `install` groups programs by installer with
  `via(installer, [...])`; a comment about an entry sits above it; a
  blank line between declarations.
- **Compile warns about what no machine uses** (compile/unused.ts): a
  profile no machine extends, a program none installs (dependencies
  count), a script or script variant none runs, a repo installer nothing
  in use goes through. A way to install a program that no machine picks is
  reported only when some machine uses that installer for OTHER programs
  ("machine 'm' installs other programs via 'dnf', but not fzf"):
  `install` lists every true claim, so a variant through an installer
  nobody uses is the recipe, not a mistake. Warnings, never refusals: the
  lock is written either way. `spare: "reason"` marks one kept on purpose
  (on the profile, program, variant, script variant, installer); a spare
  profile's contents count as used, and a spare mark on something used is
  itself a warning, so marks can't go stale. A machine can't be spare.
- **Transitional scripts end themselves through compile**
  (`transitionalWarnings`): `transitional: true` marks a script that only
  exists until every machine has done it. It's a compile-time mark like
  `spare`, carried in the draft and never in the lock. Compile reads
  `<state>/<machine>.json` for every machine that runs it and warns
  "delete it" once all of them report it `done`; a machine without a state
  file hasn't done it. Done means its check passes (contract 7), so a
  transitional script needs a check (on itself, or on every variant).
- **`later: "why"` is in the lock, unlike `spare`**: setup-new-machine
  reads only the lock, so the reason is written on the program or script
  (dropped when unset). A blank reason is refused, and so is a core step
  that waits on a later one (contract 6).
- **Scripts have an SDK too: `"loadout/script"`**
  (`src/compile/sdk/loadout.script.ts`), the binary's like the manifests'
  one, typed in the same `node_modules/@types/loadout`. It holds loadout's protocols for a
  script in TypeScript, so the script speaks them as the binary that runs
  it does: `main(check, install)` (a managed script, contract 12), `run(step)`
  (a `file` with its check inline), `oracle({ rows, update })` (an outdated
  source: `Row`s printed by `formatRow`, `update <item>`), `programOracle({
  latest, update })` (a program's own `updatesManagedBy`), `env` (the
  LOADOUT_* variables, typed), `clonesBehind`/`fastForward` (clones that
  track their remote, as rows), and the Bun Shell helpers (`$`, `has`,
  `out`, `ok`, `read`, `sudoWrite`, `mainCheckoutPath`, `reason`…). What's
  only one repo's (its brew prefix, its tools' modules) stays in the repo.
  A script needn't use it: contract 4's executables are any language.
- **The editor is TypeScript's own**: completion, hover (the SDK's doc
  comments), go to definition and type errors come from the TypeScript
  language server over the repo's tsconfig (loadout's types from
  `node_modules/@types/loadout`, bun's from `bun install`). loadout has no
  language server of its own; compile's refusals reach the editor only by
  running compile.
