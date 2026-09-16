# The home screen, driven on a pseudo-terminal. Give the screen ~4s to bind
# the tty and finish its first refresh before the first key: a key on a
# busy row is refused, and a key before raw mode is lost.

basic_repo repo
OUT=$("$BIN" --repo repo --machine m1 2>&1)
echo "$OUT" | grep -q "Usage: loadout" || fail "bare loadout without a TTY still prints help"
if has_pty; then
    { sleep 3; printf 'q'; sleep 1; } | pty_run tui-home.log --repo repo --machine m1
    grep -qa "loadout" tui-home.log || fail "the home screen renders"
    # The footer is one clipped line, and its wording is compact on a narrow
    # terminal — assert the keys, not the sentence.
    grep -qa "enter act" tui-home.log || fail "the home screen says how to act"
    grep -qa "l open" tui-home.log || fail "the home screen says how to look"
    grep -qa "programs" tui-home.log || fail "the home screen lists its subjects"
    grep -qai "Tty already bound" tui-home.log && fail "the home screen must not double-bind the tty" || true
    ok "bare loadout opens the home screen on a TTY, help without one"
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
    { sleep 4; printf 'j'; sleep 1; printf 'l'; sleep 0.5; printf 'a'; sleep 0.5; printf '\r'; sleep 1; printf '\r'; sleep 6; printf '\r'; sleep 0.5; printf 'q'; sleep 1; } \
        | pty_run tui-scripts.log --repo srepo --machine m1
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
    { sleep 4; printf 'j'; sleep 1; printf 'l'; sleep 0.5; printf 'a'; sleep 0.5; printf '\r'; sleep 1; printf '\r'; sleep 6; printf 'q'; sleep 0.5; printf 'q'; sleep 1; } \
        | pty_run tui-nowrite.log --repo srepo --machine m1
    chmod 600 srepo/state/m1.json
    grep -qa "state not written" tui-nowrite.log || fail "a failed state write is surfaced in the pane"
    ok "the pane says so when it cannot write the state file"
fi

# --- the remote row: the chevron means "rows are hidden here" -------------
# Two repos with one batch oracle each: one reports nothing outdated, one
# reports a package. A tool that heads no rows hides nothing when folded,
# so only the second may ever show a chevron. The preseeded cache keeps the
# self-version check off the network, so the remotes answer at once.
mkdir -p orepo/state orepo/machines frepo/state frepo/machines cache/loadout
echo 0.0.1 > cache/loadout/latest-release
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
    fold_keys() { sleep 5; printf 'j'; sleep 0.4; printf 'j'; sleep 0.4; printf 'l'; sleep 1; printf 'h'; sleep 1; printf 'q'; sleep 1; }
    fold_keys | XDG_CACHE_HOME=$PWD/cache pty_run tui-clean.log --repo orepo --machine m1
    grep -qa "up to date" tui-clean.log || fail "the remote table lists a tool with nothing outdated"
    grep -qa "▸" tui-clean.log && fail "a tool that heads no rows must not show a fold chevron" || true
    ok "the remote table never offers to fold a clean tool"

    fold_keys | XDG_CACHE_HOME=$PWD/cache pty_run tui-fold.log --repo frepo --machine m1
    grep -qa "1 update" tui-fold.log || fail "the remote table lists the tool's one update"
    grep -qa "sh ▸" tui-fold.log || fail "h folds a tool that heads rows, and marks it"
    ok "h still folds a tool whose rows it hides"
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
    { sleep 4; printf 'l'; sleep 0.5; printf '\r'; sleep 0.5; printf '\r'; sleep 0.7; printf 'nope\r'; sleep 1; printf 'secret\r'; sleep 6; printf '\r'; sleep 0.5; printf 'q'; sleep 1; } \
        | PATH="$FAKE_SUDO_PATH:$PATH" pty_run tui-install.log --repo irepo --machine m1
    grep -qa "These programs will install" tui-install.log || fail "the pane asks before installing"
    grep -qa "sudo password:" tui-install.log || fail "the pane asks for the sudo password itself"
    grep -qa "sorry, try again" tui-install.log || fail "a wrong password is refused on the field"
    grep -qa "nope" tui-install.log && fail "the password must never be echoed" || true
    grep -qa "All 2 program(s) installed" tui-install.log || fail "the right password runs the installs"
    [ -f irepo/fake-alpha.txt ] && [ -f irepo/fake-beta.txt ] || fail "both ticked programs were installed"
    grep -c '"status": "installed"' irepo/state/m1.json | grep -qx 2 || fail "the re-check recorded both as installed"
    ok "the programs row installs ticked programs in the pane, asking for sudo's password itself"
fi
