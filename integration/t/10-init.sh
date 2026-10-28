# init scaffolding, compile, and what a scaffolded repo already knows.

"$BIN" init repo >/dev/null || fail "init exits 0"
for f in settings.gradle.kts build.gradle.kts loadout.kt machines/machines.loadout.kt programs/cli.loadout.kt gradlew gradle/wrapper/gradle-wrapper.jar .gitignore; do
    [ -f "repo/$f" ] || fail "init creates $f"
done
[ -d repo/maintenance ] && [ -d repo/machines/state ] || fail "init creates dirs"
[ -x repo/gradlew ] || fail "init's gradlew is executable"
grep -q 'id("io.github.josemiguelo.loadout")' repo/build.gradle.kts || fail "init's build applies the loadout plugin"
git -C repo rev-parse --is-inside-work-tree >/dev/null || fail "init git-inits"
ok "init scaffolds a Kotlin repo with a Gradle wrapper"

"$BIN" init repo >/dev/null 2>&1 && fail "init refuses to overwrite" || true
ok "init refuses to overwrite an existing repo"

# --configs: a repo that holds dotfiles; compile gives its templates data
# and the partial that picks this machine's.
"$BIN" init --configs dots >/dev/null || fail "init --configs exits 0"
[ "$(cat dots/.chezmoiroot)" = loadouts ] || fail "init --configs points chezmoi at loadouts/"
[ -d dots/loadouts ] || fail "init --configs creates loadouts/"
grep -q 'configs = "loadouts"' dots/loadout.kt || fail "init --configs declares configs in loadout.kt"
[ ! -e repo/.chezmoiroot ] && ! grep -q 'configs =' repo/loadout.kt || fail "plain init has no configs"
"$BIN" --repo dots compile >/dev/null 2>&1 || fail "init --configs compiles"
[ -f dots/loadouts/.chezmoidata/loadout.json ] || fail "compile writes the templates' data"
grep -qF '$table := get .loadout.machines $name' dots/loadouts/.chezmoitemplates/loadout/machine ||
    fail "compile writes the loadout/machine partial"
"$BIN" --repo dots explain >/dev/null || fail "the configs scaffold loads"
ok "init --configs scaffolds a dotfiles repo whose compile writes the templates' data and partial"

# Its layout: everything in loadouts/, a tool's file where its files land.
[ -f dots/loadouts/private_dot_config/.ripgrep.loadout.kt ] || fail "init --configs puts ripgrep where its files land"
[ ! -e dots/system ] && [ ! -e dots/programs ] && [ ! -e dots/maintenance ] || fail "init --configs has only loadouts/, not system/, programs/ or maintenance/"
for g in 'loadouts/**/.*.loadout.kt' 'loadouts/**/.*/.*.loadout.kt' 'loadouts/.etc/*/.*.loadout.kt'; do
    grep -qF "\"$g\"," dots/build.gradle.kts || fail "init --configs globs $g: $(cat dots/build.gradle.kts)"
done
"$BIN" --repo dots explain ripgrep | grep -q "sudo dnf install -y ripgrep" || fail "the dot-file manifest compiles"
[ -d repo/programs ] && [ -d repo/maintenance ] && [ ! -e repo/system ] || fail "plain init keeps programs/ and maintenance/"
ok "init --configs lays manifests out in loadouts/, where their files land"

# A tool with scripts and no dotfiles: a dot-folder (chezmoi deploys none of
# it), whose own glob finds it, its script running from its folder.
kt_file dots/loadouts/private_dot_config/.tool/.tool.loadout.kt <<'KT'
val tool = script(
    name = "tool",
    description = "sets the tool up",
) {
    file(".loadout/setup.sh")
    check("test -f setup-ran.txt")
}

val m1 = machine(hostname = "m1") { run(tool) }
KT
mkdir -p dots/loadouts/private_dot_config/.tool/.loadout
printf '#!/bin/sh\ntouch setup-ran.txt\n' > dots/loadouts/private_dot_config/.tool/.loadout/setup.sh
OUT=$("$BIN" --repo dots compile 2>&1) || fail "a dot-folder manifest compiles: $OUT"
"$BIN" --repo dots --machine m1 run tool >/dev/null || fail "the dot-folder's script runs"
[ -f dots/loadouts/private_dot_config/.tool/setup-ran.txt ] || fail "the dot-folder's script ran in its file's folder"
ok "a tool's dot-folder compiles, and its script runs from that folder"

