# Configs: chezmoi's units observed by status, compared by diff, written by
# apply and sync. A stub chezmoi answers from files in $CZ, so no real
# dotfiles are read or written.

CZ=$PWD/cz
mkdir -p "$CZ/bin" "$CZ/home"
cat > "$CZ/bin/chezmoi" <<'SH'
#!/bin/sh
# Stub: logs every call; answers managed/status/target-path from $CZ files;
# `apply` empties the status (everything applied) unless told to fail.
echo "$*" >> "$CZ/log"
[ -f "$CZ/absent" ] && { echo "sh: chezmoi: not found" >&2; exit 127; }
while [ $# -gt 0 ]; do
    case "$1" in
    --source) shift 2 ;;
    --no-pager) shift ;;
    *) break ;;
    esac
done
case "$1" in
managed) cat "$CZ/managed" ;;
status) cat "$CZ/status" ;;
target-path) echo "$CZ/home" ;;
apply)
    [ -f "$CZ/apply-fails" ] && { echo "chezmoi: .zshrc: template: boom" >&2; exit 1; }
    : > "$CZ/status" ;;
*) echo "stub chezmoi: unexpected $*" >&2; exit 2 ;;
esac
SH
chmod +x "$CZ/bin/chezmoi"
export CZ
cz_loadout() { PATH="$CZ/bin:$PATH" "$BIN" "$@"; }

printf '.config/zsh/.zshrc\n.config/zsh/conf.d/a.zsh\n.config/tmux/tmux.conf\n.zshenv\n' > "$CZ/managed"
printf ' M .config/zsh/.zshrc\n' > "$CZ/status"

basic_repo repo
printf 'configs = "configs"\n' >> repo/loadout.toml
mkdir -p repo/configs

# --- status ---------------------------------------------------------------
OUT=$(cz_loadout --repo repo --machine m1 status) || fail "status exits 0 with configs"
echo "$OUT" | grep -q "CONFIG" || fail "status has a configs section: $OUT"
echo "$OUT" | grep -qE "zsh +drifted" || fail "a unit with a file apply would change is drifted: $OUT"
echo "$OUT" | grep -q "\.config/zsh/\.zshrc" || fail "the drifted file is named: $OUT"
echo "$OUT" | grep -qE "tmux +applied" || fail "a unit with nothing to apply is applied: $OUT"
echo "$OUT" | grep -qE "\.zshenv +applied" || fail "a home-level file is its own unit: $OUT"
grep -q '"drifted"' repo/state/m1.json || fail "configs are written to the state file"
grep -q -- "--source $(cd repo && pwd)/configs" "$CZ/log" || fail "chezmoi reads [layout] configs as its source"
ok "status observes each config unit through chezmoi and writes it to state"

basic_repo plain
"$BIN" --repo plain --machine m1 status | grep -q "CONFIG" && fail "no configs section without [layout] configs" || true
grep -q '"configs"' plain/state/m1.json && fail "no configs key without [layout] configs" || true
ok "a repo without configs never asks chezmoi and writes no configs"

OUT=$(cz_loadout --repo repo --machine m1 explain zsh) || fail "explain a config exits 0"
echo "$OUT" | grep -q "config zsh" || fail "explain names the config: $OUT"
echo "$OUT" | grep -q "\.config/zsh/conf.d/a.zsh" || fail "explain lists its targets: $OUT"
ok "explain shows a config's targets and last verdict"

touch "$CZ/absent"
OUT=$(cz_loadout --repo repo --machine m1 status) || fail "status exits 0 without chezmoi"
echo "$OUT" | grep -qE "zsh +not checked" || fail "units last seen are not checked: $OUT"
echo "$OUT" | grep -q "configs not checked: chezmoi is not on PATH" || fail "says why, once: $OUT"
rm "$CZ/absent"
ok "without chezmoi the configs are not checked, and status says why"

# --- diff -----------------------------------------------------------------
cz_loadout --repo repo --machine m1 status >/dev/null
: > "$CZ/status"
cz_loadout --repo repo --machine m2 status >/dev/null
OUT=$(cz_loadout --repo repo diff) && fail "diff exits 1 when a config drifted"
echo "$OUT" | grep -qE "zsh +drifted \(1\) +applied" || fail "diff shows each machine's config verdict: $OUT"
echo "$OUT" | grep -q "1 config(s) drifted" || fail "diff counts drifted configs: $OUT"
ok "diff compares configs per machine and exits 1 on drift"

# --- apply ----------------------------------------------------------------
printf 'MM .config/zsh/.zshrc\n M .zshenv\n' > "$CZ/status"
: > "$CZ/log"
OUT=$(cz_loadout --repo repo --machine m1 apply 2>&1) && fail "apply refuses files edited here"
echo "$OUT" | grep -q "edited on this machine: .config/zsh/.zshrc" || fail "the edited file is named: $OUT"
grep -q " apply" "$CZ/log" && fail "nothing is applied after a refusal"
ok "apply stops on files edited on this machine, naming them"

OUT=$(cz_loadout --repo repo --machine m1 apply nope 2>&1) && fail "an unknown config is refused"
echo "$OUT" | grep -q "Unknown configs: nope" || fail "says which: $OUT"
ok "apply refuses a config that doesn't exist"

OUT=$(cz_loadout --repo repo --machine m1 apply --force zsh) || fail "apply --force exits 0: $OUT"
grep -q "apply --no-tty --force $CZ/home/.config/zsh/.zshrc $CZ/home/.config/zsh/conf.d/a.zsh$" "$CZ/log" ||
    fail "apply hands chezmoi the unit's targets: $(cat "$CZ/log")"
echo "$OUT" | grep -q "applied zsh" || fail "apply says what it applied: $OUT"
grep -q '"drifted"' repo/state/m1.json && fail "state is refreshed after apply"
ok "apply --force writes the named configs and refreshes state"

printf ' M .zshenv\n' > "$CZ/status"
touch "$CZ/apply-fails"
OUT=$(cz_loadout --repo repo --machine m1 apply 2>&1) && fail "a failing chezmoi apply exits 1"
echo "$OUT" | grep -q "error: chezmoi apply failed" || fail "says chezmoi failed: $OUT"
rm "$CZ/apply-fails"
ok "a failing chezmoi apply is an error"

# --- sync -----------------------------------------------------------------
# Committed while .zshenv is drifted, so the sync's apply changes the state.
cz_loadout --repo repo --machine m1 status >/dev/null
git -C repo add -A && git -C repo commit -qm "fixture"
printf 'MM .config/zsh/.zshrc\n' > "$CZ/status"
OUT=$(cz_loadout --repo repo --machine m1 sync 2>&1) && fail "sync stops on files edited here"
echo "$OUT" | grep -q "edited on this machine" || fail "sync says why: $OUT"
[ "$(git -C repo log --oneline | wc -l)" -eq 1 ] || fail "sync commits nothing after stopping"
ok "sync stops before committing when a config file was edited here"

printf ' M .zshenv\n' > "$CZ/status"
: > "$CZ/log"
cz_loadout --repo repo --machine m1 sync -m "m1: synced" >/dev/null || fail "sync exits 0"
sed -nE 's/^--source [^ ]+ --no-pager ([a-z-]+).*/\1/p' "$CZ/log" | tr '\n' ' ' | grep -q "^status apply managed status" ||
    fail "sync checks, applies, then observes: $(cat "$CZ/log")"
git -C repo log --oneline | grep -q "m1: synced" || fail "sync commits the state"
grep -q '"drifted"' repo/state/m1.json && fail "the committed state is after the apply"
ok "sync applies configs before refreshing and committing state"
