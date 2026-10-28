# Child repos (contract 18): a repo whose machines use a parent repo's
# programs, scripts and profiles by name. The parent is basic_repo plus a
# script that says where it ran; the child declares one machine that
# installs the parent's git, runs a script of each repo, and installs a
# program of its own.

basic_repo dots
kt_file dots/programs/where.loadout.kt <<'KT'
val whereParent = root.script(name = "where-parent") {
    run("printf '%s|%s|%s\\n' \"\$LOADOUT_REPO\" \"\$PWD\" \"\$LOADOUT_PARENT\" > \"\$WHERE_OUT/parent.txt\"")
    check("test -f \"\$WHERE_OUT/parent.txt\"")
}
KT
compile_repo dots
PARENT=$(cd dots && pwd -P)

# <dir>: the child of dots, compiled for real (its lock depends on the
# parent's sources too, which compile_repo's cache key doesn't see).
child_repo() {
    kt_repo "$1"
    rm -f "$1/loadout.kt"
    cat > "$1/build.gradle.kts" <<KTS
plugins {
    id("io.github.josemiguelo.loadout")
}

loadout {
    parent(name = "dots", path = "$PARENT")
    sources(
        "child.kt",
        "machines/**/*.loadout.kt",
    )
}
KTS
    kt_file "$1/child.kt" <<'KT'
val child = repo(name = "work", state = "machines/state")
KT
    kt_file "$1/machines/work.loadout.kt" <<'KT'
val worktool = root.program(name = "worktool") {
    version(command = "echo worktool 1.0", regex = "worktool ([0-9.]+)")
    custom(name = "manual") {
        command = "true"
    }
}

val forgotten = root.program(name = "forgotten") {
    custom(name = "manual") {
        command = "true"
    }
}

val whereChild = root.script(name = "where-child") {
    run("printf '%s|%s|%s\\n' \"\$LOADOUT_REPO\" \"\$PWD\" \"\$LOADOUT_PARENT\" > \"\$WHERE_OUT/child.txt\"")
    check("test -f \"\$WHERE_OUT/child.txt\"")
}

val work = machine(hostname = "work") {
    install(git.variant(name = "manual"), worktool)
    run(whereParent, whereChild)
}
KT
}

# --- compile -----------------------------------------------------------------
child_repo work
OUT=$("$BIN" --repo work compile 2>&1) || fail "a child compiles against its parent: $OUT"
LOCK=work/loadout.lock.json
grep -q '"parent": {' "$LOCK" && grep -q '"name": "dots"' "$LOCK" || fail "the lock names the parent: $(cat "$LOCK")"
grep -q '"origin": "parent:' "$LOCK" || fail "the parent's declarations carry parent: origins"
grep -q '"work": {' "$LOCK" || fail "the child's machine is in the lock"
grep -qE '"m[12]": \{' "$LOCK" && fail "the parent's machines are not in the child's lock"
echo "$OUT" | grep -q "program 'forgotten' isn't installed on any machine" || fail "the child's own unused program is reported: $OUT"
echo "$OUT" | grep -q "warning:.*'marker'" && fail "the parent's declarations are the parent's to judge: $OUT"
ok "a child repo compiles against its parent: the lock names it, holds the child's machines only, and warns about the child's own"

# --- run: each repo's command in its own checkout ---------------------------
mkdir -p where
WHERE_OUT=$PWD/where
export WHERE_OUT
CHILD=$(cd work && pwd -P)
OUT=$("$BIN" --repo work --machine work run where-parent where-child 2>&1) || fail "the child runs both repos' scripts: $OUT"
[ "$(cat where/parent.txt)" = "$PARENT|$PARENT|$PARENT" ] ||
    fail "a parent's script runs in the parent with the parent's LOADOUT_REPO: $(cat where/parent.txt)"
