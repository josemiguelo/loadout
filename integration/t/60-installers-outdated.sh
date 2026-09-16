# Installers supply the mechanics; outdated asks their oracles and any
# custom [outdated.*] source; status reports script checks with detail.

# --- {pkg} substitution in install + check, probe, via shorthand ---------
mkdir -p instrepo/state instrepo/machines
cat > instrepo/manifest.toml <<'TOML'
[installers.fake]
probe = "sh"
install = "echo installed-{pkg} > fake-install.txt"
check = "test -f fake-install.txt && echo mytool 1.0"
regex = "mytool ([0-9.]+)"

[programs.mytool]
via = ["fake"]
TOML
printf '[pm]\nmytool = "fake"\n' > instrepo/machines/m1.toml
OUT=$("$BIN" --repo instrepo --machine m1 setup-new-machine --dry-run)
echo "$OUT" | grep -q "echo installed-mytool > fake-install.txt" || fail "installer pattern substitutes {pkg}"
"$BIN" --repo instrepo --machine m1 setup-new-machine --yes >/dev/null || fail "installer-backed install exits 0"
grep -q "installed-mytool" instrepo/fake-install.txt || fail "installer command ran"
grep -q '"version": "1.0"' instrepo/state/m1.json || fail "installer check observed the version"
ok "installers supply install/check/probe mechanics via {pkg}"

# --- outdated: each installer's oracle reports the remote candidate ------
cat > instrepo/manifest.toml <<'TOML'
[installers.fake]
probe = "sh"
install = "echo installed-{pkg} > fake-install.txt"
check = "test -f fake-install.txt && echo mytool 1.0"
outdated = "echo 2.0"
regex = "([0-9][0-9.]*)"

[installers.fake2]
probe = "sh"
install = "true"
check = "echo other 1.0"
outdated = "true"
regex = "([0-9][0-9.]*)"

[installers.fake3]
probe = "sh"
install = "true"
check = "echo batchtool 1.0"
outdated-all = "printf 'batchtool 3.0\\nuptodate 1.0\\n'"
regex = "([0-9][0-9.]*)"

[programs.mytool]
via = ["fake"]

[programs.othertool]
via = ["fake2"]

[programs.batchtool]
via = ["fake3"]

[programs.uptodate]
via = ["fake3"]
TOML
printf '[pm]\nmytool = "fake"\nothertool = "fake2"\nbatchtool = "fake3"\nuptodate = "fake3"\n' > instrepo/machines/m1.toml
"$BIN" --repo instrepo --machine m1 status >/dev/null || fail "status before outdated"
OUT=$("$BIN" --repo instrepo --machine m1 outdated) || fail "outdated exits 0"
echo "$OUT" | grep -qE "mytool +1.0 +-> 2.0" || fail "outdated reports the newer candidate"
echo "$OUT" | grep -q "othertool" && fail "up-to-date program must not be listed" || true
echo "$OUT" | grep -qE "batchtool +1.0 +-> 3.0" || fail "batch oracle (outdated-all) reports its candidate"
echo "$OUT" | grep -q "uptodate" && fail "batch-covered up-to-date program must not be listed" || true
# The doctor's line per tool: everything the batch oracle reported, and how
# much of it is in the loadout — the whole picture an upgrade would touch.
echo "$OUT" | grep -qE "sh +2 updates · 1 in your loadout" || fail "outdated leads with the tool's whole count (fake3's probe is sh)"
ok "outdated uses per-pkg oracles and installer-wide outdated-all batches"

# --- custom [outdated.*] sources: arbitrary rows, the source as the tag --
cat >> instrepo/manifest.toml <<'TOML'

[outdated.plugin-pins]
command = "printf 'javaplug aaa1111 bbb2222\n'"
TOML
OUT=$("$BIN" --repo instrepo --machine m1 outdated) || fail "outdated with custom source exits 0"
echo "$OUT" | grep -qE "javaplug +aaa1111 +-> bbb2222" || fail "custom source rows appear"
echo "$OUT" | grep -q "plugin-pins" || fail "custom source name is the row tag"
prog_line=$(echo "$OUT" | grep -n "mytool" | cut -d: -f1 | head -1)
custom_line=$(echo "$OUT" | grep -n "javaplug" | cut -d: -f1 | head -1)
[ "$prog_line" -lt "$custom_line" ] || fail "installer rows must sort before custom oracle rows"
ok "outdated includes custom [outdated.*] source rows, ordered after installers"

# A custom source that FAILS (non-zero exit) must fail LOUD, never masquerade
# as "nothing outdated" — loadout can't tell a crash from an empty result.
cat >> instrepo/manifest.toml <<'TOML'

[outdated.flaky]
command = "echo boom >&2; exit 3"
TOML
OUT=$("$BIN" --repo instrepo --machine m1 outdated) || fail "outdated with a failing source still exits 0"
echo "$OUT" | grep -qE "outdated source \[flaky\] failed: exited 3" || fail "failing custom source is surfaced loud"
echo "$OUT" | grep -q "boom" || fail "failing source shows its stderr detail"
echo "$OUT" | grep -q "│" || fail "a failing source is boxed, like other attention rows"
ok "outdated surfaces a failing custom [outdated.*] source instead of silence"

# A URL in a row's trailing note is lifted out as that row's PAGE — the
# home screen marks it ↗ and K opens it; here it must reach the output
# without eating the rest of the note.
cat >> instrepo/manifest.toml <<'TOML'

[outdated.linked-pins]
command = "printf 'jsplug aaa1111 bbb2222 1 commit behind https://example.test/compare/aaa1111...bbb2222\n'"
TOML
OUT=$("$BIN" --repo instrepo --machine m1 outdated) || fail "outdated with a linked source exits 0"
echo "$OUT" | grep -q "1 commit behind" || fail "the note survives having its URL lifted out"
echo "$OUT" | grep -q "https://example.test/compare/aaa1111...bbb2222" || fail "a URL in the note is printed as the row's page"
ok "a custom source's row keeps the page its note pointed at"

# --- status: script checks with their detail output, structured ---------
scripts_repo scriptsrepo
OUT=$("$BIN" --repo scriptsrepo --machine m1 setup-new-machine --dry-run)
echo "$OUT" | grep -qE "~ bootstrap-only +script" || fail "setup converges modes=[setup] scripts"
"$BIN" --repo scriptsrepo --machine m1 run bootstrap-only >/dev/null || fail "run ignores modes"
OUT=$("$BIN" --repo scriptsrepo --machine m1 status) || fail "status exits 0 even with pending scripts"
echo "$OUT" | grep -qE "bootstrap-only +done" || fail "status observes modes=[setup] scripts"
echo "$OUT" | grep -qE "healthy +done" || fail "status lists passing scripts"
echo "$OUT" | grep -qE "drifted +pending" || fail "status lists failing scripts"
echo "$OUT" | grep -q "missing: nodejs 16 npm firebase-tools" || fail "status surfaces the failing check's detail"
ok "status shows scripts with each failing check's detail"
