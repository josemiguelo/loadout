# diff compares the fleet; sync publishes this machine's state.

basic_repo repo
"$BIN" --repo repo --machine m1 run marker >/dev/null
"$BIN" --repo repo --machine m1 status >/dev/null
"$BIN" --repo repo --machine m2 status >/dev/null
"$BIN" --repo repo diff >/dev/null || fail "diff exits 0 when in sync"
ok "diff exits 0 when machines agree"

# A program in a file of its own, installed on both machines.
kt_file repo/programs/missing.loadout.kt <<'KT'
val notInstalled = root.program("definitely-not-installed-xyz") {
    version("definitely-not-installed-xyz --version", "([0-9.]+)")
    custom("manual") { command = "false" }
}

val m1 = machine("m1") {
    install(git.variant("manual"), notInstalled)
    run(marker)
}

val m2 = machine("m2") { install(git.variant("manual"), notInstalled) }
KT
cat > repo/machines.loadout.kt <<'KT'
package repo
KT
compile_repo repo
"$BIN" --repo repo --machine m1 status >/dev/null
"$BIN" --repo repo --machine m2 status >/dev/null
"$BIN" --repo repo diff >/dev/null 2>&1 && fail "diff should exit 1 on missing" || true
OUT=$("$BIN" --repo repo diff || true)
echo "$OUT" | grep -q "missing" || fail "diff shows missing"
ok "diff exits 1 and reports missing programs"

OUT=$("$BIN" --repo repo diff --machines m1 || true)
echo "$OUT" | grep -q "m2" && fail "--machines filter leaked m2" || true
ok "diff --machines filters columns"

# --- sync ---------------------------------------------------------------
git -C repo add -A && git -C repo commit -qm "manifest + state"
git init -q --bare origin.git
git -C repo remote add origin "$PWD/origin.git"
git -C repo push -qu origin HEAD 2>/dev/null

"$BIN" --repo repo --machine m1 sync -m "m1: test sync" >/dev/null || fail "sync exits 0"
git -C origin.git log --oneline | grep -q "m1: test sync" && ok "sync commits and pushes state" || {
    # State may have been unchanged; force a change and retry.
    rm repo/state/m1.json
    "$BIN" --repo repo --machine m1 sync -m "m1: test sync 2" >/dev/null || fail "sync exits 0 (retry)"
    git -C origin.git log --oneline | grep -q "m1: test sync 2" || fail "sync pushed to remote"
    ok "sync commits and pushes state"
}

OUT=$("$BIN" --repo repo --machine m1 sync)
echo "$OUT" | grep -q "nothing to commit" || fail "unchanged sync is a no-op"
ok "sync with unchanged state commits nothing"