[ "$(cat where/child.txt)" = "$CHILD|$CHILD|$PARENT" ] ||
    fail "a child's script runs in the child, and sees LOADOUT_PARENT: $(cat where/child.txt)"
OUT=$("$BIN" --repo work --machine work status 2>&1) || fail "status runs in a child: $OUT"
echo "$OUT" | grep -q "worktool" && echo "$OUT" | grep -q "git" || fail "status shows both repos' programs: $OUT"
OUT=$("$BIN" --repo work --machine work explain where-parent 2>&1) || fail "explain names a parent's script: $OUT"
echo "$OUT" | grep -qE "from +parent dots \(its root\)" || fail "explain says the script is the parent's: $OUT"
OUT=$("$BIN" --repo work --machine work explain 2>&1)
echo "$OUT" | grep -qE "parent +dots \($PARENT\)" || fail "explain's machine block names the parent: $OUT"
[ -f work/machines/state/work.json ] || fail "the child machine's state is in the child"
[ -e dots/machines/state/work.json ] && fail "and never in the parent"
ok "a parent's command runs in the parent's checkout with its LOADOUT_REPO; a child's in the child"

# --- staleness and a missing parent -----------------------------------------
cp dots/programs/where.loadout.kt where.bak
printf '\n// edited\n' >> dots/programs/where.loadout.kt
OUT=$("$BIN" --repo work --machine work status 2>&1) && fail "a parent edit the child hasn't compiled must be refused"
echo "$OUT" | grep -q "parent dots: the manifests changed since loadout.lock.json was written — run: loadout compile" ||
    fail "the parent edit is named: $OUT"
OUT=$("$BIN" --repo work compile 2>&1) && fail "a child can't compile against a parent whose own lock is stale"
echo "$OUT" | grep -q "parent dots: loadout.lock.json is older than its manifests — run: loadout compile there first" ||
    fail "the stale parent lock is named: $OUT"
cp where.bak dots/programs/where.loadout.kt
"$BIN" --repo work --machine work status >/dev/null 2>&1 || fail "the parent restored, the child loads again"
mv dots dots.away
OUT=$("$BIN" --repo work --machine work status 2>&1) && fail "a missing parent must be refused"
echo "$OUT" | grep -q "parent dots is not at $PARENT — clone it there" || fail "the missing parent is named with its path: $OUT"
mv dots.away dots
ok "a parent edit, a stale parent lock and a missing parent are each refused by name"

# --- one name, two repos ------------------------------------------------------
cat >> work/machines/work.loadout.kt <<'KT'

val git2 = root.program(name = "git") {
    custom(name = "manual") {
        command = "true"
    }
}
KT
OUT=$("$BIN" --repo work compile 2>&1) && fail "a name both repos declare must be refused"
echo "$OUT" | grep -q "program 'git' is declared by parent dots too" || fail "the clash names the parent: $OUT"
ok "a program both repos declare is refused, naming the parent"

# --- configs: the parent's source and the child's ---------------------------
# A stub chezmoi that answers per source (the --source folder's own files),
# logs every call with the LOADOUT_REPO and LOADOUT_MACHINE it saw.
sed -i.bak '/^val git2 = /,$d' work/machines/work.loadout.kt && rm -f work/machines/work.loadout.kt.bak
CZ=$PWD/cz
mkdir -p "$CZ/bin"
cat > "$CZ/bin/chezmoi" <<'SH'
#!/bin/sh
src=
while [ $# -gt 0 ]; do
    case "$1" in
    --source) src=$2; shift 2 ;;
    --no-pager) shift ;;
    *) break ;;
    esac
