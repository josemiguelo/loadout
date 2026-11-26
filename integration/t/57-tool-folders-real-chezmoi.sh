# Tool folders against the real chezmoi, where the stubs of 56 and 110 can't
# tell: modes, umasks, chezmoi's own writes into a build, a failing apply.
# Every command runs with a scratch HOME and XDG_* and a stand-in for /
# (LOADOUT_ROOT_DESTINATION), so nothing reads or writes the developer's
# dotfiles or the real /. Skipped where chezmoi isn't installed.

real_chezmoi_tests() {
    local H="$PWD/home" R="$PWD/slash"
    mkdir -p "$H" "$R/etc"
    # rc: loadout, cz: plain chezmoi, both in the scratch home.
    rc() { HOME="$H" XDG_CONFIG_HOME="$H/.config" XDG_DATA_HOME="$H/.local/share" XDG_STATE_HOME="$H/.local/state" LOADOUT_ROOT_DESTINATION="$R" "$BIN" "$@"; }
    cz() { HOME="$H" XDG_CONFIG_HOME="$H/.config" XDG_DATA_HOME="$H/.local/share" XDG_STATE_HOME="$H/.local/state" chezmoi "$@"; }
    mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

    basic_repo repo
    repo_opt repo/loadout.ts 'dotfiles: { tools: "tools/*", home: ".home", root: ".root" }'
    mkdir -p repo/tools/zsh/home repo/tools/kb/root/etc/udev
    echo 'export ZDOTDIR' > repo/tools/zsh/home/dot_zshenv
    echo '.zcompdump' > repo/tools/zsh/home/.chezmoiignore
    echo 'rule' > repo/tools/kb/root/etc/udev/kb.rules
    compile_repo repo
    local S=repo/.home R_STATE="$R/var/lib/loadout/chezmoistate.boltdb"

    # --- apply --dry-run writes nothing, / included ---------------------------------
    OUT=$(rc --repo repo --machine m1 chezmoi apply --dry-run 2>&1) || fail "loadout chezmoi apply --dry-run: $OUT"
    [ ! -e "$H/.zshenv" ] || fail "a dry run wrote \$HOME"
    [ ! -e "$R/etc/udev/kb.rules" ] || fail "a dry run wrote the / configs"
    OUT=$(rc --repo repo --machine m1 chezmoi apply --include files 2>&1) && fail "--include can't go with the / configs' passes"
    echo "$OUT" | grep -q "doesn't go with the / configs" || fail "and says so: $OUT"
    ok "loadout chezmoi apply --dry-run writes neither \$HOME nor /"

    # --- one umask for observing and applying -----------------------------------------
    (umask 002 && rc --repo repo --machine m1 apply-config >/dev/null 2>&1) || fail "apply-config under umask 002"
    [ "$(mode "$R/etc/udev/kb.rules")" = 644 ] || fail "a / config is 0644 whatever the umask: $(mode "$R/etc/udev/kb.rules")"
    OUT=$(umask 077 && rc --repo repo --machine m1 status 2>&1)
    echo "$OUT" | grep -qE '/kb +applied' || fail "observed under another umask, a / config still reads applied: $OUT"
    [ "$(mode "$R_STATE")" = 644 ] || fail "root's state is left readable: $(mode "$R_STATE")"
    ok "a / config is applied and observed under one umask, and root's state stays readable"

    # --- a / file this user can't read takes down only its own unit ----------------------
    chmod 000 "$R/etc/udev/kb.rules"
    OUT=$(rc --repo repo --machine m1 status 2>&1)
    chmod 644 "$R/etc/udev/kb.rules"
    echo "$OUT" | grep -qE '/kb +not checked' || fail "the unreadable / config is not checked: $OUT"
    # Observed (the umask changed between apply and status above, which only a / config is immune to).
    echo "$OUT" | grep -qE '\.zshenv +(applied|drifted)' || fail "\$HOME's configs are still observed: $OUT"
    ok "a / file this user can't read leaves its own unit unknown, and every other observed"

    # --- a failed apply keeps root's state readable ----------------------------------------
    mkdir -p repo/tools/kb/root/.chezmoiscripts
    printf '#!/bin/sh\nexit 3\n' > repo/tools/kb/root/.chezmoiscripts/run_onchange_after_fail.sh
    chmod 600 "$R_STATE"
    rc --repo repo --machine m1 apply-config >/dev/null 2>&1 && fail "an apply whose script fails fails"
    [ "$(mode "$R_STATE")" = 644 ] || fail "root's state is readable after a failed apply: $(mode "$R_STATE")"
    rm -r repo/tools/kb/root/.chezmoiscripts
    rc --repo repo --machine m1 explain git >/dev/null 2>&1 || fail "the repo loads after the script is gone"
    ok "a failed / apply still leaves root's state readable"

    # --- what a plain chezmoi re-add left in a build ------------------------------------------
    echo 'edited here' >> "$H/.zshenv"
    cz --source "$PWD/$S" re-add "$H/.zshenv" >/dev/null 2>&1 || fail "plain chezmoi re-add"
    [ ! -L "$S/dot_zshenv" ] || fail "plain chezmoi re-add writes into the build"
    OUT=$(rc --repo repo --machine m1 explain git 2>&1) && fail "a chezmoi write in the build is refused"
    echo "$OUT" | grep -qF "keep it with \`loadout chezmoi re-add ~/.zshenv\` (or copy it over tools/zsh/home/dot_zshenv), or drop it by deleting .home/dot_zshenv" ||
        fail "the refusal names both ways out: $OUT"
    OUT=$(rc --repo repo --machine m1 chezmoi re-add "$H/.zshenv" 2>&1) || fail "loadout chezmoi re-add carries the left write: $OUT"
    grep -q 'edited here' repo/tools/zsh/home/dot_zshenv || fail "the edit is in the tool's file"
    [ -L "$S/dot_zshenv" ] || fail "and the build's symlink is back"
    rc --repo repo --machine m1 explain git >/dev/null 2>&1 || fail "the repo loads again"
    echo 'dropped' >> "$H/.zshenv"
    cz --source "$PWD/$S" re-add "$H/.zshenv" >/dev/null 2>&1
    rm "$S/dot_zshenv"
    rc --repo repo --machine m1 explain git >/dev/null 2>&1 || fail "deleting the build's file drops the edit"
    ! grep -q dropped repo/tools/zsh/home/dot_zshenv && [ -L "$S/dot_zshenv" ] || fail "the tool's file is untouched and relinked"
    ok "what a plain chezmoi re-add left is kept by loadout chezmoi re-add, or dropped by deleting it"

    # --- a tool's last .chezmoiignore goes ----------------------------------------------------
    rm repo/tools/zsh/home/.chezmoiignore
    OUT=$(rc --repo repo --machine m1 explain git 2>&1) || fail "removing a tool's last .chezmoiignore doesn't block the repo: $OUT"
    [ ! -e "$S/.chezmoiignore" ] || fail "and the build's joined copy goes"
    ok "a tool's last .chezmoiignore going removes the build's copy, blocking nothing"

    # --- setup plans / configs before chezmoi is installed --------------------------------------
    mkdir -p nochezmoi && printf '#!/bin/sh\necho "sh: chezmoi: not found" >&2\nexit 127\n' > nochezmoi/chezmoi && chmod +x nochezmoi/chezmoi
    echo 'more' >> repo/tools/kb/root/etc/udev/kb.rules
    OUT=$(PATH="$PWD/nochezmoi:$PATH" rc --repo repo --machine m1 setup-new-machine --dry-run 2>&1) || fail "setup plans without chezmoi: $OUT"
    echo "$OUT" | grep -q 'configs outside \$HOME *config' || fail "the / configs are one row until chezmoi is there: $OUT"
    OUT=$(rc --repo repo --machine m1 setup-new-machine --dry-run 2>&1)
    echo "$OUT" | grep -qE '/kb +config' || fail "with chezmoi, the drifted / config by name: $OUT"
    ok "setup-new-machine plans / configs before chezmoi is installed, and names them once it is"

    # --- a child reached through a symlink, its parent with tool folders --------------------------
    local P; P=$(cd repo && pwd -P)
    ts_root kid "parent: { name: \"dots\", path: \"$P\" }" </dev/null
    ts_file kid/machines/work.loadout.ts <<'TS'
machine("work", {});
TS
    OUT=$("$BIN" --repo kid compile 2>&1) || fail "the child compiles: $OUT"
    # At another depth than the checkout (/home -> /var/home, a symlinked ~/dots).
    mkdir -p via/deeper && ln -s ../../kid via/deeper/kid
    OUT=$(rc --repo via/deeper/kid --machine work explain 2>&1) || fail "a child reached through a symlink loads: $OUT"
    ok "a child of a tool-folders parent loads through a symlinked path"
}

if command -v chezmoi >/dev/null 2>&1; then
    real_chezmoi_tests
else
    echo "skip 57-tool-folders-real-chezmoi: chezmoi isn't installed"
fi
