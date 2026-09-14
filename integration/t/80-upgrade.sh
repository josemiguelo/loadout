# upgrade: whole mechanisms only, deduped by command; converge never upgrades.

mkdir -p uprepo/machines
cat > uprepo/manifest.toml <<'TOML'
[installers.pm]
install = "echo installing {pkg}"
upgrade = "echo upgrading all pm"
check = "echo {pkg} 1.0"
regex = "([0-9.]+)"

[installers.pm-extra]
install = "echo installing {pkg}"
upgrade = "echo upgrading all pm"
check = "echo {pkg} 1.0"
regex = "([0-9.]+)"

[installers.byhand]
install = "echo installing {pkg}"
check = "echo {pkg} 1.0"
regex = "([0-9.]+)"

[programs.alpha]
via = ["pm"]
[programs.bravo]
via = ["pm-extra"]
[programs.charlie]
via = ["byhand"]
TOML
printf '[pm]\nalpha = "pm"\nbravo = "pm-extra"\ncharlie = "byhand"\n' > uprepo/machines/m1.toml
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
