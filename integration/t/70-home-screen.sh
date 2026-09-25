# The home screen, driven on a pseudo-terminal. Key feeders wait on the
# screen itself (wait_settled / wait_screen), never on a fixed sleep: a key
# on a busy row is refused, a key before raw mode is lost, and how long the
# rows take to answer depends on the machine.

basic_repo repo
# Every PTY test here stubs the self-version cache: the screen asks the
# remotes the moment it opens, and an unstubbed check is seconds of curl
# before the remote row can settle.
fake_release_cache
OUT=$("$BIN" --repo repo --machine m1 2>&1)
echo "$OUT" | grep -q "Usage: loadout" || fail "bare loadout without a TTY still prints help"
if has_pty; then
    { wait_settled tui-home.log; printf 'q'; sleep 1; } | XDG_CACHE_HOME=$FAKE_CACHE pty_run tui-home.log --repo repo --machine m1
    grep -qa "loadout" tui-home.log || fail "the home screen renders"
    # The footer is one clipped line, and its wording is compact on a narrow
    # terminal — assert the keys, not the sentence.
    grep -qa "enter act" tui-home.log || fail "the home screen says how to act"
    grep -qa "l open" tui-home.log || fail "the home screen says how to look"
    grep -qa "programs" tui-home.log || fail "the home screen lists its subjects"
    grep -qai "Tty already bound" tui-home.log && fail "the home screen must not double-bind the tty" || true
    ok "bare loadout opens the home screen on a TTY, help without one"

    # esc closes lists; it must never end the session, or a habit of
    # pressing it on the way out of one drops you off the screen. Three of
    # them on a row with nothing open, then q: the screen answers each and
    # leaves on the q.
    { wait_settled tui-esc.log; printf '\033'; sleep 0.4; printf '\033'; sleep 0.4; printf '\033'; sleep 0.6; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE pty_run tui-esc.log --repo repo --machine m1
    grep -qa "nothing to close" tui-esc.log || fail "esc on a top-level row says which key quits"
    grep -qa "q quits" tui-esc.log || fail "and names q as the way out"
    ok "esc never quits the home screen — only q does"
fi

# --- the scripts row: open the picker -> tick all -> run in the pane -----
scripts_repo srepo
"$BIN" --repo srepo --machine m1 setup-new-machine --yes >/dev/null
rm -f srepo/bootstrap-marker.txt
"$BIN" --repo srepo --machine m1 status >/dev/null
if has_pty; then
    # j to the scripts row, l opens the picker, a ticks every script,
    # enter asks, enter runs, wait for the refresh, enter closes, q quits
    # (a q on a finished pane closes it — it never quits the screen).
    { wait_settled tui-scripts.log; printf 'j'; sleep 0.4; printf 'l'; wait_screen tui-scripts.log 'space tick'
      printf 'a'; sleep 0.4; printf '\r'; wait_screen tui-scripts.log 'These scripts will run'
      printf '\r'; wait_pane_done tui-scripts.log; printf '\r'; sleep 0.5; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE pty_run tui-scripts.log --repo srepo --machine m1
    grep -qa "space tick" tui-scripts.log || fail "the scripts row opens a picker"
    grep -qa "bootstrap-only" tui-scripts.log && fail "the picker must not list modes=[setup] scripts" || true
    grep -qa "These scripts will run" tui-scripts.log || fail "the pane asks before running scripts"
    grep -qa "Still not done: drifted" tui-scripts.log || fail "the pane re-checks and names what is still not done"
    grep -qa "missing: nodejs 16" tui-scripts.log || fail "the pane says what the failing check printed"
    grep -q '"drifted"' srepo/state/m1.json || fail "a pane run records the scripts in the state file"
    grep -q '"status": "pending"' srepo/state/m1.json || fail "the recorded status comes from the rerun check"
    grep -q '"exitCode": 0' srepo/state/m1.json || fail "the recorded exit code is the script's own"
    ok "the home screen runs ticked scripts in its pane and re-checks them"

    # A state write that fails must be said out loud, not swallowed: the runs
    # happened, nothing recorded them. A read-only state FILE forces it — a
    # read-only directory would not: rewriting an existing file needs no
    # directory permission.
    chmod 400 srepo/state/m1.json
    { wait_settled tui-nowrite.log; printf 'j'; sleep 0.4; printf 'l'; wait_screen tui-nowrite.log 'space tick'
      printf 'a'; sleep 0.4; printf '\r'; wait_screen tui-nowrite.log 'These scripts will run'
      printf '\r'; wait_pane_done tui-nowrite.log; printf 'q'; sleep 0.5; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE pty_run tui-nowrite.log --repo srepo --machine m1
    chmod 600 srepo/state/m1.json
    grep -qa "state not written" tui-nowrite.log || fail "a failed state write is surfaced in the pane"
    ok "the pane says so when it cannot write the state file"
fi

# --- one cursor for the whole screen --------------------------------------
# k off a table's first row used to stop dead there: the only way to another
# subject was to close the table first. The cursor walks the whole body now,
# and every list you opened stays open behind it.
scripts_repo nrepo
fake_release_cache
"$BIN" --repo nrepo --machine m1 status >/dev/null
if has_pty; then
    # l opens the programs picker (mytool is missing), k walks out onto the
    # programs row, jj walks back through the picker onto the scripts row,
    # and l opens ITS picker — with the first one still open above it.
    { wait_settled tui-nav.log; printf 'l'; wait_screen tui-nav.log 'mytool'
      printf 'k'; sleep 0.4; printf 'jj'; sleep 0.6; printf 'l'; wait_screen tui-nav.log 'drifted'; sleep 0.5; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE pty_run tui-nav.log --repo nrepo --machine m1
    grep -qa "mytool" tui-nav.log || fail "the programs picker lists the missing program"
    # Within a few lines of each other: one frame holding both tables.
    grep -a -A4 "mytool" tui-nav.log | grep -qa "drifted" \
        || fail "the scripts picker must open with the programs one still open above it"
    ok "the cursor walks out of an open list, and opening another keeps it open"
fi

# --- the remote row: the chevron means "rows are hidden here" -------------
# Two repos with one batch oracle each: one reports nothing outdated, one
# reports a package. A tool that heads no rows hides nothing when folded,
# so only the second may ever show a chevron.
mkdir -p orepo/state orepo/machines frepo/state frepo/machines
fake_release_cache
cat > orepo/manifest.toml <<'TOML'
[installers.quiet]
probe = "sh"
install = "echo installed-{pkg} > quiet-{pkg}.txt"
check = "echo {pkg} 1.0"
regex = "([0-9][0-9.]*)"
outdated-all = "true"
upgrade = "echo swept"

[programs.alpha]
via = ["quiet"]
TOML
cat > frepo/manifest.toml <<'TOML'
[installers.quiet]
probe = "sh"
install = "echo installed-{pkg} > quiet-{pkg}.txt"
check = "echo {pkg} 1.0"
regex = "([0-9][0-9.]*)"
outdated-all = "echo 'alpha 2.0'"
upgrade = "echo swept"

[programs.alpha]
via = ["quiet"]
TOML
printf '[pm]\nalpha = "quiet"\n' > orepo/machines/m1.toml
cp orepo/machines/m1.toml frepo/machines/m1.toml
"$BIN" --repo orepo --machine m1 status >/dev/null
"$BIN" --repo frepo --machine m1 status >/dev/null
if has_pty; then
    # jj to the remote row, l opens the table with the cursor on the tool
    # line, h, then q. The tool is named after its probe: sh.
    fold_keys() { wait_settled "$1"; printf 'j'; sleep 0.4; printf 'j'; sleep 0.4; printf 'l'; sleep 0.6; printf 'h'; sleep 1; printf 'q'; sleep 1; }
    fold_keys tui-clean.log | XDG_CACHE_HOME=$FAKE_CACHE pty_run tui-clean.log --repo orepo --machine m1
    grep -qa "up to date" tui-clean.log || fail "the remote table lists a tool with nothing outdated"
    grep -qa "▸" tui-clean.log && fail "a tool that heads no rows must not show a fold chevron" || true
    ok "the remote table never offers to fold a clean tool"

    fold_keys tui-fold.log | XDG_CACHE_HOME=$FAKE_CACHE pty_run tui-fold.log --repo frepo --machine m1
    grep -qa "1 update" tui-fold.log || fail "the remote table lists the tool's one update"
    grep -qa "sh ▸" tui-fold.log || fail "h folds a tool that heads rows, and marks it"
    ok "h still folds a tool whose rows it hides"

    # The row's own summary, from the same two runs: a tool leads with the
    # count it can fix in one command, and an idle fleet says so in words
    # (the table pads its tool name, so "sh 1" can only be the row).
    grep -qa "everything up to date" tui-clean.log || fail "the remote row says so when nothing is outdated"
    grep -qa "sh 1" tui-fold.log || fail "the remote row leads with the tool that has work"
    ok "the remote row summarises where the work is"
fi

# --- the remote row: a source's item belongs to its source ----------------
# The live repo has a `tpack` tmux plugin AND a `tpack` package. Filing a
# row by name put the plugin under the package's tool, so ticking it ran
# the tool's sweep — which cannot fast-forward a git clone, so the row came
# back outdated after every refresh, forever. Each upgrade writes its own
# file: the tool's command is printed on screen either way, so only the
# filesystem can say which one actually ran.
mkdir -p crepo/state crepo/machines
cat > crepo/manifest.toml <<'TOML'
[installers.quiet]
probe = "sh"
install = "echo installed-{pkg} > quiet-{pkg}.txt"
check = "echo {pkg} 1.0"
regex = "([0-9][0-9.]*)"
outdated-all = "echo 'tpack 2.0'"
upgrade = "echo swept > the-tool-swept.txt"

[programs.tpack]
via = ["quiet"]

[outdated.tmux-plugins]
command = "echo 'tpack aaa1111 bbb2222 156 commit(s) behind'"
upgrade = "echo pulled > pulled-{item}.txt"
TOML
printf '[pm]\ntpack = "quiet"\n' > crepo/machines/m1.toml
"$BIN" --repo crepo --machine m1 status >/dev/null
if has_pty; then
    # jj to the remote row, l opens the table, then jjj walks the tool
    # line, the package under it and the source heading to reach the
    # source's OWN tpack row: space ticks it, enter asks, enter runs,
    # enter closes the finished pane, q quits.
    { wait_settled tui-collide.log; printf 'j'; sleep 0.4; printf 'j'; sleep 0.4; printf 'l'; wait_screen tui-collide.log '156 commit'
      printf 'jjj'; sleep 0.6; printf ' '; sleep 0.4; printf '\r'; wait_screen tui-collide.log 'These commands will run'
      printf '\r'; wait_pane_done tui-collide.log; printf '\r'; sleep 0.5; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE pty_run tui-collide.log --repo crepo --machine m1
    grep -qa "These commands will run" tui-collide.log || fail "the pane asks before upgrading"
    [ -f crepo/pulled-tpack.txt ] || fail "the ticked row upgraded through its own source"
    [ -f crepo/the-tool-swept.txt ] && fail "a source's item must never run the tool's sweep" || true
    ok "a source's row upgrades through its source, not through a same-named program's tool"

    # ] goes over the rows to the next group's heading: from the tool line
    # straight to the source, skipping the package under it. Which line it
    # landed on is a filesystem question again — ticking a source heading
    # covers its item, ticking a tool line sweeps the tool.
    rm -f crepo/pulled-tpack.txt crepo/the-tool-swept.txt
    { wait_settled tui-jump.log; printf 'j'; sleep 0.4; printf 'j'; sleep 0.4; printf 'l'; wait_screen tui-jump.log '156 commit'
      printf ']'; sleep 0.6; printf ' '; sleep 0.4; printf '\r'; wait_screen tui-jump.log 'These commands will run'
      printf '\r'; wait_pane_done tui-jump.log; printf '\r'; sleep 0.5; printf 'q'; sleep 1; } \
        | XDG_CACHE_HOME=$FAKE_CACHE pty_run tui-jump.log --repo crepo --machine m1
    [ -f crepo/pulled-tpack.txt ] || fail "] landed on the source heading, whose tick covers its item"
    [ -f crepo/the-tool-swept.txt ] && fail "] skips the rows under a heading, it doesn't tick the tool" || true
    ok "] jumps to the next group's heading, over the rows under it"
fi

# --- the programs row: tick missing programs, the pane asks for sudo ------
# A fake sudo on PATH: the pane must ask for the password ITSELF (a child's
# prompt behind it is invisible), refuse a wrong one, and run on the right.
mkdir -p irepo/state irepo/machines
cat > irepo/manifest.toml <<'TOML'
[installers.fake]
probe = "sh"
install = "sudo sh -c 'echo installed-{pkg} > fake-{pkg}.txt'"
check = "test -f fake-{pkg}.txt && echo {pkg} 1.0"
regex = "([0-9][0-9.]*)"

[programs.alpha]
via = ["fake"]
[programs.beta]
via = ["fake"]
TOML
printf '[pm]\nalpha = "fake"\nbeta = "fake"\n' > irepo/machines/m1.toml
fake_sudo
"$BIN" --repo irepo --machine m1 status >/dev/null
if has_pty; then
    # l opens the picker (both missing, both ticked), enter asks, enter says
    # yes -> the password field; a wrong password is refused, the right one
    # runs both installs; enter closes the finished pane, q quits.
    { wait_settled tui-install.log; printf 'l'; wait_screen tui-install.log 'space tick'
      printf '\r'; wait_screen tui-install.log 'These programs will install'
      printf '\r'; wait_screen tui-install.log 'sudo password:'; printf 'nope\r'; wait_screen tui-install.log 'sorry, try again'
      printf 'secret\r'; wait_pane_done tui-install.log; printf '\r'; sleep 0.5; printf 'q'; sleep 1; } \
        | PATH="$FAKE_SUDO_PATH:$PATH" XDG_CACHE_HOME=$FAKE_CACHE pty_run tui-install.log --repo irepo --machine m1
    grep -qa "These programs will install" tui-install.log || fail "the pane asks before installing"
    grep -qa "sudo password:" tui-install.log || fail "the pane asks for the sudo password itself"
    grep -qa "sorry, try again" tui-install.log || fail "a wrong password is refused on the field"
    grep -qa "nope" tui-install.log && fail "the password must never be echoed" || true
    grep -qa "All 2 program(s) installed" tui-install.log || fail "the right password runs the installs"
    [ -f irepo/fake-alpha.txt ] && [ -f irepo/fake-beta.txt ] || fail "both ticked programs were installed"
    grep -c '"status": "installed"' irepo/state/m1.json | grep -qx 2 || fail "the re-check recorded both as installed"
    ok "the programs row installs ticked programs in the pane, asking for sudo's password itself"
fi

# --- sudo called from INSIDE a command: only a declaration can tell ------
# `omarchy pkg add`, Homebrew's installer: the command never says sudo, so
# without `sudo = true` the pane would start it and the prompt would hang
# invisibly behind it (the fake sudo refuses without a stamp instead).
mkdir -p hrepo/state hrepo/machines
cat > hrepo/inner.sh <<'SH'
sudo sh -c "echo installed-$1 > fake-$1.txt"
SH
cat > hrepo/manifest.toml <<'TOML'
[installers.hidden]
probe = "sh"
install = "sh inner.sh {pkg}"
check = "test -f fake-{pkg}.txt && echo {pkg} 1.0"
regex = "([0-9][0-9.]*)"
sudo = true

[programs.gamma]
via = ["hidden"]
TOML
printf '[pm]\ngamma = "hidden"\n' > hrepo/machines/m1.toml
fake_sudo
"$BIN" --repo hrepo --machine m1 status >/dev/null
OUT=$("$BIN" --repo hrepo --machine m1 explain gamma)
echo "$OUT" | grep -qE "sudo.hidden +yes" || fail "explain shows the declared sudo"
if has_pty; then
    { wait_settled tui-hidden.log; printf 'l'; wait_screen tui-hidden.log 'space tick'
      printf '\r'; wait_screen tui-hidden.log 'These programs will install'
      printf '\r'; wait_screen tui-hidden.log 'sudo password:'; printf 'secret\r'; wait_pane_done tui-hidden.log
      printf '\r'; sleep 0.5; printf 'q'; sleep 1; } \
        | PATH="$FAKE_SUDO_PATH:$PATH" XDG_CACHE_HOME=$FAKE_CACHE pty_run tui-hidden.log --repo hrepo --machine m1
    grep -qa "sudo password:" tui-hidden.log || fail "a declared sudo makes the pane ask, though no command says sudo"
    [ -f hrepo/fake-gamma.txt ] || fail "the install ran with the stamped sudo"
    ok "an installer declaring sudo = true gets its password asked up front"
fi