done
# A source folder that isn't there fails, as chezmoi's stat does.
[ -z "$src" ] || [ -d "$src" ] || { echo "chezmoi: stat $src: no such file or directory" >&2; exit 1; }
echo "$(basename "$(dirname "$src")") $* repo=$LOADOUT_REPO machine=$LOADOUT_MACHINE" >> "$CZ/log"
case "$1" in
managed) cat "$src/.stub-managed" 2>/dev/null || true ;;
status) cat "$src/.stub-status" 2>/dev/null || true ;;
target-path) echo "$CZ/home" ;;
apply) : > "$src/.stub-status" ;;
*) echo "stub chezmoi: unexpected $*" >&2; exit 2 ;;
esac
SH
chmod +x "$CZ/bin/chezmoi"
export CZ
cz_loadout() { PATH="$CZ/bin:$PATH" "$BIN" "$@"; }

sed -i.bak 's|state = "machines/state",|state = "machines/state", configs = "configs",|' dots/loadout.kt && rm dots/loadout.kt.bak
grep -q 'configs = "configs"' dots/loadout.kt || fail "the parent fixture declares configs"
mkdir -p dots/configs
"$BIN" --repo dots compile >/dev/null 2>&1 || fail "the parent compiles with configs"
sed -i.bak 's|repo(name = "work", state = "machines/state")|repo(name = "work", state = "machines/state", configs = "configs")|' work/child.kt && rm work/child.kt.bak
mkdir -p work/configs
OUT=$("$BIN" --repo work compile 2>&1) || fail "the child compiles with configs: $OUT"
[ "$(grep -c '"configs": "configs"' work/loadout.lock.json)" = 2 ] || fail "the child's lock records its configs and the parent's"
printf '.config/zsh/.zshrc\n.zshenv\n' > dots/configs/.stub-managed
printf '.config/zsh/conf.d/zz-work.zsh\n' > work/configs/.stub-managed
printf ' M .config/zsh/conf.d/zz-work.zsh\n' > work/configs/.stub-status
OUT=$(cz_loadout --repo work --machine work status 2>&1) || fail "status reads both sources: $OUT"
echo "$OUT" | grep -qE "zsh +drifted" || fail "a unit spanning both repos drifts when the child's file would change: $OUT"
echo "$OUT" | grep -qE "\.zshenv +applied" || fail "the parent's unit is there too: $OUT"
grep -q "dots managed .* repo=$CHILD machine=work" "$CZ/log" || fail "chezmoi sees the child as LOADOUT_REPO and the machine: $(cat "$CZ/log")"
: > "$CZ/log"
cz_loadout --repo work --machine work apply >/dev/null 2>&1 || fail "apply runs over both sources"
grep -n ' apply ' "$CZ/log" | head -1 | grep -q '^[0-9]*:dots apply' || fail "the parent's source applies first: $(cat "$CZ/log")"
grep -q '^work apply' "$CZ/log" || fail "then the child's: $(cat "$CZ/log")"
ok "a child's configs are its parent's and its own: units span both, chezmoi sees the child, the parent applies first"

printf '.config/git/config\n' >> work/configs/.stub-managed
printf '.config/git/config\n' >> dots/configs/.stub-managed
OUT=$(cz_loadout --repo work --machine work status 2>&1)
echo "$OUT" | grep -q ".config/git/config is managed by parent dots and this repo — a file belongs to one repo" ||
    fail "a file both repos manage is named in status: $OUT"
OUT=$(cz_loadout --repo work --machine work apply git 2>&1) && fail "applying a file both repos manage must be refused"
echo "$OUT" | grep -q "a file belongs to one repo" || fail "and apply says why: $OUT"
ok "a file both repos manage is reported and refused, naming both"

# --- the fleet, and the parent left alone -------------------------------------
sed -i.bak '/^\.config\/git\/config$/d' work/configs/.stub-managed && rm work/configs/.stub-managed.bak
OUT=$(cz_loadout --repo dots --machine m1 status 2>&1); [ -f dots/machines/state/m1.json ] || fail "the parent records its own machine: $OUT"
OUT=$(cz_loadout --repo work --machine work diff 2>&1) || fail "diff runs in a child: $OUT"
echo "$OUT" | grep -q "work" && echo "$OUT" | grep -q "m1" || fail "the fleet is the parent's machines and the child's: $OUT"
ok "a child's diff shows its machines beside the parent's"

