# Testing conventions

- Unit tests are bun tests, `<name>.test.ts` beside the code (`bun test
  src`). No real processes: fakeexec's runner (scripted command lines with
  stdout/stderr/exit; an unregistered command exits 127) behind
  `ProcessRunner`. Files are temp directories or `mapFS({...})`
  (assembly's file checks go through a `RepoFS`).
- Core's tests build manifests in code: `coretest.manifestOf((b) => { … })`
  and `coretest.example()`, the shared fixture; assemble's use
  testhelpers.ts. The language's meaning and mistakes are tested end to end
  in the integration suite (TypeScript fixtures through the real compile)
  and in compile.test.ts; assembly on hand-built drafts in assemble, the
  lock reader in core/loader, byte-identical encoding against the
  `testdata/` locks and state files (src/model, src/assemble, src/core/state)
  written by earlier loadouts. tui/style's bytes are pinned by
  `testdata/golden.json`.
- Integration = `integration/run-tests.sh`: black-box, real binary. The
  runner sources `lib.sh` (ok/fail, fixtures, `has_pty`/`pty_run`), then
  every `t/NN-*.sh` in name order, each in its OWN fresh directory: a file
  builds its fixtures (`basic_repo`, `scripts_repo`, `worktree_repo`, or
  inline) and never depends on another file; the numbers only fix the
  order. Fixtures are TypeScript repos: `ts_root <dir> [option…]`
  (tsconfig.json mapping "loadout" to the SDK, and loadout.ts including
  `*.loadout.ts` at the root and in programs/, maintenance/, machines/;
  each option is a line of `repo({…})`; stdin, if any, is
  root.loadout.ts, declarations at the root), `ts_repo <dir>` (the same,
  nothing at the root), `ts_file <path>` (stdin as one fragment, after
  `TS_PRELUDE`, which imports every SDK name: a fixture never imports
  "loadout" itself, only other fragments, by relative path),
  `repo_opt <loadout.ts> '<option>'` (an option added to `repo({…})`:
  `configs: "configs"`), then `compile_repo`, which compiles with the real
  binary. run-tests.sh unsets `LOADOUT_BUN`, so compiles and scripts run with the
  binary under test as bun, as on a user's machine; `t/42-bun.sh` sets it
  per command where a test wants the override. A `manual`
  custom variant with a failing command keeps tests off the host's
  package managers. Add an `ok "..."` test for every user-visible
  behavior change, in the file whose subject it is (new subject = new
  file); run that file with a name pattern while iterating. Never share
  state across files through `$WORK`. Configs tests (`t/55-configs.sh`)
  put a stub `chezmoi` on PATH for each command only (`cz_loadout`: the
  files are sourced into one shell, so an exported PATH would leak),
  answering from files and logging its calls; a real chezmoi would read
  and write the developer's own dotfiles, so "chezmoi missing" is the
  stub's exit 127, never a PATH without it.
- TUI: the model's reducers (`handleKey`, `handleText`, `runExited`,
  `followUp`) and pure builders (`sectionsOf`, `scriptRowsOf`,
  `programRowsOf`, `preselect`, `selectionKey`, `remoteLines`, `listOf`,
  `upgradeItem`) are unit-tested in src/tui (homemodel.test.ts) on a state
  set up by the test; runs go through seams (`runCommand`, `newTerm` with a fake
  terminal, `explain`), and the frame's size is checked in both layouts.
  Rendering is verified manually (ask the user) plus PTY probes.
  `t/70-home-screen.sh` (`has_pty`-guarded, `script`-driven) and
  `t/71-terminal.sh` (plain commands: TTY-gated colour, a terminal that
  never answers the background-colour query) run on BOTH platforms;
  `pty_run` and `screen_run` branch on `uname` (BSD `script` takes the log
  then plain argv; Linux takes `-qec "<command>"` with the log last).
  EVERY home-screen PTY test calls `fake_release_cache` and passes
  `XDG_CACHE_HOME=$FAKE_CACHE`: the screen asks the remotes on open, and an
  unmocked self-version check is seconds of curl before the remote subject
  settles.
  **The home screen is read from its frame dump, never from the raw
  capture**: the renderer (src/tui/renderer.ts) writes only changed rows,
  so text is split by cursor moves. `screen_run <name> <args>` runs it under `script`
  at `PTY_SIZE` (default 140x40; `stty` inside the pty) with
  `LOADOUT_SCREEN_DUMP=<name>.screen` (the current frame, plain, written
  atomically after every changed render; undocumented for users) and the
  raw output in `<name>.log` (for what isn't text: the alternate screen,
  OSC 11 background colours, a password never echoed, what is printed
  after the screen ends). **Key feeders wait on the frame, never on fixed
  sleeps**: `wait_settled <name>` (every subject in the sidebar shows its
  count; a busy one shows none, and the refresh starts before the first
  frame), `wait_frame <name> <ERE>…` (all in ONE frame) and `wait_done
  <name>` (the run panel's verdict). A frame passes by, so a feeder copies
  the one it waited for (`cp <name>.screen <name>.x`) and the test asserts
  on the copy; `frame_seen`/`fail_frame` read the current one. `pty_run`,
  `wait_screen` and `seen` stay for plain commands on a PTY (raw capture,
  escapes stripped). `fake_sudo` prompts on /dev/tty like the real one.
  Send ESC with a short sleep after it: ESC and the next key together read
  as alt+key. Short sleeps between keys that act synchronously are fine.
