# diff compares the fleet; sync publishes this machine's state.

basic_repo repo
"$BIN" --repo repo --machine m1 run marker >/dev/null
"$BIN" --repo repo --machine m1 status >/dev/null
"$BIN" --repo repo --machine m2 status >/dev/null
"$BIN" --repo repo diff >/dev/null || fail "diff exits 0 when in sync"
ok "diff exits 0 when machines agree"

# A program in a file of its own, installed on both machines.
hcl_file repo/programs/missing.loadout.hcl <<'HCL'
program "definitely-not-installed-xyz" {
  version = "definitely-not-installed-xyz --version"
  regex   = "([0-9.]+)"
  custom "manual" {
    command = "false"
  }
}

machine "m1" {
  install = [variant(program.git, "manual"), program.definitely-not-installed-xyz]
  run     = [script.marker]
}

machine "m2" {
  install = [variant(program.git, "manual"), program.definitely-not-installed-xyz]
}
HCL
: > repo/machines/machines.loadout.hcl
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
    rm repo/machines/state/m1.json
    "$BIN" --repo repo --machine m1 sync -m "m1: test sync 2" >/dev/null || fail "sync exits 0 (retry)"
    git -C origin.git log --oneline | grep -q "m1: test sync 2" || fail "sync pushed to remote"
    ok "sync commits and pushes state"
}

OUT=$("$BIN" --repo repo --machine m1 sync)
echo "$OUT" | grep -q "nothing to commit" || fail "unchanged sync is a no-op"
ok "sync with unchanged state commits nothing"
echo "$OUT" | grep -q "1 program missing" || fail "sync names what's left to do: $OUT"
ok "sync ends naming what this machine still lacks"

# --- sync upgrades loadout when the pulled repo needs a newer one --------
# Offline: a fake curl answers the release check and the install script.
# The install replaces a copy of the binary with a stub that says how it
# was run, which is how the second sync is seen.
grep -q 'min_tool_version' repo/loadout.hcl && fail "fixture already declares a floor"
repo_attr repo/loadout.hcl 'min_tool_version = "999.0.0"'
grep -q 'min_tool_version = "999.0.0"' repo/loadout.hcl || fail "fixture floor not set"
compile_repo repo
git -C repo add -A && git -C repo commit -qm "floor" && git -C repo push -q 2>/dev/null
mkdir -p self fakecurl
cp "$BIN" self/loadout
cat > fakecurl/curl <<EOF2
#!/bin/sh
case "\$*" in
    *api.github.com*) printf '"tag_name": "v%s"\n' "\$(cat "$PWD/fakecurl/latest")" ;;
    *install.sh*) printf '%s\n' 'printf "#!/bin/sh\necho \\"new loadout: \\\$LOADOUT_SYNC_UPGRADED \\\$*\\"\n" > "$PWD/self/new" && chmod +x "$PWD/self/new" && mv "$PWD/self/new" "$PWD/self/loadout"' ;;
    *) exit 22 ;;
esac
EOF2
chmod +x fakecurl/curl
echo 998.0.0 > fakecurl/latest
OUT=$(PATH="$PWD/fakecurl:$PATH" self/loadout --repo repo --machine m1 sync -m "after floor" 2>&1) && fail "an unreleased floor can't be upgraded to"
echo "$OUT" | grep -q "requires loadout >= 999.0.0, but the latest release is 998.0.0" || fail "names the floor and the latest release: $OUT"
cmp -s self/loadout "$BIN" || fail "nothing is installed when no release is new enough"
ok "sync refuses a floor no release meets, installing nothing"

echo 999.0.0 > fakecurl/latest
OUT=$(PATH="$PWD/fakecurl:$PATH" self/loadout --repo repo --machine m1 sync -m "after floor" 2>&1) || fail "sync upgrades and carries on: $OUT"
echo "$OUT" | grep -q "needs loadout >= 999.0.0" || fail "says why it upgrades: $OUT"
echo "$OUT" | grep -q "new loadout: 1 --repo repo --machine m1 sync --message after floor" || fail "the new loadout runs the same sync: $OUT"
ok "sync upgrades loadout when the pulled repo needs it, then syncs with the new one"

OUT=$(LOADOUT_SYNC_UPGRADED=1 "$BIN" --repo repo --machine m1 sync 2>&1) && fail "a second upgrade must not start"
echo "$OUT" | grep -q "loadout was upgraded, but .* is still" || fail "says the upgrade didn't take: $OUT"
ok "a sync started by an upgrade never upgrades again"
