# init scaffolding, compile, and what a scaffolded repo already knows.

OUT=$("$BIN" init repo) || fail "init exits 0"
for f in loadout.ts loadout.sdk.ts tsconfig.json package.json .gitignore machines/machines.loadout.ts machines/data.ts programs/cli.loadout.ts machines/state/.gitkeep maintenance/.gitkeep; do
    [ -f "repo/$f" ] || fail "init creates $f"
done
[ -d repo/maintenance ] && [ -d repo/machines/state ] || fail "init creates dirs"
[ -e repo/node_modules ] && fail "init installs nothing: node_modules" || true
for g in 'programs/**/*.loadout.ts' 'maintenance/**/*.loadout.ts' 'machines/**/*.loadout.ts'; do
    grep -qF "\"$g\"" repo/loadout.ts || fail "init includes $g: $(cat repo/loadout.ts)"
done
grep -qF '"loadout": ["./loadout.sdk.ts"]' repo/tsconfig.json || fail "tsconfig.json maps loadout to the SDK: $(cat repo/tsconfig.json)"
grep -qE '^machine<Data>\("[^"]+", \{' repo/machines/machines.loadout.ts || fail "init declares this machine: $(cat repo/machines/machines.loadout.ts)"
git -C repo rev-parse --is-inside-work-tree >/dev/null || fail "init git-inits"
echo "$OUT" | grep -q "^Created repo: loadout.ts, programs/, maintenance/, machines/ (machines.loadout.ts, data.ts, state/), tsconfig.json" ||
    fail "init says what it created: $OUT"
echo "$OUT" | grep -q "^Next steps:" && echo "$OUT" | grep -q "beside programs/cli.loadout.ts" &&
    echo "$OUT" | grep -q "machines/machines.loadout.ts" && echo "$OUT" | grep -q "loadout --repo repo compile" ||
    fail "init's next steps name the scaffold's files: $OUT"
ok "init scaffolds a TypeScript repo: loadout.ts, tsconfig.json, the SDK and example *.loadout.ts files"

"$BIN" init repo >/dev/null 2>&1 && fail "init refuses to overwrite" || true
ok "init refuses to overwrite an existing repo"

# --configs: a repo that holds dotfiles; compile gives its templates data
# and the partial that picks this machine's.
OUT=$("$BIN" init --configs dots) || fail "init --configs exits 0"
echo "$OUT" | grep -q "beside loadouts/private_dot_config/.ripgrep.loadout.ts" && echo "$OUT" | grep -q "loadouts/.etc/<concern>/" ||
    fail "init --configs's next steps name its layout: $OUT"
[ "$(cat dots/.chezmoiroot)" = loadouts ] || fail "init --configs points chezmoi at loadouts/"
[ -d dots/loadouts ] || fail "init --configs creates loadouts/"
grep -q 'configs: "loadouts"' dots/loadout.ts || fail "init --configs declares configs in loadout.ts"
[ ! -e repo/.chezmoiroot ] && ! grep -q 'configs:' repo/loadout.ts || fail "plain init has no configs"
"$BIN" --repo dots compile >/dev/null 2>&1 || fail "init --configs compiles"
[ -f dots/loadouts/.chezmoidata/loadout.json ] || fail "compile writes the templates' data"
grep -qF '$table := get .loadout.machines $name' dots/loadouts/.chezmoitemplates/loadout/machine ||
    fail "compile writes the loadout/machine partial"
"$BIN" --repo dots explain >/dev/null || fail "the configs scaffold loads"
ok "init --configs scaffolds a dotfiles repo whose compile writes the templates' data and partial"

# Its layout: everything in loadouts/, a tool's file where its files land.
[ -f dots/loadouts/private_dot_config/.ripgrep.loadout.ts ] || fail "init --configs puts ripgrep where its files land"
[ ! -e dots/system ] && [ ! -e dots/programs ] && [ ! -e dots/maintenance ] || fail "init --configs has only loadouts/, not system/, programs/ or maintenance/"
for g in 'loadouts/**/*.loadout.ts' 'machines/**/*.loadout.ts'; do
    grep -qF "\"$g\"" dots/loadout.ts || fail "init --configs includes $g: $(cat dots/loadout.ts)"
done
"$BIN" --repo dots explain ripgrep | grep -q "sudo dnf install -y ripgrep" || fail "the dot-file manifest compiles"
[ -d repo/programs ] && [ -d repo/maintenance ] && [ ! -e repo/system ] || fail "plain init keeps programs/ and maintenance/"
ok "init --configs lays manifests out in loadouts/, where their files land"

# A tool with scripts and no dotfiles: a dot-folder (chezmoi deploys none of
# it), which include()'s glob finds (it matches dot files and folders), its
# script running from its folder.
ts_file dots/loadouts/private_dot_config/.tool/.tool.loadout.ts <<'TS'
const tool = script("tool", {
  description: "sets the tool up",
  file: ".loadout/setup.sh",
  check: "test -f setup-ran.txt",
});

