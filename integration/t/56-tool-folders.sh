# Tool folders: `dotfiles: { tools, home, root }`. Compile builds chezmoi's
# sources from each tool's home/ and root/; every load refuses a build behind
# its folders or holding what chezmoi wrote there; `loadout chezmoi` carries
# chezmoi's writes over to the tool folders; root configs apply in two
# passes. A stub chezmoi stands in (a real one would touch the developer's
# dotfiles): it answers from files in $TF and writes into the build the way
# re-add and add do.

TF=$PWD/tf
mkdir -p "$TF/bin" "$TF/home"
cat > "$TF/bin/chezmoi" <<'SH'
#!/bin/sh
# Stub: logs every call. Which source it's over picks its answers
# ($TF/<home|root>-<question>); re-add and add write into the source as
# chezmoi does (a symlink becomes a file; a new file appears).
echo "$*" >> "$TF/log"
side=home src=
while [ $# -gt 0 ]; do
    case "$1" in
    --source) src=$2; case "$2" in *.root) side=root ;; esac; shift 2 ;;
    --destination|--config|--config-format|--persistent-state|--cache) shift 2 ;;
    --no-pager|--no-tty|--force) shift ;;
    *) break ;;
    esac
done
cmd=$1; shift
case "$cmd" in
managed)
    case "$*" in
    *"--include dirs"*) cat "$TF/$side-dirs" 2>/dev/null || echo '{}' ;;
    *json*) cat "$TF/$side-managed" ;;
    *) cat "$TF/$side-managed" ;;
    esac ;;
status) cat "$TF/$side-status" 2>/dev/null ;;
target-path) echo "$TF/home" ;;
apply) : > "$TF/$side-status" ;;
re-add) rm "$src/dot_zshenv"; echo edited > "$src/dot_zshenv" ;;
add) echo new > "$src/dot_newrc" ;;
*) echo "stub chezmoi: unexpected $cmd $*" >&2; exit 2 ;;
esac
SH
chmod +x "$TF/bin/chezmoi"
export TF
tf_loadout() { PATH="$TF/bin:$PATH" HOME="$TF/home" "$BIN" "$@"; }

basic_repo repo
repo_opt repo/loadout.ts 'dotfiles: { tools: "tools/*", home: ".home", root: ".root" }'
mkdir -p repo/tools/zsh/home repo/tools/kb/root/etc/udev
echo 'export ZDOTDIR' > repo/tools/zsh/home/dot_zshenv
echo '.zcompdump' > repo/tools/zsh/home/.chezmoiignore
: > repo/tools/zsh/zsh.loadout.ts
echo 'rule' > repo/tools/kb/root/etc/udev/kb.rules
compile_repo repo

# --- the builds ------------------------------------------------------------------
[ "$(readlink repo/.home/dot_zshenv)" = "../tools/zsh/home/dot_zshenv" ] || fail "the home build links the tool's file: $(ls -la repo/.home)"
[ "$(readlink repo/.root/etc/udev/kb.rules)" = "../../../tools/kb/root/etc/udev/kb.rules" ] || fail "the root build links root/'s file"
[ "$(readlink repo/.root/.chezmoidata/loadout.json)" = "../../.home/.chezmoidata/loadout.json" ] ||
    fail "the root build reads the templates' data from the home build"
[ -f repo/.home/.chezmoidata/loadout.json ] || fail "compile writes the templates' data into the home build"
[ ! -e repo/.home/zsh.loadout.ts ] || fail "a tool's manifest is no chezmoi source"
grep -q 'tools/zsh/home/.chezmoiignore' repo/.home/.chezmoiignore || fail "each tool's .chezmoiignore is joined, under its name"
ok "compile builds each tool's home/ and root/ as symlinks, with the templates' data on both sides"

# --- a build behind its tool folders ------------------------------------------------
echo 'x' > repo/tools/zsh/home/dot_zprofile
OUT=$("$BIN" --repo repo --machine m1 program explain git 2>&1) || fail "a build behind its tool folders is brought up to date, not refused: $OUT"
[ -L repo/.home/dot_zprofile ] || fail "any command adds what a tool gained"
rm repo/tools/zsh/home/dot_zprofile
"$BIN" --repo repo --machine m1 program explain git >/dev/null 2>&1 || fail "the repo still loads"
[ ! -e repo/.home/dot_zprofile ] || fail "any command removes what no tool has any more"
rm -r repo/.home repo/.root
"$BIN" --repo repo --machine m1 program explain git >/dev/null 2>&1 || fail "builds that aren't there are made"
[ -L repo/.home/dot_zshenv ] && [ -f repo/.home/.chezmoidata/loadout.json ] && [ -L repo/.root/etc/udev/kb.rules ] ||
    fail "a fresh checkout gets both builds and the templates' data from any command"