# Every file under the parent, as it is now (the stub's bookkeeping aside).
snapshot() { (cd dots && find . -type f ! -name '.stub-*' | LC_ALL=C sort | while read -r f; do printf '%s ' "$f"; cksum < "$f"; done); }
snapshot > parent.before
"$BIN" --repo work compile >/dev/null 2>&1 || fail "the child compiles"
for args in "status" "explain" "explain git" "run where-child" "apply" "diff" "outdated"; do
    # shellcheck disable=SC2086
    cz_loadout --repo work --machine work $args >/dev/null 2>&1 || true
done
snapshot > parent.after
cmp -s parent.before parent.after || fail "no command run on the child writes into the parent: $(diff parent.before parent.after)"
ok "compile, status, explain, run, apply, diff and outdated on a child leave every file of the parent as it was"

# --- sync: pull the parent, recompile on its change, push the child only ------
gitid() { git -C "$1" config user.email test@example.com && git -C "$1" config user.name "Integration Test"; }
for repo in dots work; do
    git -C "$repo" init -q
    gitid "$repo"
    git -C "$repo" add -A
    git -C "$repo" commit -qm "initial" >/dev/null
    git init -q --bare "$repo.git"
    git -C "$repo" remote add origin "$PWD/$repo.git"
    git -C "$repo" push -q -u origin HEAD 2>/dev/null
done
# Someone changes the parent elsewhere: a new script, compiled and pushed.
git clone -q dots.git dots-elsewhere
gitid dots-elsewhere
kt_file dots-elsewhere/programs/later.loadout.kt <<'KT'
val later = root.script(name = "later") {
    run("true")
    check("true")
}
KT
"$BIN" --repo dots-elsewhere compile >/dev/null 2>&1 || fail "the parent's change compiles"
git -C dots-elsewhere add -A && git -C dots-elsewhere commit -qm "a later script" && git -C dots-elsewhere push -q 2>/dev/null
PARENT_HEAD=$(git -C dots.git rev-parse HEAD)
OUT=$(cz_loadout --repo work --machine work sync 2>&1) || fail "sync pulls the parent and recompiles the child: $OUT"
echo "$OUT" | grep -q "parent dots changed: compiling" || fail "sync says it recompiles: $OUT"
grep -q '"later"' work/loadout.lock.json || fail "the child's lock has the parent's new script"
git -C work.git log -1 --name-only --format=%s | grep -q "loadout.lock.json" || fail "the lock is committed and pushed with the state: $(git -C work.git log -1 --name-only)"
[ "$(git -C dots.git rev-parse HEAD)" = "$PARENT_HEAD" ] || fail "the child never pushes the parent"
[ -z "$(git -C dots status --porcelain)" ] || fail "nor leaves anything in the parent's checkout: $(git -C dots status --porcelain)"
[ "$(git -C dots rev-parse HEAD)" = "$PARENT_HEAD" ] || fail "the parent's checkout is at what was pulled"
ok "a child's sync pulls its parent, recompiles when the parent changed, and commits and pushes only itself"

# The parent renames its configs folder: the child's sync recompiles and
# applies from the new folder, not the one its lock named before the pull.
git -C dots-elsewhere pull -q
git -C dots-elsewhere mv configs dotfiles
sed -i.bak 's|configs = "configs"|configs = "dotfiles"|' dots-elsewhere/loadout.kt && rm dots-elsewhere/loadout.kt.bak
"$BIN" --repo dots-elsewhere compile >/dev/null 2>&1 || fail "the parent's rename compiles"
git -C dots-elsewhere add -A && git -C dots-elsewhere commit -qm "configs is dotfiles now" && git -C dots-elsewhere push -q 2>/dev/null
: > "$CZ/log"
OUT=$(cz_loadout --repo work --machine work sync 2>&1) || fail "a child's sync applies from the folder its parent renamed: $OUT"
grep -q '"configs": "dotfiles"' work/loadout.lock.json || fail "the child's lock names the parent's new folder"
grep -q '^dots apply' "$CZ/log" || fail "the parent's source is applied: $(cat "$CZ/log")"
ok "a child's sync applies from a configs folder its parent renamed"