machine("m1", { run: [tool] });
TS
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

repo_files() { (cd repo && find . -path ./.git -prune -o -print | LC_ALL=C sort); }
repo_files > files.before
OUT=$("$BIN" --repo repo compile 2>&1) || fail "the scaffold compiles: $OUT"
repo_files > files.after
echo "$OUT" | grep -q "wrote loadout.lock.json" || fail "compile says what it wrote: $OUT"
[ -f repo/loadout.lock.json ] || fail "compile writes the lock"
"$BIN" --repo repo --machine m1 status >/dev/null || fail "status reads the compiled scaffold"
ok "init's scaffold compiles and status reads it"

# Compile is the binary's own: no build folder, no cache, nothing in the
# repo but the lock.
[ "$(LC_ALL=C comm -13 files.before files.after)" = ./loadout.lock.json ] ||
    fail "compile adds only the lock to the repo: $(LC_ALL=C comm -13 files.before files.after)"
[ -z "$(LC_ALL=C comm -23 files.before files.after)" ] || fail "compile removes nothing: $(LC_ALL=C comm -23 files.before files.after)"
ok "compile writes the lock and nothing else into the repo"

# A repo without loadout.ts is refused, and nothing is written.
mkdir -p bare/machines/state
OUT=$("$BIN" --repo bare compile 2>&1) && fail "a repo without loadout.ts must not compile"
echo "$OUT" | grep -q "^error: .* has no loadout.ts — a config repo starts there (see: loadout init)" || fail "the missing loadout.ts is named: $OUT"
[ -e bare/loadout.lock.json ] && fail "nothing is written for a repo without loadout.ts" || true
ok "compile refuses a repo without loadout.ts"

# Unchanged sources: the lock is left as it was (no new write, nothing in git).
touch -t 200001010000 repo/loadout.lock.json lock-ref
"$BIN" --repo repo compile >/dev/null || fail "a second compile exits 0"
[ repo/loadout.lock.json -nt lock-ref ] && fail "an unchanged compile must not rewrite the lock" || true
ok "compile leaves an unchanged lock alone"

# An edit the lock hasn't seen is refused until the next compile.
printf '\n// edited\n' >> repo/programs/cli.loadout.ts
OUT=$("$BIN" --repo repo --machine m1 status 2>&1) && fail "a stale lock must be refused"
echo "$OUT" | grep -q "the manifests changed since loadout.lock.json was written — run: loadout compile" || fail "the stale lock is named: $OUT"
"$BIN" --repo repo compile >/dev/null || fail "recompile exits 0"
"$BIN" --repo repo --machine m1 status >/dev/null || fail "status reads the fresh lock"
ok "a lock older than its sources is refused until compiled again"

# A module a manifest imports is a source too, though no include() names it:
# editing a helper makes the lock stale.
mkdir -p repo/programs/lib
printf 'export const fdDescription = "find files";\n' > repo/programs/lib/fd.ts
ts_file repo/programs/fd.loadout.ts <<'TS'
import { fdDescription } from "./lib/fd.ts";

program("fd", { description: fdDescription, install: [dnf], spare: "an example" });
TS
"$BIN" --repo repo compile >/dev/null || fail "a manifest importing a helper compiles"
grep -q '"programs/lib/fd.ts"' repo/loadout.lock.json || fail "the helper is among the lock's sources"
"$BIN" --repo repo explain fd | grep -q "find files" || fail "the helper's value reaches the manifest"
printf 'export const fdDescription = "find files fast";\n' > repo/programs/lib/fd.ts
OUT=$("$BIN" --repo repo --machine m1 status 2>&1) && fail "a helper edit the lock hasn't seen must be refused"
echo "$OUT" | grep -q "the manifests changed since loadout.lock.json was written — run: loadout compile" || fail "the stale lock is named: $OUT"
rm -r repo/programs/lib repo/programs/fd.loadout.ts
"$BIN" --repo repo compile >/dev/null || fail "recompile exits 0"
ok "a helper module a manifest imports is a source: editing it makes the lock stale"

# --- an unreadable state file is a warning, not a crash ------------------
printf '{ this is not json' > repo/machines/state/m1.json
OUT=$("$BIN" --repo repo --machine m1 status --no-write 2>&1) || fail "status survives a corrupt state file"
echo "$OUT" | grep -q "not readable state" || fail "a corrupt state file warns"
echo "$OUT" | grep -qE '^ +at .+:[0-9]+:[0-9]+\)?$' && fail "a corrupt state file must not crash" || true
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
# The scaffold declares no installers, yet `install: [dnf, …]` resolves against the library.
OUT=$("$BIN" --repo repo explain ripgrep)
echo "$OUT" | grep -q "sudo dnf install -y ripgrep" || fail "via resolves to a built-in installer"
echo "$OUT" | grep -q "installer: dnf (built-in)" || fail "explain marks a built-in installer"
ok "installers ship with loadout and resolve without being declared"

