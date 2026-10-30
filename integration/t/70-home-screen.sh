# The home screen, driven on a pseudo-terminal. Bubble Tea's renderer only
# writes the cells that change, so the tests read the frame the screen dumps
# as plain text (screen_run / wait_frame / frame_seen, lib.sh). Key feeders
# wait on the frame, never on a fixed sleep: a key on a busy row is refused,
# a key before raw mode is lost, and how long the rows take to answer
# depends on the machine.
#
# Keys: the sidebar has the focus first; l goes into the list, 1-4 pick a
# subject (programs, scripts, remote, fleet without configs). \035 is
# ctrl+], \020 ctrl+p, \007 ctrl+g, \003 ctrl+c.

basic_repo repo
# Every PTY test here stubs the self-version cache: the screen asks the
# remotes the moment it opens, and an unstubbed check is seconds of curl
# before the remote row can settle.
fake_release_cache
OUT=$("$BIN" --repo repo --machine m1 2>&1)
echo "$OUT" | grep -q "Usage: loadout" || fail "bare loadout without a TTY still prints help"
if has_pty; then
    { wait_settled tui-home; cp tui-home.screen tui-home.first; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-home --repo repo --machine m1
    grep -qE 'Machine ─' tui-home.first || fail_frame tui-home "the sidebar has its Machine section"
    grep -qE 'Programs  ' tui-home.first || fail_frame tui-home "the main pane shows the first subject"
    grep -qE 'Runs ─' tui-home.first || fail_frame tui-home "the sidebar lists this session's runs"
    grep -qE 'ctrl\+p commands' tui-home.first || fail_frame tui-home "the status bar says which keys work"
    grep -qE 'scripts +0/1' tui-home.first || fail_frame tui-home "each subject shows its verdict"
    grep -qa "$(printf '\033')\[?1049h" tui-home.log || fail "the home screen opens on the alternate screen"
    grep -qa "$(printf '\033')\[?1049l" tui-home.log || fail "quitting leaves the alternate screen"
    ok "bare loadout opens the home screen on a TTY, help without one"

    # esc closes; it must never end the session, or a habit of pressing it
    # on the way out of something drops you off the screen. Only q leaves.
    { wait_settled tui-esc; printf '\033'; sleep 0.4; printf '\033'; sleep 0.4; printf '\033'; wait_frame tui-esc 'q quits'
      cp tui-esc.screen tui-esc.after; printf '\003'; sleep 0.4; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-esc --repo repo --machine m1
    grep -q 'nothing to close — q quits' tui-esc.after || fail_frame tui-esc "esc says which key quits"
    grep -q 'Machine ─' tui-esc.after || fail "and the screen is still there"
    ok "esc (and a reflex ctrl+c) never quit the home screen — only q does"
fi

# --- moving: subjects, the inspector, the palette, help --------------------
scripts_repo nrepo
"$BIN" --repo nrepo --machine m1 status >/dev/null
if has_pty; then
    { wait_settled tui-nav
      wait_frame tui-nav '× mytool +missing · via fake' && cp tui-nav.screen tui-nav.programs
      printf 'j'; wait_frame tui-nav 'Scripts  ' && cp tui-nav.screen tui-nav.scripts
      printf '3'; wait_frame tui-nav 'Remote  '
      printf '1'; sleep 0.3; printf 'l'; sleep 0.3; printf 'i'; wait_frame tui-nav 'Inspect .*mytool' 'This machine' && cp tui-nav.screen tui-nav.inspect
      printf '\033'; sleep 0.4; printf '\020'; wait_frame tui-nav 'Commands  '
      printf 'fleet'; sleep 0.3; printf '\r'; wait_frame tui-nav 'Fleet  '
      printf '\007'; wait_frame tui-nav 'Help  ' && cp tui-nav.screen tui-nav.help
      printf '\033'; sleep 0.4; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-nav --repo nrepo --machine m1
    [ -f tui-nav.programs ] || fail_frame tui-nav "the programs list shows each program with its verdict"
    grep -q 'programs  *0/1' tui-nav.programs || fail_frame tui-nav "the sidebar counts what is installed"
    grep -qE '● drifted +pending' tui-nav.scripts || fail_frame tui-nav "moving in the sidebar shows that subject's list"
    grep -qE 'program mytool' tui-nav.inspect || fail_frame tui-nav "i explains the row: $(cat tui-nav.inspect)"
    grep -qE 'install\.fake +echo installed-mytool' tui-nav.inspect || fail "the inspector shows how it installs"
    grep -qE '← m1' tui-nav.inspect || fail "and marks this machine's variant"
    grep -qE 'program +missing' tui-nav.inspect || fail "and this machine's verdict"
    grep -qE 'leave the terminal' tui-nav.help || fail "ctrl+g shows every key"
    ok "the sidebar picks the subject, i inspects a row, ctrl+p runs a command, ctrl+g helps"
fi

# --- the remote tree: a fold mark means "rows are hidden here" -------------
# Two repos with one batch oracle each: one reports nothing outdated, one
# reports a package. A tool that heads no rows hides nothing when folded,
# so only the second may ever show a fold mark.
fake_release_cache
hcl_root orepo <<'HCL'
installer "quiet" {
  probe        = "sh"
  install      = "echo installed-{pkg} > quiet-{pkg}.txt"
  check        = "echo {pkg} 1.0"
  regex        = "([0-9][0-9.]*)"
  outdated_all = "true"
  upgrade      = "echo swept"
}

program "alpha" {
  install_via = [quiet]
}

machine "m1" {
  install = [program.alpha]
}
HCL
hcl_root frepo <<'HCL'
installer "quiet" {
  probe        = "sh"
  install      = "echo installed-{pkg} > quiet-{pkg}.txt"
  check        = "echo {pkg} 1.0"
  regex        = "([0-9][0-9.]*)"
  outdated_all = "echo 'alpha 2.0'"
  upgrade      = "echo swept"
}

program "alpha" {
  install_via = [quiet]
}

machine "m1" {
  install = [program.alpha]
}
HCL
compile_repo orepo
compile_repo frepo
"$BIN" --repo orepo --machine m1 status >/dev/null
"$BIN" --repo frepo --machine m1 status >/dev/null
if has_pty; then
    # 3 shows the remote tree; l goes into it, h folds the group the cursor
    # is in. The tool is named after its probe: sh.
    { wait_settled tui-clean; printf '3'; sleep 0.3; printf 'l'; wait_frame tui-clean '○ sh +up to date' && cp tui-clean.screen tui-clean.tree
      printf 'q'; sleep 1; } | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-clean --repo orepo --machine m1
    [ -f tui-clean.tree ] || fail_frame tui-clean "the remote tree lists a tool with nothing outdated"
    grep -qE '▸|▾' tui-clean.tree && fail_frame tui-clean "a tool that heads no rows must not show a fold mark"
    grep -qE 'remote +up to date' tui-clean.tree || fail "the remote subject says so when nothing is outdated"
    ok "the remote tree never offers to fold a clean tool"

    { wait_settled tui-fold; printf '3'; sleep 0.3; printf 'l'; wait_frame tui-fold '▾ ○ sh +1 update · 1 in your loadout' && cp tui-fold.screen tui-fold.open
      printf 'h'; wait_frame tui-fold '▸ ○ sh' && cp tui-fold.screen tui-fold.shut
      printf 'l'; wait_frame tui-fold '▾ ○ sh'; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-fold --repo frepo --machine m1
    [ -f tui-fold.open ] || fail_frame tui-fold "the remote tree lists the tool's one update"
    grep -qE '↑ alpha' tui-fold.open || fail "with the package under it"
    [ -f tui-fold.shut ] || fail_frame tui-fold "h folds a tool that heads rows, and marks it"
    grep -qE '↑ alpha' tui-fold.shut && fail "a folded tool hides its rows"
    grep -qE 'remote +1 *│' tui-fold.open || fail "the remote subject counts the updates"
    ok "h folds a tool whose rows it hides, l unfolds it"
fi

# --- a run: the command's output in the run panel ---------------------------
scripts_repo srepo
"$BIN" --repo srepo --machine m1 setup-new-machine --yes >/dev/null
rm -f srepo/bootstrap-marker.txt
"$BIN" --repo srepo --machine m1 status >/dev/null
if has_pty; then
    # 2 shows the scripts, l goes into the list, a ticks every script, enter
    # asks, enter runs them in the panel; q quits once it's done.
    { wait_settled tui-scripts; printf '2'; sleep 0.3; printf 'l'; sleep 0.3; printf 'a'; sleep 0.3; printf '\r'
      wait_frame tui-scripts 'These scripts will run' 'Run +Cancel' && cp tui-scripts.screen tui-scripts.ask
      printf '\r'; wait_done tui-scripts; wait_frame tui-scripts '✓ Done' && cp tui-scripts.screen tui-scripts.done
      wait_frame tui-scripts 'esc close' && cp tui-scripts.screen tui-scripts.kept
      printf '\033'; sleep 1; cp tui-scripts.screen tui-scripts.closed
      printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-scripts --repo srepo --machine m1
    [ -f tui-scripts.ask ] || fail_frame tui-scripts "the confirm dialog asks before running scripts"
    grep -qa "bootstrap-only" tui-scripts.ask && fail "the picker must not list setup-only scripts"
    [ -f tui-scripts.done ] || fail_frame tui-scripts "the run ends with a toast"
    grep -qE 'Run .*loadout run drifted healthy --force .*✓ done' tui-scripts.done || fail_frame tui-scripts "the panel names the command and its verdict"
    grep -q "ran drifted (exit 0)" tui-scripts.done || fail_frame tui-scripts "the command's output is in the panel"
    grep -q "still not done: drifted (missing: nodejs 16" tui-scripts.done \
        || fail "run re-checks and names what is still not done, with what its check printed"
    grep -qE '✓ run drifted healthy' tui-scripts.done || fail "the run is in the sidebar's Runs"
    grep -q '"drifted"' srepo/machines/state/m1.json || fail "the run records the scripts in the state file"
    grep -q '"status": "pending"' srepo/machines/state/m1.json || fail "the recorded status comes from the rerun check"
    [ "$(grep -ao "$(printf '\033')\[?1049l" tui-scripts.log | wc -l)" -eq 1 ] \
        || fail "the alternate screen is left only once, when loadout quits"
    ok "ticked scripts run in the run panel, and the screen stays"
    [ -f tui-scripts.kept ] || fail_frame tui-scripts "the finished run keeps the focus, and offers esc to close it"
    grep -qE 'gg/G start/end' tui-scripts.kept || fail_frame tui-scripts "with the run panel's own keys on the help line"
    [ -f tui-scripts.closed ] || fail_frame tui-scripts "esc closes it"
    grep -qE 'Run .*✓ done' tui-scripts.closed && fail_frame tui-scripts "esc right after a run closes its panel"
    grep -qE '✓ run drifted healthy' tui-scripts.closed || fail "a closed run stays in the sidebar's Runs"
    ok "esc closes a finished run's panel, wherever the focus is"

    # A state write that fails must be said out loud, not swallowed.
    chmod 400 srepo/machines/state/m1.json
    { wait_settled tui-nowrite; printf '2'; sleep 0.3; printf 'l'; sleep 0.3; printf 'a'; sleep 0.3; printf '\r'
      wait_frame tui-nowrite 'These scripts will run'; printf '\r'; wait_done tui-nowrite
      wait_frame tui-nowrite '× Error' && cp tui-nowrite.screen tui-nowrite.done; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-nowrite --repo srepo --machine m1
    chmod 600 srepo/machines/state/m1.json
    grep -q "error: " tui-nowrite.done || fail_frame tui-nowrite "a failed state write is said, not swallowed"
    grep -qE '× exit 1' tui-nowrite.done || fail "and the panel says the command failed"
    ok "the run panel says so when the state file can't be written"
fi

# --- the remote tree: a source's item belongs to its source ----------------
# The live repo has a `tpack` tmux plugin AND a `tpack` package. Each
# upgrade writes its own file: only the filesystem can say which one ran.
hcl_root crepo <<'HCL'
installer "quiet" {
  probe        = "sh"
  install      = "echo installed-{pkg} > quiet-{pkg}.txt"
  check        = "echo {pkg} 1.0"
  regex        = "([0-9][0-9.]*)"
  outdated_all = "echo 'tpack 2.0'"
  upgrade      = "echo swept > the-tool-swept.txt"
}

program "tpack" {
  install_via = [quiet]
}

outdated "tmux-plugins" {
  command = "echo 'tpack aaa1111 bbb2222 156 commit(s) behind'"
  upgrade = "echo pulled > pulled-{item}.txt"
}

machine "m1" {
  install = [program.tpack]
}
HCL
compile_repo crepo
"$BIN" --repo crepo --machine m1 status >/dev/null
if has_pty; then
    # jjj walks the tool line, the package under it and the source heading
    # to the source's OWN tpack row: space ticks it, enter asks, enter runs.
    { wait_settled tui-collide; printf '3'; sleep 0.3; printf 'l'; wait_frame tui-collide '156 commit'
      printf 'jjj'; sleep 0.4; printf ' '; sleep 0.3; printf '\r'; wait_frame tui-collide 'These will upgrade'
      printf '\r'; wait_done tui-collide; cp tui-collide.screen tui-collide.done; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-collide --repo crepo --machine m1
    grep -q "upgrading tmux-plugins: tpack" tui-collide.done || fail_frame tui-collide "the panel upgrades the source's item"
    [ -f crepo/pulled-tpack.txt ] || fail "the ticked row upgraded through its own source"
    [ -f crepo/the-tool-swept.txt ] && fail "a source's item must never run the tool's sweep"
    ok "a source's row upgrades through its source, not through a same-named program's tool"

    # ] goes over the rows to the next group's heading: from the tool line
    # straight to the source, whose tick covers its item.
    rm -f crepo/pulled-tpack.txt crepo/the-tool-swept.txt
    { wait_settled tui-jump; printf '3'; sleep 0.3; printf 'l'; wait_frame tui-jump '156 commit'
      printf ']'; sleep 0.4; printf ' '; sleep 0.3; printf '\r'; wait_frame tui-jump 'These will upgrade'
      printf '\r'; wait_done tui-jump; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-jump --repo crepo --machine m1
    [ -f crepo/pulled-tpack.txt ] || fail_frame tui-jump "] landed on the source heading, whose tick covers its item"
    [ -f crepo/the-tool-swept.txt ] && fail "] skips the rows under a heading, it doesn't tick the tool"
    ok "] jumps to the next group's heading, over the rows under it"
fi

# --- sudo asks in the run panel, and is answered there ---------------------
hcl_root irepo <<'HCL'
installer "fake" {
  probe   = "sh"
  install = "sudo sh -c 'echo installed-{pkg} > fake-{pkg}.txt'"
  check   = "test -f fake-{pkg}.txt && echo {pkg} 1.0"
  regex   = "([0-9][0-9.]*)"
}

program "alpha" {
  install_via = [fake]
}
program "beta" {
  install_via = [fake]
}

machine "m1" {
  install = [program.alpha, program.beta]
}
HCL
compile_repo irepo
fake_sudo
"$BIN" --repo irepo --machine m1 status >/dev/null
if has_pty; then
    # l goes into the programs (both missing, both ticked), enter asks,
    # enter installs in the panel; sudo asks there: a wrong password, then
    # the right one, typed into the panel.
    { wait_settled tui-install; printf 'l'; sleep 0.3; printf '\r'; wait_frame tui-install 'These programs will install'
      printf '\r'; wait_frame tui-install '\[sudo\] password for tester'; printf 'nope\r'; wait_frame tui-install 'Sorry, try again'
      printf 'secret\r'; wait_done tui-install; cp tui-install.screen tui-install.done
      wait_frame tui-install 'programs +2/2' && cp tui-install.screen tui-install.after; printf 'q'; sleep 1; } \
        | PATH="$FAKE_SUDO_PATH:$PATH" XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-install --repo irepo --machine m1
    grep -q "2/2 programs installed" tui-install.done || fail_frame tui-install "the right password runs the installs"
    grep -q "Sorry, try again" tui-install.done || fail "a wrong password is refused by sudo, in the panel"
    grep -qa "nope" tui-install.log && fail "the password must never be echoed"
    [ -f irepo/fake-alpha.txt ] && [ -f irepo/fake-beta.txt ] || fail "both ticked programs were installed"
    grep -c '"status": "installed"' irepo/machines/state/m1.json | grep -qx 2 || fail "the re-check recorded both as installed"
    [ -f tui-install.after ] || fail_frame tui-install "the rows follow the run: nothing missing any more"
    ok "the programs list installs in the run panel, where sudo asks for its own password"
fi

# --- sudo called from inside a command, declared ---------------------------
hcl_root hrepo <<'HCL'
installer "hidden" {
  probe      = "sh"
  install    = "sh inner.sh {pkg}"
  check      = "test -f fake-{pkg}.txt && echo {pkg} 1.0"
  regex      = "([0-9][0-9.]*)"
  needs_sudo = true
}

program "gamma" {
  install_via = [hidden]
}

machine "m1" {
  install = [program.gamma]
}
HCL
cat > hrepo/inner.sh <<'SH'
sudo sh -c "echo installed-$1 > fake-$1.txt"
SH
compile_repo hrepo
fake_sudo
"$BIN" --repo hrepo --machine m1 status >/dev/null
OUT=$("$BIN" --repo hrepo --machine m1 explain gamma)
echo "$OUT" | grep -q "sudo.hidden" || fail "explain shows the sudo declaration"
if has_pty; then
    { wait_settled tui-hidden; printf 'l'; sleep 0.3; printf '\r'; wait_frame tui-hidden 'These programs will install'
      printf '\r'; wait_frame tui-hidden 'A step needs your sudo password' '\[sudo\] password for tester'; printf 'secret\r'
      wait_done tui-hidden; printf 'q'; sleep 1; } \
        | PATH="$FAKE_SUDO_PATH:$PATH" XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-hidden --repo hrepo --machine m1
    [ -f hrepo/fake-gamma.txt ] || fail_frame tui-hidden "the install ran once the password was typed"
    ok "a declared sudo inside a command is asked for once, upfront, in the panel"
fi

# --- anything else that asks, like `omarchy update`'s "Reboot?" ------------
# Printed through an escape (\167 = w) so waiting for it can't match text
# the screen drew.
hcl_root arepo <<'HCL'
installer "asks" {
  probe        = "sh"
  install      = "true"
  check        = "echo {pkg} 1.0"
  regex        = "([0-9][0-9.]*)"
  outdated_all = "echo 'alpha 2.0'"
  upgrade      = "printf 'Ans\\167er me: '; read answer && echo \"answered-$answer\" > asked.txt"
}

program "alpha" {
  install_via = [asks]
}

machine "m1" {
  install = [program.alpha]
}
HCL
compile_repo arepo
"$BIN" --repo arepo --machine m1 status >/dev/null
if has_pty; then
    { wait_settled tui-asks; printf '3'; sleep 0.3; printf 'l'; wait_frame tui-asks '1 update'
      printf 'a'; sleep 0.3; printf '\r'; wait_frame tui-asks 'These will upgrade'
      printf '\r'; wait_frame tui-asks 'Answer me:'; printf 'no\r'
      wait_done tui-asks; wait_frame tui-asks '✓ Done'; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-asks --repo arepo --machine m1
    grep -qx answered-no arepo/asked.txt || fail_frame tui-asks "the upgrade read its answer from the panel"
    ok "an upgrade that asks something gets its answer in the panel"

    # ctrl+] leaves the run to the dashboard: q is refused while it runs,
    # tab goes back in, and Ctrl-C there stops the command, not loadout.
    rm -f arepo/asked.txt
    { wait_settled tui-intr; printf '3'; sleep 0.3; printf 'l'; wait_frame tui-intr '1 update'
      printf 'a'; sleep 0.3; printf '\r'; wait_frame tui-intr 'These will upgrade'
      printf '\r'; wait_frame tui-intr 'Answer me:'
      printf '\035'; sleep 0.3; printf 'q'; wait_frame tui-intr 'a command is running' && cp tui-intr.screen tui-intr.refused
      printf '\t'; sleep 0.3; printf '\003'; wait_done tui-intr; wait_frame tui-intr '! Warning' && cp tui-intr.screen tui-intr.done
      printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-intr --repo arepo --machine m1
    [ -f tui-intr.refused ] || fail_frame tui-intr "q is refused while a command runs"
    grep -q 'Answer me:' tui-intr.refused || fail "the run goes on behind the dashboard"
    [ -f tui-intr.done ] || fail_frame tui-intr "Ctrl-C in the panel interrupts the command"
    grep -qE 'Run .*interrupted' tui-intr.done || fail "the panel says it was interrupted"
    grep -q 'Machine ─' tui-intr.done || fail "loadout survives Ctrl-C"
    grep -qE '◉ sh' tui-intr.done || fail "an interrupted upgrade keeps its ticks for another go"
    [ -f arepo/asked.txt ] && fail "Ctrl-C stops the command before it goes on"
    ok "ctrl+] leaves a run, q waits for it, and Ctrl-C stops the command, not the screen"
fi

# --- each sidebar row settles on its own ------------------------------------
# Programs answer at once; a script's check takes seconds. The programs row
# must stop spinning with its answer while the scripts row still spins.
hcl_root prepo <<'HCL'
program "fast" {
  custom {
    command = "true"
    present = "true"
  }
}

script "slow" {
  run   = "true"
  check = "sleep 4"
}

machine "m1" {
  install = [program.fast]
  run     = [script.slow]
}
HCL
compile_repo prepo
if has_pty; then
    { wait_frame tui-parts 'programs +1/1' && cp tui-parts.screen tui-parts.early
      wait_frame tui-parts 'scripts +1/1'; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-parts --repo prepo --machine m1
    [ -f tui-parts.early ] || fail_frame tui-parts "the programs row settles on its own"
    grep -qE '[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] scripts' tui-parts.early || fail_frame tui-parts "while the scripts row still spins"
    grep -qE 'scripts +1/1' tui-parts.screen || fail_frame tui-parts "then the scripts row settles too"
    ok "each sidebar row stops its spinner when its own checks land"
fi

# --- the theme, and the stacked layout --------------------------------------
if has_pty; then
    { wait_settled tui-theme; printf 't'; sleep 0.5; printf 'q'; sleep 1; } \
        | LOADOUT_THEME=dark XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-theme --repo nrepo --machine m1
    # The terminal's own background shows through (a transparent one
    # included): the screen never sets it (OSC 11 with a colour).
    grep -qaE "]11;(#|rgb:)" tui-theme.log && fail "the screen leaves the terminal's background alone"
    # The palette switches: the sidebar's brand line, always drawn, starts in
    # the theme's secondary colour — Dolly in the dark one, Urchin in the light.
    grep -qa "38;2;255;96;255" tui-theme.log || fail "the dark theme's colours"
    grep -qa "38;2;195;55;224" tui-theme.log || fail "t switches to the light theme's colours"
    ok "t toggles the theme, and the terminal's background stays its own"

    # Under 100 columns the screen is stacked: one page at a time, under a
    # breadcrumb. enter opens a subject's page, esc goes back home.
    { wait_settled tui-stacked; wait_frame tui-stacked 'loadout › m1' && cp tui-stacked.screen tui-stacked.home
      printf '\r'; wait_frame tui-stacked 'loadout › programs' '× mytool +missing · via fake' && cp tui-stacked.screen tui-stacked.subject
      printf '\033'; wait_frame tui-stacked 'loadout › m1' 'Machine ─' && cp tui-stacked.screen tui-stacked.back
      printf 'q'; sleep 1; } \
        | PTY_SIZE=80x24 XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-stacked --repo nrepo --machine m1
    [ -f tui-stacked.home ] || fail_frame tui-stacked "the stacked home page has a breadcrumb"
    grep -qE '^ +× programs +0/1 *$' tui-stacked.home || fail_frame tui-stacked "the home page lists the subjects full width"
    grep -q 'mytool' tui-stacked.home && fail "and no list"
    grep -q '│' tui-stacked.home && fail "and no sidebar edge"
    [ -f tui-stacked.subject ] || fail_frame tui-stacked "enter opens the subject's page"
    grep -q 'Machine ─' tui-stacked.subject && fail "the subject page alone"
    grep -q 'esc back' tui-stacked.subject || fail "its help says esc goes back"
    [ -f tui-stacked.back ] || fail_frame tui-stacked "esc goes back to the home page"
    ok "under 100 columns one page shows at a time: enter opens a subject, esc goes back"

    # A run in the stacked layout: its own page, full screen; it stays
    # there when it ends, and esc goes back to the list.
    { wait_settled tui-stackrun; printf '2'; wait_frame tui-stackrun 'loadout › scripts' 'drifted'; printf 'a'; sleep 0.3; printf '\r'
      wait_frame tui-stackrun 'These scripts will run' 'Run +Cancel'; printf '\r'
      wait_done tui-stackrun; wait_frame tui-stackrun '✓ Done' && cp tui-stackrun.screen tui-stackrun.done
      sleep 5; cp tui-stackrun.screen tui-stackrun.later
      printf '\033'; wait_frame tui-stackrun 'loadout › scripts' '> filter' && cp tui-stackrun.screen tui-stackrun.list
      printf 'q'; sleep 1; } \
        | PTY_SIZE=80x24 XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-stackrun --repo nrepo --machine m1
    [ -f tui-stackrun.done ] || fail_frame tui-stackrun "the stacked run ends with a toast"
    grep -q 'loadout › scripts › run' tui-stackrun.done || fail_frame tui-stackrun "the run has its own page"
    grep -q "ran drifted (exit 0)" tui-stackrun.done || fail "with the command's output"
    grep -qE '(●|✓) (drifted|healthy) ' tui-stackrun.done && fail "and no list rows"
    grep -qE 'Run .*✓ done' tui-stackrun.later || fail_frame tui-stackrun "a finished run stays on its page"
    grep -q 'esc back' tui-stackrun.later || fail "and says esc goes back"
    [ -f tui-stackrun.list ] || fail_frame tui-stackrun "esc goes back to the list"
    grep -qE 'Run .*✓ done' tui-stackrun.list && fail "and closes the finished run"
    ok "a stacked run shows full screen, stays when it ends, and esc goes back to the list"
fi

# --- U and an S that upgraded end the screen --------------------------------
if has_pty; then
    # The cached latest release (0.0.1) is older: self-upgrade has nothing
    # to install, and the screen ends anyway, printing the run's output.
    { wait_settled tui-self; printf 'U'; wait_frame tui-self 'Upgrade loadout  '; printf '\r'; sleep 3; } \
        | XDG_CACHE_HOME=$FAKE_CACHE screen_run tui-self --repo nrepo --machine m1
    plain_screen tui-self.log | sed -n '/already on the latest release/,$p' | grep -q "run loadout again" \
        || fail "U ends the screen with the run's output and what to do next: $(plain_screen tui-self.log | tail -5)"
    ok "U runs self-upgrade and ends the screen"

    # A sync whose pull needs a newer loadout upgrades it (a fake curl, as in
    # 50-diff-sync) and the screen ends: the binary on disk changed.
    basic_repo urepo
    git -C urepo add -A && git -C urepo commit -qm init
    git init -q --bare uorigin.git
    git -C urepo remote add origin "$PWD/uorigin.git" && git -C urepo push -qu origin HEAD 2>/dev/null
    git clone -q uorigin.git uother
    git -C uother config user.email test@example.com && git -C uother config user.name "Integration Test"
    repo_attr uother/loadout.hcl 'min_tool_version = "999.0.0"'
    compile_repo uother
    git -C uother add -A && git -C uother commit -qm floor && git -C uother push -q 2>/dev/null
    "$BIN" --repo urepo --machine m1 status >/dev/null
    mkdir -p self fakecurl
    cp "$BIN" self/loadout
    cat > fakecurl/curl <<EOF2
#!/bin/sh
case "\$*" in
    *api.github.com*) echo '"tag_name": "v999.0.0"' ;;
    *install.sh*) printf '%s\n' 'printf "#!/bin/sh\necho \\"new loadout: \\\$*\\"\n" > "$PWD/self/new" && chmod +x "$PWD/self/new" && mv "$PWD/self/new" "$PWD/self/loadout"' ;;
    *) exit 22 ;;
esac
EOF2
    chmod +x fakecurl/curl
    { wait_settled tui-sync; printf 'S'; wait_frame tui-sync 'Sync  '; printf '\r'; sleep 5; } \
        | PATH="$PWD/fakecurl:$PATH" XDG_CACHE_HOME=$FAKE_CACHE BIN=$PWD/self/loadout screen_run tui-sync --repo urepo --machine m1
    plain_screen tui-sync.log | grep -q "new loadout: .*sync" || fail "the sync upgraded and carried on: $(plain_screen tui-sync.log | tail -8)"
    plain_screen tui-sync.log | grep -q "upgraded itself to sync this repo — run loadout again" \
        || fail "an S that upgraded ends the screen, saying so: $(plain_screen tui-sync.log | tail -8)"
    ok "an S that upgraded loadout ends the screen"
fi
