# AGENTS.md — loadout

`loadout` is one static Go binary that sets up unix-like machines from a shared git "config repo" and tracks installed versions across them. Users declare installers, programs (install variants over those installers) and scripts in HCL manifests; each machine picks its variants and scripts. `loadout compile` turns the manifests into the committed `loadout.lock.json`, which every other command reads. A CLI plus ONE Bubble Tea screen, the home screen (bare `loadout`), which runs every action as the matching subcommand and owns no domain logic. It was once `post-installer`: never reintroduce that name in code.

## Build, run, test

```sh
go build -o build/loadout ./cmd/loadout              # the binary
go vet ./...
go test ./...                                        # unit tests (one package: ./internal/hclconf/...)
./integration/run-tests.sh [path-to-binary] [pattern] # black-box suite; builds nothing, default build/loadout
```

All suites pass before work is called done. Manual target: the user's live config repo (`$LOADOUT_REPO`, `~/.local/share/chezmoi`). `status`, `diff` and `--dry-run` against it are fine; installing or removing packages or pushing git needs the user's OK. Opening the home screen writes the machine's state file there.

## Design contract

Explicit user decisions, numbered (code, the wiki and `.dotfiles` cite them as "contract N"). Read `docs/agents/contract.md` before changing what any of them touches:

1. No package-manager auto-detection: the machine and its profiles choose every variant.
2. Mapping is membership with strict fail-fast resolution; profiles flatten, then a machine overrides; `data` is a typed schema.
3. Intent (manifests) and observation (state) never mix; the lock and chezmoi data are generated.
4. A script is exactly one of `file` or `run`; every path is relative to its declaring file.
5. Every manifest command runs via `sh -c` in its declaring file's folder, with the `LOADOUT_*` environment.
6. Programs before scripts, topological, ties by name; sequential.
7. Status is observation: checks re-run every refresh; a check that couldn't run is `unknown`, not missing.
8. State files are this machine's only and change only when their content does.
9. Errors are one `error: ` line; every refusal implements `model.Refusal`.
10. Product code loads manifests only through `loader.LoadRepo` and `ForMachine`.
11. No templates: only `locals` and user functions over plain values.
12. Scripts are opt-in per machine.
13. Installers own mechanics; variants refine them. Declared, never inferred.
14. Versioning: deliberate breaks only, announced in release notes; outputs stay additive.
15. Converge installs what's missing; `upgrade` moves a whole mechanism.
16. The repo's shape is declared by `loadout.hcl`'s globs, never assumed.
17. Configs are chezmoi's, observed like everything else.
18. A child repo inherits a parent; nothing flows back.

## More, when the task needs it

- Package layout and dependency direction, byte-identical outputs: `docs/agents/architecture.md`.
- The HCL front end, compile's warnings, the language server, HCL gotchas and house style: `docs/agents/hcl.md`.
- CLI presentation (theme, terminal queries, boxed tables, spinner, the converge pipeline): `docs/agents/cli-output.md`.
- The home screen, and driving it without a human: `docs/agents/home-screen.md`.
- Unit, integration and PTY test conventions: `docs/agents/testing.md`.
- CI, releases, the version line and `install.sh`: `docs/agents/release.md`.
- Declaring a program in a config repo: `docs/agents/manifest-recipe.md`.

## Writing this knowledge down

Update this knowledge in the same change that makes it true. Add an entry only when it stops a future agent from reverting a deliberate decision (the contract) or rediscovering a costly failure; everything else belongs in the commit message. Put it in the file of its topic, state what is true now, and write a past incident as the rule it produced. Style everywhere (comments, docs, README, wiki): succinct, direct, present tense, no important detail dropped.

## Working agreements

- **Everything works on Linux AND macOS** (the user runs both), the Go and the shell, here and in config repos. macOS ships BSD tools: no `\|` in a BRE (`sed -nE` with `|`); `cat -A`, bare `sed -i`, `timeout` and GNU `readlink -f` are absent or differ; `script` takes its arguments the other way round. BSD failures tend to be silent. Test here and reason about the other platform before claiming done.
- **A change to the manifest language is a change to the language server too**, in the same commit: every new or changed attribute, block or value kind goes in `hclconf/schema.go`'s `shapeSpecs` (completion; `schema_test` and `lsp/complete_test` pin the lists), and every new compile error names what it's about as `<kind> '<name>'`, the step to fix first, so the editor marks that declaration instead of line 1 (`lsp/workspace.go`'s `placeError`; errors from the decoder carry their own position). Add an `internal/lsp` test that shows it in place. Details in `docs/agents/hcl.md`.
- **Close your tmux test windows**: a real-terminal check is `tmux new-window -d -n ldtest` + `send-keys` + `capture-pane`, then `tmux kill-window -t ldtest`.
- After any phase or feature, end with a **"Try it"** section: exact commands, binary path, expected output.
- **Docs split**: README is the front door (concept, command table, quickstart, links); the GitHub wiki holds the guides, cloned at `../loadout.wiki`, a separate repo with its own commits. A change isn't done until the wiki, README and these files have been re-read against it: grep them for the screen text, keys and output the change touches. The wiki links into josemiguelo/.dotfiles, so renames there can break it.
- **Wiki voice**: friendly, direct, concise, for a user getting work done; an example wherever one fits. Reasons true only because of how loadout is built belong here, not there.
- **User-visible strings speak to the user**: say what to do or what happened, never why the implementation needs it ("a step needs your sudo password", not "sudo's cache is cold"). Cache, stamp, mechanism, oracle, transaction are contributor words.
- The user prefers explicit over implicit at every design fork: no auto-detection, no fallbacks, no heuristics; errors over guesses. A question ("is this ok?") means assess first and propose, don't jump to code.