# The parent raises the floor: the child's sync compiles against it, then
# upgrades, and the sync the upgrade starts is told the lock was compiled.
# Offline, as in 50-diff-sync: a fake curl answers the release check and an
# install that swaps a copy of the binary for a stub saying how it was run.
git -C dots-elsewhere pull -q
sed -i.bak 's/repo(name = \([^,]*\),/repo(name = \1, minToolVersion = "999.0.0",/' dots-elsewhere/loadout.kt && rm dots-elsewhere/loadout.kt.bak
"$BIN" --repo dots-elsewhere compile >/dev/null 2>&1 || fail "the parent's floor compiles"
git -C dots-elsewhere add -A && git -C dots-elsewhere commit -qm "floor" && git -C dots-elsewhere push -q 2>/dev/null
mkdir -p self fakecurl
cp "$BIN" self/loadout
cat > fakecurl/curl <<EOF2
#!/bin/sh
case "\$*" in
    *api.github.com*) echo '"tag_name": "v999.0.0"' ;;
    *install.sh*) printf '%s\n' 'printf "#!/bin/sh\necho \\"new loadout: \\\$LOADOUT_SYNC_UPGRADED \\\$LOADOUT_SYNC_RECOMPILED\\"\n" > "$PWD/self/new" && chmod +x "$PWD/self/new" && mv "$PWD/self/new" "$PWD/self/loadout"' ;;
    *) exit 22 ;;
esac
EOF2
chmod +x fakecurl/curl
OUT=$(PATH="$CZ/bin:$PWD/fakecurl:$PATH" self/loadout --repo work --machine work sync 2>&1) || fail "the child's sync compiles, then upgrades: $OUT"
echo "$OUT" | grep -q "parent dots changed: compiling" || fail "it compiles first: $OUT"
echo "$OUT" | grep -q "new loadout: 1 1" || fail "the upgraded sync is told the lock was compiled: $OUT"
ok "a child's sync that compiles and then upgrades tells the next sync it compiled"

# That next sync finds the lock compiled (parent unchanged since) and commits
# it with the state.
git -C dots-elsewhere pull -q
sed -i.bak 's/ minToolVersion = "999.0.0",//' dots-elsewhere/loadout.kt && rm dots-elsewhere/loadout.kt.bak
"$BIN" --repo dots-elsewhere compile >/dev/null 2>&1 || fail "the parent drops its floor"
git -C dots-elsewhere add -A && git -C dots-elsewhere commit -qm "no floor" && git -C dots-elsewhere push -q 2>/dev/null
git -C dots pull -q
"$BIN" --repo work compile >/dev/null 2>&1 || fail "the child compiles against it, as the sync before the upgrade did"
OUT=$(LOADOUT_SYNC_UPGRADED=1 LOADOUT_SYNC_RECOMPILED=1 cz_loadout --repo work --machine work sync 2>&1) || fail "the upgraded sync runs: $OUT"
echo "$OUT" | grep -q "parent dots changed: compiling" && fail "nothing is compiled again: $OUT"
git -C work.git log -1 --name-only --format=%s | grep -q "loadout.lock.json" || fail "the lock is committed and pushed with the state: $(git -C work.git log -1 --name-only)"
[ -z "$(git -C work status --porcelain -- loadout.lock.json)" ] || fail "and nothing of it is left behind: $(git -C work status --porcelain)"
ok "the sync an upgrade starts commits the lock the sync before it compiled"
