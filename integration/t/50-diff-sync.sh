# diff compares the fleet; sync publishes this machine's state.

basic_repo repo
"$BIN" --repo repo --machine m1 run marker >/dev/null
"$BIN" --repo repo --machine m1 status >/dev/null
"$BIN" --repo repo --machine m2 status >/dev/null
"$BIN" --repo repo diff >/dev/null || fail "diff exits 0 when in sync"
ok "diff exits 0 when machines agree"

cat >> repo/manifest.toml <<'TOML'

[programs.definitely-not-installed-xyz]
[programs.definitely-not-installed-xyz.version]
command = "definitely-not-installed-xyz --version"
regex = "([0-9.]+)"
[programs.definitely-not-installed-xyz.install.manual]
command = "false"
TOML
printf 'definitely-not-installed-xyz = "manual"\n' >> repo/machines/m1.toml
printf 'definitely-not-installed-xyz = "manual"\n' >> repo/machines/m2.toml
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