# --- init --parent: a child repo (contract 18) --------------------------------
"$BIN" init dad >/dev/null || fail "a parent scaffolds"
OUT=$("$BIN" init --parent "$PWD/dad" --name dad kid 2>&1) && fail "a parent without a lock must be refused"
echo "$OUT" | grep -q "has no loadout.lock.json — compile it first" || fail "the uncompiled parent is named: $OUT"
"$BIN" --repo dad compile >/dev/null 2>&1 || fail "the parent scaffold compiles"
OUT=$("$BIN" --machine kidbox init --parent "$PWD/dad" --name dad kid) || fail "init --parent scaffolds a child"
echo "$OUT" | grep -q "^Next steps:" && echo "$OUT" | grep -qF "machines/kidbox.loadout.ts (import dad's from \"parent/…\")" ||
    fail "init --parent's next steps name the machine's file: $OUT"
[ -f kid/loadout.ts ] && [ -f kid/tsconfig.json ] && [ -f kid/loadout.sdk.ts ] || fail "the child's root file is loadout.ts, beside tsconfig.json and the SDK"
grep -qF "name: \"dad\"" kid/loadout.ts && grep -qF "path: \"$PWD/dad\"" kid/loadout.ts ||
    fail "the child's repo() names its parent: $(cat kid/loadout.ts)"
grep -q '^  parent: {' kid/loadout.ts || fail "as its parent: $(cat kid/loadout.ts)"
grep -qF '"parent/*": ["../dad/*"]' kid/tsconfig.json || fail "tsconfig.json maps parent/… to the parent's checkout: $(cat kid/tsconfig.json)"
[ -f kid/machines/kidbox.loadout.ts ] || fail "the child's machine is in machines/"
grep -qF 'machine("kidbox"' kid/machines/kidbox.loadout.ts || fail "named by its hostname: $(cat kid/machines/kidbox.loadout.ts)"
[ -d kid/programs ] && [ -d kid/maintenance ] && [ ! -e kid/programs/cli.loadout.ts ] || fail "the child has the folders, and no example that could clash"
OUT=$("$BIN" --repo kid compile 2>&1) || fail "the child scaffold compiles against its parent: $OUT"
grep -q '"parent": {' kid/loadout.lock.json || fail "and its lock names the parent"
# Its machine imports the parent's declarations through parent/….
cat > kid/machines/kidbox.loadout.ts <<'TS'
import { dnf, machine, via } from "loadout";
import { ripgrep } from "parent/programs/cli.loadout.ts";

machine("kidbox", { install: [via(dnf, [ripgrep])] });
TS
OUT=$("$BIN" --repo kid compile 2>&1) || fail "a child machine importing from parent/… compiles: $OUT"
"$BIN" --repo kid --machine kidbox explain ripgrep | grep -qE "install\.dnf +sudo dnf install -y ripgrep .*<- kidbox" || fail "the child installs the parent's program"
ok "init --parent scaffolds a child repo that compiles against its parent"

"$BIN" --machine kidbox init --parent "$PWD/dad" --name dad --configs kiddots >/dev/null || fail "init --parent --configs scaffolds"
[ "$(cat kiddots/.chezmoiroot)" = loadouts ] && [ -d kiddots/loadouts ] && [ ! -e kiddots/system ] && [ ! -e kiddots/programs ] || fail "a configs child has loadouts/ only"
grep -qF '"loadouts/**/*.loadout.ts"' kiddots/loadout.ts || fail "a configs child includes loadouts/: $(cat kiddots/loadout.ts)"
grep -q 'configs: "loadouts"' kiddots/loadout.ts || fail "a configs child declares configs: $(cat kiddots/loadout.ts)"
OUT=$("$BIN" --repo kiddots compile 2>&1) || fail "the configs child compiles: $OUT"
ok "init --parent --configs scaffolds a child laid out where files land"

# --- a new manifest is a change too ------------------------------------------
# A file include()'s globs pick up that the lock has never seen makes it
# stale, like an edit: status must not read a lock that misses it.
ts_file repo/programs/fd.loadout.ts <<'TS'
program("fd", { install: [dnf], spare: "an example" });
TS
OUT=$("$BIN" --repo repo --machine m1 status 2>&1) && fail "a manifest the lock hasn't seen must be refused: $OUT"
echo "$OUT" | grep -q "the manifests changed since loadout.lock.json was written — run: loadout compile" || fail "the stale lock is named: $OUT"
rm repo/programs/fd.loadout.ts
ok "a new manifest include() picks up makes the lock stale"