ok "every command brings the builds up to date, so they needn't be committed"

# --- what chezmoi writes into a build ---------------------------------------------------
rm repo/.home/dot_zshenv && echo 'edited here' > repo/.home/dot_zshenv
OUT=$("$BIN" --repo repo --machine m1 program explain git 2>&1) && fail "a chezmoi write in the build must be refused"
echo "$OUT" | grep -qF 'chezmoi wrote .home/dot_zshenv, not tools/zsh/home/dot_zshenv — keep it with `loadout chezmoi re-add ~/.zshenv` (or copy it over tools/zsh/home/dot_zshenv), or drop it by deleting .home/dot_zshenv' ||
    fail "the write is named with both ways out: $OUT"
OUT=$(cd repo && "$BIN" repo compile 2>&1) && fail "compile must not overwrite a chezmoi write"
echo "$OUT" | grep -q 'chezmoi wrote .home/dot_zshenv' || fail "compile names the write: $OUT"
grep -q 'edited here' repo/.home/dot_zshenv || fail "the write is still there"
rm repo/.home/dot_zshenv && ln -s ../tools/zsh/home/dot_zshenv repo/.home/dot_zshenv
ok "a chezmoi write in a build stops every command, compile too, until it's kept or dropped"

# --- loadout chezmoi ---------------------------------------------------------------------
echo '.zshenv' > "$TF/home-managed"
OUT=$(tf_loadout --repo repo --machine m1 chezmoi re-add "$TF/home/.zshenv" 2>&1) || fail "loadout chezmoi re-add: $OUT"
[ "$(cat repo/tools/zsh/home/dot_zshenv)" = edited ] || fail "re-add's write lands in the tool's folder: $(cat repo/tools/zsh/home/dot_zshenv)"
[ -L repo/.home/dot_zshenv ] || fail "the build's symlink is back"
echo "$OUT" | grep -q '~/.zshenv → tools/zsh/home/dot_zshenv' || fail "it says where the edit went: $OUT"
# The repo by its real path, as loadout resolves it (macOS's /var is /private/var).
grep -q -- "--source $(cd repo && pwd -P)/.home --no-pager re-add $TF/home/.zshenv" "$TF/log" || fail "chezmoi ran over the home build: $(cat "$TF/log")"
"$BIN" --repo repo --machine m1 program explain git >/dev/null 2>&1 || fail "the repo loads again"
ok "loadout chezmoi re-add carries chezmoi's write over to the tool's folder"

OUT=$(tf_loadout --repo repo --machine m1 chezmoi add "$TF/home/.newrc" 2>&1) && fail "add without --tool must fail"
echo "$OUT" | grep -q 'from no tool: .home/dot_newrc' || fail "the new file is named: $OUT"
rm repo/.home/dot_newrc
OUT=$(tf_loadout --repo repo --machine m1 chezmoi add --tool zsh "$TF/home/.newrc" 2>&1) || fail "add --tool zsh: $OUT"
[ "$(cat repo/tools/zsh/home/dot_newrc)" = new ] && [ -L repo/.home/dot_newrc ] || fail "the new file goes into zsh's home/, linked from the build"
OUT=$(tf_loadout --repo repo chezmoi update 2>&1) && fail "update must be refused"
echo "$OUT" | grep -q 'loadout chezmoi update: run: loadout machine sync' || fail "update says what to run: $OUT"
ok "loadout chezmoi add puts a new file into --tool's folder, and refuses without one"

# --- clashes ----------------------------------------------------------------------------
mkdir -p repo/tools/bash/home
echo x > repo/tools/bash/home/dot_zshenv
OUT=$(cd repo && "$BIN" repo compile 2>&1) && fail "two tools landing one file must be refused"
echo "$OUT" | grep -q '~/.zshenv is in both bash and zsh' || fail "the clash names both tools: $OUT"
rm -r repo/tools/bash
compile_repo repo
ok "compile refuses two tools that land the same file"

