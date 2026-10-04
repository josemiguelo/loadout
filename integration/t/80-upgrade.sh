# upgrade: whole mechanisms only, deduped by command; converge never upgrades.

mkdir -p uprepo/machines
cat > uprepo/loadout.yaml <<'YAML'
installers:
  pm:
    install: 'echo installing {pkg}'
    upgrade: 'echo upgrading all pm'
    check: 'echo {pkg} 1.0'
    regex: '([0-9.]+)'
  pm-extra:
    install: 'echo installing {pkg}'
    upgrade: 'echo upgrading all pm'
    check: 'echo {pkg} 1.0'
    regex: '([0-9.]+)'
  byhand:
    install: 'echo installing {pkg}'
    check: 'echo {pkg} 1.0'
    regex: '([0-9.]+)'

programs:
  alpha:
    via: [pm]
  bravo:
    via: [pm-extra]
  charlie:
    via: [byhand]
YAML
add_layout "uprepo"
printf 'alpha:\n  install_with: pm\nbravo:\n  install_with: pm-extra\ncharlie:\n  install_with: byhand\n' > uprepo/machines/m1.yaml
OUT=$("$BIN" --repo uprepo --machine m1 upgrade --all --dry-run)
# Mechanisms sharing a command are ONE transaction, not one per installer.
[ "$(echo "$OUT" | grep -c "echo upgrading all pm")" = "1" ] || fail "mechanisms sharing a command run once"
echo "$OUT" | grep -q "pm, pm-extra" || fail "the shared step names every mechanism it covers"
echo "$OUT" | grep -q "byhand" && fail "an installer with no upgrade command must not be planned" || true
OUT=$("$BIN" --repo uprepo --machine m1 upgrade alpha --dry-run 2>&1 || true)
echo "$OUT" | grep -q "upgrades are whole-mechanism" || fail "naming a program points at its mechanism"
"$BIN" --repo uprepo --machine m1 upgrade >/dev/null 2>&1 && fail "upgrade with no target should fail" || true
# Converge still never upgrades: that separation is the whole point.
"$BIN" --repo uprepo --machine m1 status >/dev/null
OUT=$("$BIN" --repo uprepo --machine m1 install --all --dry-run)
echo "$OUT" | grep -qi "upgrad" && fail "install must not mention upgrading" || true
ok "upgrade runs whole mechanisms, deduped by command; converge still doesn't"

# --item: one item of a custom outdated: source at a time — what the home
# screen hands off when you tick a tmux plugin or a pinned tool. Alone, or
# beside whole mechanisms in the same run.
mkdir -p irepo/machines irepo/state
cat > irepo/loadout.yaml <<'YAML'
installers:
  pm:
    install: 'echo installing {pkg}'
    upgrade: 'echo swept > swept.txt'
    check: 'echo {pkg} 1.0'
    regex: '([0-9.]+)'

programs:
  alpha:
    via: [pm]

outdated:
  plugins:
    command: 'echo ''tpack aaa bbb'''
    upgrade: 'echo pulled > pulled-{item}.txt'
  readonly:
    command: 'echo ''x 1 2'''
YAML
add_layout "irepo"
printf 'alpha:\n  install_with: pm\n' > irepo/machines/m1.yaml
"$BIN" --repo irepo --machine m1 upgrade --item plugins/tpack --item plugins/other --yes >/dev/null
[ -f irepo/pulled-tpack.txt ] && [ -f irepo/pulled-other.txt ] || fail "--item upgrades each named item of its source"
[ -f irepo/swept.txt ] && fail "--item alone must not sweep any mechanism" || true
"$BIN" --repo irepo --machine m1 upgrade pm --item plugins/tpack --yes >/dev/null
[ -f irepo/swept.txt ] || fail "installers and items run together"
OUT=$("$BIN" --repo irepo --machine m1 upgrade --item nosuch/x --yes 2>&1 || true)
echo "$OUT" | grep -q "Unknown outdated source 'nosuch'" || fail "an unknown source is refused by name"
OUT=$("$BIN" --repo irepo --machine m1 upgrade --item tpack --yes 2>&1 || true)
echo "$OUT" | grep -q "<source>/<name>" || fail "--item without a source says the form"
OUT=$("$BIN" --repo irepo --machine m1 upgrade --item readonly/x --yes 2>&1 || true)
echo "$OUT" | grep -q "declares no upgrade command" || fail "a read-only source is refused"
ok "upgrade --item moves single items of a custom source, alone or beside mechanisms"
