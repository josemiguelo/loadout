# --repo pointed at a linked worktree (bare-repo-plus-worktree layout, e.g.
# via workmux), and at the bare root itself.

worktree_repo bare.git wt

# --- status/run/diff behave the same as a plain clone --------------------
"$BIN" --repo wt --machine m1 status >/dev/null || fail "status exits 0 against a worktree path"
grep -q '"status": "installed"' wt/state/m1.json || fail "status observes git from inside the worktree"
grep -q '"status": "pending"' wt/state/m1.json || fail "the unrun script is observed from inside the worktree"
ok "status works against a worktree path"

"$BIN" --repo wt --machine m1 run marker >/dev/null || fail "run exits 0 against a worktree path"
[ -f wt/marker.txt ] || fail "run executed the script inside the worktree"
ok "run works against a worktree path"

"$BIN" --repo wt --machine m2 status >/dev/null || fail "status (m2) exits 0 against a worktree path"
"$BIN" --repo wt diff >/dev/null || fail "diff exits 0 against a worktree path"
ok "diff works against a worktree path"

# --- sync: commit + push to a real remote, from the worktree -------------
git -C wt add -A
git -C wt commit -qm "manifest + state"
git init -q --bare origin.git
git -C wt remote add origin "$PWD/origin.git"
branch=$(git -C wt symbolic-ref --short HEAD)
git -C wt push -qu origin "$branch"

"$BIN" --repo wt --machine m1 sync -m "m1: worktree sync" >/dev/null || fail "sync exits 0 against a worktree path"
git -C origin.git log --oneline "$branch" | grep -q "m1: worktree sync" || {
    # State may have been unchanged; force a change and retry.
    rm -f wt/state/m1.json
    "$BIN" --repo wt --machine m1 sync -m "m1: worktree sync 2" >/dev/null || fail "sync exits 0 (retry)"
    git -C origin.git log --oneline "$branch" | grep -q "m1: worktree sync 2" || fail "sync pushed to the remote"
}
ok "sync commits and pushes from a worktree path, same as a plain clone"

# --- --repo pointed at the BARE root itself (no working tree) ------------
# No worktree there means no manifest.toml file either; this isn't a gap
# loadRepo needs a special case for — it already refuses a missing
# manifest with a clean one-liner (contract 9), bare root or not.
OUT=$("$BIN" --repo bare.git status 2>&1) && fail "status against the bare root should fail" || true
echo "$OUT" | grep -qx "error: Manifest not found: bare.git/manifest.toml" ||
    fail "bare-root error should be the same clean one-liner as any directory with no manifest.toml"
echo "$OUT" | grep -qi "Uncaught Kotlin exception" && fail "bare-root must not leak a raw stack trace" || true
[ "$(printf '%s\n' "$OUT" | wc -l)" -eq 1 ] || fail "bare-root error should be exactly one line"
ok "--repo at the bare root fails with the same clean one-liner as a missing manifest, not a stack trace"
