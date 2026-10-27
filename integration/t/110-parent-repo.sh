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
val child = repo(name = "work", state = "state")
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
[ -f work/state/work.json ] || fail "the child machine's state is in the child"
[ -e dots/state/work.json ] && fail "and never in the parent"
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