# --- compile: the lock every other command reads ----------------------------
OUT=$("$BIN" --repo repo status 2>&1) && fail "a repo never compiled has no lock to read"
echo "$OUT" | grep -q "no loadout.lock.json in repo — run: loadout compile" || fail "the missing lock is named: $OUT"
ok "a repo without a lock is refused, pointing at compile"

OUT=$("$BIN" --repo repo compile 2>&1) || fail "the scaffold compiles: $OUT"
echo "$OUT" | grep -q "wrote loadout.lock.json" || fail "compile says what it wrote: $OUT"
[ -f repo/loadout.lock.json ] || fail "compile writes the lock"
"$BIN" --repo repo --machine m1 status >/dev/null || fail "status reads the compiled scaffold"
ok "init's scaffold compiles and status reads it"

# The build lives in loadout's cache, one folder per checkout: an editor's
# Gradle import indexes the whole repo, so a build/ there is a second copy
# of every declaration.
[ -e repo/build ] && fail "compile must not build inside the repo" || true
ls -d "$XDG_CACHE_HOME"/loadout/build/repo-*/classes >/dev/null 2>&1 || fail "compile builds in loadout's cache"
ok "compile builds outside the repo, in loadout's cache"

# An older loadout's build/ is named for deletion, until it's gone.
mkdir -p repo/build/classes
OUT=$("$BIN" --repo repo compile 2>&1) || fail "compile with a leftover build/ exits 0: $OUT"
echo "$OUT" | grep -q "delete build/: it's left from an older loadout" || fail "a leftover build/ is named: $OUT"
rm -rf repo/build
OUT=$("$BIN" --repo repo compile 2>&1) || fail "compile exits 0: $OUT"
echo "$OUT" | grep -q "delete build/" && fail "no build/, no notice: $OUT" || true
ok "compile names an older loadout's build/ for deletion"

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
printf '{ this is not json' > repo/machines/state/m1.json
OUT=$("$BIN" --repo repo --machine m1 status --no-write 2>&1) || fail "status survives a corrupt state file"
echo "$OUT" | grep -q "not readable state" || fail "a corrupt state file warns"
echo "$OUT" | grep -qi "Uncaught Kotlin exception" && fail "a corrupt state file must not crash" || true
OUT=$("$BIN" --repo repo --machine m1 diff 2>&1 || true)
echo "$OUT" | grep -q "not readable state" || fail "diff warns about a corrupt state file instead of hiding it"
rm -f repo/machines/state/m1.json
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

# --- init --parent: a child repo (contract 18) --------------------------------
"$BIN" init dad >/dev/null || fail "a parent scaffolds"
OUT=$("$BIN" init --parent "$PWD/dad" --name dad kid 2>&1) && fail "a parent without a lock must be refused"
echo "$OUT" | grep -q "has no loadout.lock.json — compile it first" || fail "the uncompiled parent is named: $OUT"
"$BIN" --repo dad compile >/dev/null 2>&1 || fail "the parent scaffold compiles"
"$BIN" --machine kidbox init --parent "$PWD/dad" --name dad kid >/dev/null || fail "init --parent scaffolds a child"
[ -f kid/child.kt ] && [ ! -e kid/loadout.kt ] || fail "the child's root file is child.kt (the parent has loadout.kt)"
grep -q "parent(name = \"dad\", path = \"$PWD/dad\")" kid/build.gradle.kts || fail "the child's build names its parent: $(cat kid/build.gradle.kts)"
grep -q '^package repo$' kid/child.kt || fail "the child shares the parent's package"
[ -f kid/machines/kidbox.loadout.kt ] || fail "the child's machine is in machines/"
OUT=$("$BIN" --repo kid compile 2>&1) || fail "the child scaffold compiles against its parent: $OUT"
grep -q '"parent": {' kid/loadout.lock.json || fail "and its lock names the parent"
ok "init --parent scaffolds a child repo that compiles against its parent"

"$BIN" --machine kidbox init --parent "$PWD/dad" --name dad --configs kiddots >/dev/null || fail "init --parent --configs scaffolds"
[ "$(cat kiddots/.chezmoiroot)" = loadouts ] && [ -d kiddots/loadouts ] && [ ! -e kiddots/system ] && [ ! -e kiddots/programs ] || fail "a configs child has loadouts/ only"
grep -qF '"loadouts/**/.*/.*.loadout.kt",' kiddots/build.gradle.kts || fail "a configs child globs dot-folders: $(cat kiddots/build.gradle.kts)"
OUT=$("$BIN" --repo kiddots compile 2>&1) || fail "the configs child compiles: $OUT"
ok "init --parent --configs scaffolds a child laid out where files land"
