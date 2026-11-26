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

# What a command changes, and only that: every path, mode, link target and
# checksum under the scratch home and the stand-in /, before and after, with
# chezmoi's own state and cache left out.
snap() {
    (cd "$1" && find . \( -path ./.config/chezmoi -o -path ./.cache -o -path ./.local/state -o -path ./.local/share/chezmoi \
        -o -path ./var/lib/loadout -o -path ./var/cache/loadout \) -prune -o -print | LC_ALL=C sort |
        while IFS= read -r p; do
            if [ -L "$p" ]; then echo "$p link $(readlink "$p")"
            elif [ -d "$p" ]; then echo "$p dir $(stat -c '%a' "$p" 2>/dev/null || stat -f '%Lp' "$p")"
            else echo "$p file $(stat -c '%a' "$p" 2>/dev/null || stat -f '%Lp' "$p") $(cksum <"$p")"
            fi
        done)
}

# only_changes <what> <ERE of the paths it may change> <command…>: fails when
# the command fails, or changed anything else under the home or /. (A command
# that failed changed nothing, which proves nothing.)
only_changes() {
    local what=$1 allowed=$2 bad out
    shift 2
    snap "$H" >snap.h.before; snap "$R" >snap.r.before
    out=$("$@" 2>&1) || fail "$what failed: $out"
    snap "$H" >snap.h.after; snap "$R" >snap.r.after
    bad=$( { diff snap.h.before snap.h.after | sed 's|^|~ |'; diff snap.r.before snap.r.after | sed 's|^|/ |'; } |
        grep -E '^[~/] [<>]' | grep -vE "^[~/] [<>] ($allowed)( |\$)" || true)
    [ -z "$bad" ] || fail "$what changed what it wasn't pointed at:
$bad"
}

