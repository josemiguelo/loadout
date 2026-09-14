# init scaffolding, and what a scaffolded repo already knows.

"$BIN" init repo >/dev/null || fail "init exits 0"
[ -f repo/manifest.toml ] || fail "init creates manifest"
[ -d repo/scripts ] && [ -d repo/state ] && [ -d repo/machines ] && [ -d repo/manifest.d ] || fail "init creates dirs"
[ -f repo/machines/example.toml.sample ] || fail "init creates machine example"
[ -f repo/manifest.d/example.toml.sample ] || fail "init creates fragment example"
[ -f repo/manifest.d/00_installers.toml ] && fail "init must not scaffold installers (they ship with loadout)" || true
# .sample files must not be picked up by the loader
"$BIN" --repo repo status >/dev/null || fail "samples must not break loading"
git -C repo rev-parse --is-inside-work-tree >/dev/null || fail "init git-inits"
ok "init scaffolds a repo"

"$BIN" init repo >/dev/null 2>&1 && fail "init refuses to overwrite" || true
ok "init refuses to overwrite an existing manifest"

# --- an unreadable state file is a warning, not a crash ------------------
printf '{ this is not json' > repo/state/m1.json
OUT=$("$BIN" --repo repo --machine m1 status --no-write 2>&1) || fail "status survives a corrupt state file"
echo "$OUT" | grep -q "not readable state" || fail "a corrupt state file warns"
echo "$OUT" | grep -qi "Uncaught Kotlin exception" && fail "a corrupt state file must not crash" || true
OUT=$("$BIN" --repo repo --machine m1 diff 2>&1 || true)
echo "$OUT" | grep -q "not readable state" || fail "diff warns about a corrupt state file instead of hiding it"
rm -f repo/state/m1.json
"$BIN" --repo repo --machine m1 status >/dev/null || fail "status rewrites the state file"
ok "an unreadable state file warns and is skipped, never a stack trace"

# --- built-in installers -------------------------------------------------
OUT=$("$BIN" --repo repo installers) || fail "installers exits 0"
echo "$OUT" | grep -q "dnf" || fail "installers lists the built-in dnf"
echo "$OUT" | grep -q "dnf-repo" || fail "installers lists the parameterized dnf-repo"
echo "$OUT" | grep -q "built-in" || fail "installers marks built-ins"
OUT=$("$BIN" --repo repo installers dnf)
echo "$OUT" | grep -q "rpm -q {pkg}" || fail "installers <name> shows the definition"
"$BIN" --repo repo installers ghost-installer >/dev/null 2>&1 && fail "unknown installer should fail" || true
# The scaffold declares no installers, yet `via` resolves against the library.
OUT=$("$BIN" --repo repo explain ripgrep)
echo "$OUT" | grep -q "sudo dnf install -y ripgrep" || fail "via resolves to a built-in installer"
echo "$OUT" | grep -q "installer: dnf (built-in)" || fail "explain marks a built-in installer"
ok "installers ship with loadout and resolve without being declared"

"$BIN" --repo repo installers --eject >/dev/null || fail "installers --eject exits 0"
[ -f repo/manifest.d/00_installers.toml ] || fail "--eject writes the fragment"
"$BIN" --repo repo installers --eject >/dev/null 2>&1 && fail "--eject must not clobber" || true
"$BIN" --repo repo installers --eject --force >/dev/null || fail "--eject --force overwrites"
OUT=$("$BIN" --repo repo explain ripgrep)
echo "$OUT" | grep -q "installer: dnf (repo)" || fail "an ejected installer is the repo's"
ok "installers --eject hands the built-ins to the repo"
