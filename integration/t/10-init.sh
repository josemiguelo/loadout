# init scaffolding, compile, and what a scaffolded repo already knows.

"$BIN" init repo >/dev/null || fail "init exits 0"
for f in settings.gradle.kts build.gradle.kts loadout.kt machines.loadout.kt programs/cli.loadout.kt gradlew gradle/wrapper/gradle-wrapper.jar .gitignore; do
    [ -f "repo/$f" ] || fail "init creates $f"
done
[ -d repo/maintenance ] && [ -d repo/state ] || fail "init creates dirs"
[ -x repo/gradlew ] || fail "init's gradlew is executable"
grep -q 'id("io.github.josemiguelo.loadout")' repo/build.gradle.kts || fail "init's build applies the loadout plugin"
git -C repo rev-parse --is-inside-work-tree >/dev/null || fail "init git-inits"
ok "init scaffolds a Kotlin repo with a Gradle wrapper"

"$BIN" init repo >/dev/null 2>&1 && fail "init refuses to overwrite" || true
ok "init refuses to overwrite an existing repo"

# --configs: a repo that holds dotfiles; compile gives its templates data
# and the partial that picks this machine's.
"$BIN" init --configs dots >/dev/null || fail "init --configs exits 0"
[ "$(cat dots/.chezmoiroot)" = configs ] || fail "init --configs points chezmoi at configs/"
[ -d dots/configs ] || fail "init --configs creates configs/"
grep -q 'configs = "configs"' dots/loadout.kt || fail "init --configs declares configs in loadout.kt"
[ ! -e repo/.chezmoiroot ] && ! grep -q 'configs =' repo/loadout.kt || fail "plain init has no configs"
"$BIN" --repo dots compile >/dev/null 2>&1 || fail "init --configs compiles"
[ -f dots/configs/.chezmoidata/loadout.json ] || fail "compile writes the templates' data"
grep -q 'get .loadout.machines .chezmoi.hostname' dots/configs/.chezmoitemplates/loadout/machine ||
    fail "compile writes the loadout/machine partial"
"$BIN" --repo dots explain >/dev/null || fail "the configs scaffold loads"
ok "init --configs scaffolds a dotfiles repo whose compile writes the templates' data and partial"

# --- compile: the lock every other command reads ----------------------------
OUT=$("$BIN" --repo repo status 2>&1) && fail "a repo never compiled has no lock to read"
echo "$OUT" | grep -q "no loadout.lock.json in repo — run: loadout compile" || fail "the missing lock is named: $OUT"
ok "a repo without a lock is refused, pointing at compile"

OUT=$("$BIN" --repo repo compile 2>&1) || fail "the scaffold compiles: $OUT"
echo "$OUT" | grep -q "wrote loadout.lock.json" || fail "compile says what it wrote: $OUT"
[ -f repo/loadout.lock.json ] || fail "compile writes the lock"
"$BIN" --repo repo --machine m1 status >/dev/null || fail "status reads the compiled scaffold"
ok "init's scaffold compiles and status reads it"

# Unchanged sources: the lock is left as it was (no new write, nothing in git).
touch -t 200001010000 repo/loadout.lock.json lock-ref
"$BIN" --repo repo compile >/dev/null || fail "a second compile exits 0"
[ repo/loadout.lock.json -nt lock-ref ] && fail "an unchanged compile must not rewrite the lock" || true
ok "compile leaves an unchanged lock alone"

# An edit the lock hasn't seen is refused until the next compile.
printf '\n// edited\n' >> repo/programs/cli.loadout.kt
OUT=$("$BIN" --repo repo --machine m1 status 2>&1) && fail "a stale lock must be refused"
echo "$OUT" | grep -q "the manifests changed since loadout.lock.json was written — run: loadout compile" || fail "the stale lock is named: $OUT"
"$BIN" --repo repo compile >/dev/null || fail "recompile exits 0"
"$BIN" --repo repo --machine m1 status >/dev/null || fail "status reads the fresh lock"
ok "a lock older than its sources is refused until compiled again"

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
echo "$OUT" | grep -qE "omarchy +built-in +omarchy pkg add" || fail "installers lists the built-in omarchy: $OUT"
echo "$OUT" | grep -qE "omarchy-aur +built-in +omarchy pkg aur add" || fail "installers lists the built-in omarchy-aur: $OUT"
echo "$OUT" | grep -q "built-in" || fail "installers marks built-ins"
OUT=$("$BIN" --repo repo installers dnf)
echo "$OUT" | grep -q "rpm -q {pkg}" || fail "installers <name> shows the definition"
"$BIN" --repo repo installers ghost-installer >/dev/null 2>&1 && fail "unknown installer should fail" || true
# The scaffold declares no installers, yet `installVia` resolves against the library.
OUT=$("$BIN" --repo repo explain ripgrep)
echo "$OUT" | grep -q "sudo dnf install -y ripgrep" || fail "via resolves to a built-in installer"
echo "$OUT" | grep -q "installer: dnf (built-in)" || fail "explain marks a built-in installer"
ok "installers ship with loadout and resolve without being declared"