safety_tests() {
    local H="$PWD/shome" R="$PWD/sslash"
    mkdir -p "$H" "$R/etc"
    rc() { HOME="$H" XDG_CONFIG_HOME="$H/.config" XDG_DATA_HOME="$H/.local/share" XDG_STATE_HOME="$H/.local/state" LOADOUT_ROOT_DESTINATION="$R" "$BIN" "$@"; }

    basic_repo safe
    repo_opt safe/loadout.ts 'dotfiles: { tools: "tools/*", home: ".home", root: ".root" }'
    mkdir -p safe/tools/zsh/home/dot_config/zsh safe/tools/kb/root/etc/udev safe/tools/vpn/root/etc/vpn \
        safe/tools/sec/root/etc/private_secure/sub
    echo 'zshrc' > safe/tools/zsh/home/dot_config/zsh/dot_zshrc
    echo 'zshenv' > safe/tools/zsh/home/dot_zshenv
    echo 'rule' > safe/tools/kb/root/etc/udev/kb.rules
    echo 'vpn' > safe/tools/vpn/root/etc/vpn/vpn.conf
    echo 'x' > safe/tools/sec/root/etc/private_secure/sub/x.conf
    compile_repo safe
    rc --repo safe --machine m1 apply-config >/dev/null 2>&1 || fail "the first apply"

    # A bare relative path is a path: under ~/.config, zsh is ~/.config/zsh, not every / config.
    echo 'edited' >> "$H/.config/zsh/.zshrc"
    echo 'edited' >> "$R/etc/udev/kb.rules"
    only_changes "loadout chezmoi apply --force zsh, from ~/.config" '\./\.config/zsh(/.*)?' \
        sh -c "cd '$H/.config' && HOME='$H' XDG_CONFIG_HOME='$H/.config' XDG_DATA_HOME='$H/.local/share' XDG_STATE_HOME='$H/.local/state' LOADOUT_ROOT_DESTINATION='$R' '$BIN' --repo '$PWD/safe' --machine m1 chezmoi apply --force zsh"
    grep -q edited "$R/etc/udev/kb.rules" || fail "the / config it wasn't pointed at is as it was"
    ok "loadout chezmoi apply <relative path> applies that path, not every / config"

    # One tool's / config creates only its own folders.
    rm -r "$R/etc/vpn"
    only_changes "apply-config --force /kb" '\./etc/udev(/.*)?' rc --repo safe --machine m1 apply-config --force /kb
    [ ! -e "$R/etc/vpn" ] || fail "another tool's folder was created"
    ok "applying one tool's / config creates no other tool's folders"

    # An existing folder under one named private_ keeps its mode.
    chmod 770 "$R/etc/secure/sub"
    echo 'edited' >> "$R/etc/secure/sub/x.conf"
    only_changes "apply-config --force /sec" '\./etc/secure/sub/x\.conf' rc --repo safe --machine m1 apply-config --force /sec
    [ "$(stat -c '%a' "$R/etc/secure/sub" 2>/dev/null || stat -f '%Lp' "$R/etc/secure/sub")" = 770 ] || fail "the existing subfolder kept 0770"
    ok "an existing folder inside a private_ one keeps its mode"

    # Commands that would act on the repo or elsewhere are refused, flags in front or not.
    OUT=$(rc --repo safe chezmoi push 2>&1) && fail "push must be refused"
    echo "$OUT" | grep -q 'loadout chezmoi push:' || fail "push says why: $OUT"
    OUT=$(rc --repo safe chezmoi --color off update 2>&1) && fail "update behind a flag's value must be refused"
    echo "$OUT" | grep -q 'loadout chezmoi update: run: loadout sync' || fail "update says what to run: $OUT"
    OUT=$(rc --repo safe chezmoi --source /tmp diff 2>&1) && fail "--source must be refused"
    echo "$OUT" | grep -q -- '--source' || fail "--source says why: $OUT"
    ok "loadout chezmoi refuses push, a refused command behind a flag's value, and --source"

    # A folder path applies the / configs in it, the stand-in's own path too.
    echo 'edited' >> "$R/etc/udev/kb.rules"
    echo 'edited' >> "$R/etc/vpn/vpn.conf" 2>/dev/null || true
    only_changes "loadout chezmoi apply --force <folder>" '\./etc/udev(/.*)?' rc --repo safe --machine m1 chezmoi apply --force "$R/etc/udev"
    ! grep -q edited "$R/etc/udev/kb.rules" || fail "the folder's / config was applied"
    ok "loadout chezmoi apply <folder> applies the / configs in it, and nothing else"

    # re-add of a / file, root's state not this user's: as this user, over a copy.
    echo 'local tweak' >> "$R/etc/udev/kb.rules"
    chmod 444 "$R/var/lib/loadout/chezmoistate.boltdb"; chmod 555 "$R/var/lib/loadout"
    code=0; OUT=$(rc --repo safe --machine m1 chezmoi re-add "$R/etc/udev/kb.rules" 2>&1) || code=$?
    chmod 755 "$R/var/lib/loadout"; chmod 644 "$R/var/lib/loadout/chezmoistate.boltdb"
    [ $code -eq 0 ] || fail "re-add of a / file with root's state read-only: $OUT"
    grep -q 'local tweak' safe/tools/kb/root/etc/udev/kb.rules || fail "the / file's edit is in the tool's root/"
    ok "loadout chezmoi re-add of a / file works with root's state out of this user's reach"

    # edit: the tool's file, through a temporary copy that isn't a dangling hard link.
    printf '#!/bin/sh\necho "from the editor" >> "$1"\n' > editor.sh && chmod +x editor.sh
    OUT=$(EDITOR="$PWD/editor.sh" rc --repo safe --machine m1 chezmoi edit "$H/.zshenv" 2>&1) || fail "loadout chezmoi edit: $OUT"
    grep -q 'from the editor' safe/tools/zsh/home/dot_zshenv || fail "edit wrote the tool's file"
    [ -L safe/.home/dot_zshenv ] || fail "and the build's symlink stays"
    ok "loadout chezmoi edit edits the tool's file"

    # manage and unmanage are add and forget: carried over the same way.
    echo 'new' > "$H/.zprofile"
    OUT=$(rc --repo safe --machine m1 chezmoi manage --tool zsh "$H/.zprofile" 2>&1) || fail "manage --tool: $OUT"
    [ -f safe/tools/zsh/home/dot_zprofile ] || fail "manage put the file in the tool"
    OUT=$(rc --repo safe --machine m1 chezmoi unmanage --force "$H/.zprofile" 2>&1) || fail "unmanage: $OUT"
    [ ! -e safe/tools/zsh/home/dot_zprofile ] || fail "unmanage took it out of the tool"
    rc --repo safe --machine m1 explain git >/dev/null 2>&1 || fail "the repo loads after"
    ok "loadout chezmoi manage and unmanage carry over like add and forget"

    # An unknown --tool is refused before chezmoi writes anything.
    echo 'x' > "$H/.zzz"
    OUT=$(rc --repo safe --machine m1 chezmoi add --tool nope "$H/.zzz" 2>&1) && fail "an unknown --tool is refused"
    echo "$OUT" | grep -q 'no tool folder nope' || fail "and named: $OUT"
    rc --repo safe --machine m1 explain git >/dev/null 2>&1 || fail "nothing was left in the build"
    ok "loadout chezmoi add --tool <unknown> is refused before chezmoi writes anything"

    # From a child, apply covers the child's own configs, not its parent's /.
    local P; P=$(cd safe && pwd -P)
    ts_root kid "parent: { name: \"safe\", path: \"$P\" }" </dev/null
    repo_opt kid/loadout.ts 'dotfiles: { tools: "tools/*", home: ".home", root: ".root" }'
    mkdir -p kid/tools/work/home kid/tools/work/root/etc && echo 'work' > kid/tools/work/home/dot_workrc && echo 'w' > kid/tools/work/root/etc/work.conf
    ts_file kid/machines/work.loadout.ts <<'TS'
machine("work", {});
TS
    OUT=$("$BIN" --repo kid compile 2>&1) || fail "the child compiles: $OUT"
    echo 'edited' >> "$R/etc/udev/kb.rules"
    only_changes "loadout chezmoi apply, from a child" '\./\.workrc|\./etc/work\.conf' rc --repo kid --machine work chezmoi apply --force
    grep -q edited "$R/etc/udev/kb.rules" || fail "the parent's / config is as it was"
    ok "from a child, loadout chezmoi apply applies the child's configs, not its parent's /"
}

if command -v chezmoi >/dev/null 2>&1; then
    real_chezmoi_tests
    cd "$(new_work)" && safety_tests
else
    echo "skip 57-tool-folders-real-chezmoi: chezmoi isn't installed"
fi