# --- root configs ---------------------------------------------------------------------------
FAKEROOT=$PWD/fakeroot
mkdir -p "$FAKEROOT/etc"
printf '{"etc/udev/kb.rules":{"absolute":"%s/etc/udev/kb.rules","sourceRelative":"etc/udev/kb.rules"}}' "$FAKEROOT" > "$TF/root-managed"
printf '{"etc":{"absolute":"%s/etc","sourceRelative":"etc"},"etc/udev":{"absolute":"%s/etc/udev","sourceRelative":"etc/udev"}}' "$FAKEROOT" "$FAKEROOT" > "$TF/root-dirs"
printf ' A etc/udev/kb.rules\n' > "$TF/root-status"
: > "$TF/home-status"
OUT=$(LOADOUT_ROOT_DESTINATION=$FAKEROOT tf_loadout --repo repo --machine m1 machine status 2>&1)
echo "$OUT" | grep -q '/kb .*drifted' || fail "a root config is a unit named after its tool: $OUT"
: > "$TF/log"
OUT=$(LOADOUT_ROOT_DESTINATION=$FAKEROOT tf_loadout --repo repo --machine m1 config apply /kb 2>&1) || fail "config apply /kb: $OUT"
grep -q -- "apply --no-tty --include dirs --recursive=false $FAKEROOT/etc/udev$" "$TF/log" || fail "pass 1 applies only the folder not there yet: $(cat "$TF/log")"
grep -q -- "apply --no-tty --exclude dirs $FAKEROOT/etc/udev/kb.rules" "$TF/log" || fail "pass 2 applies the rest without folders: $(cat "$TF/log")"
grep -q -- "--destination $FAKEROOT --config /dev/null --config-format toml --persistent-state $FAKEROOT/" "$TF/log" ||
    fail "root's chezmoi runs with its own config and state: $(cat "$TF/log")"
! grep -q sudo "$TF/log" || fail "a stand-in for / is applied without sudo"
echo "$OUT" | grep -q 'applied /kb' || fail "config apply says what it applied: $OUT"
ok "a root config applies in two passes, folders already there left alone, as a unit named after its tool"

printf ' A etc/udev/kb.rules\n' > "$TF/root-status"
OUT=$(LOADOUT_ROOT_DESTINATION=$FAKEROOT tf_loadout --repo repo --machine m1 machine new --dry-run 2>&1)
echo "$OUT" | grep -q '/kb *config' || fail "setup plans the root config: $OUT"
[ "$(echo "$OUT" | grep -n '/kb *config' | cut -d: -f1)" -lt "$(echo "$OUT" | grep -n 'marker *script' | cut -d: -f1)" ] ||
    fail "the root config lands before the scripts: $OUT"
ok "machine new applies root configs before the core scripts"

# --- the dotfiles object's mistakes, caught where they're written ---------------------------
mistake() { # mistake <what> <option> <expected error>
    rm -rf bad && basic_repo bad
    repo_opt bad/loadout.ts "$2"
    mkdir -p bad/tools/kb/root/etc bad/tools/zsh/home && echo r > bad/tools/kb/root/etc/x && echo z > bad/tools/zsh/home/dot_z
    OUT=$(cd bad && "$BIN" repo compile 2>&1) && fail "$1 must be refused"
    echo "$OUT" | grep -qF -- "$3" || fail "$1 is named: $OUT"
}
mistake "an unknown dotfiles setting" 'dotfiles: { tools: "tools/*", home: ".home", rot: ".root" }' "repo's dotfiles has no setting 'rot' (its settings: tools, home, root, from)"
mistake "dotfiles without home" 'dotfiles: { tools: "tools/*", root: ".root" }' "repo's dotfiles needs home"
mistake "a tool's root/ with no root build" 'dotfiles: { tools: "tools/*", home: ".home" }' "tool kb has root/, and dotfiles has no root to build it into"
mistake "from overlapping a tool" 'dotfiles: { tools: "tools/*", home: ".home", root: ".root", from: "tools/zsh" }' "overlaps from tools/zsh"
mistake "a build inside from" 'dotfiles: { tools: "tools/*", home: "dots/build", root: ".root", from: "dots" }' "layout 'dots/build' is inside from 'dots'"
mistake "a build in the state folder" 'dotfiles: { tools: "tools/*", home: "machines/state/home", root: ".root" }' "is inside the state folder"
mistake "a build in a tool folder" 'dotfiles: { tools: "tools/*", home: "tools/built", root: ".root" }' "layout 'tools/built' is in a tool folder (tools/*)"
ok "the dotfiles object's mistakes are refused by compile, each named"

OUT=$("$BIN" --help chezmoi 2>&1) || fail "loadout --help chezmoi: $OUT"
echo "$OUT" | grep -q 'Run chezmoi over this repo' || fail "loadout --help chezmoi prints its help: $OUT"
ok "loadout --help chezmoi prints its help"
