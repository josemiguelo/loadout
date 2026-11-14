# What a compiled manifest means: params, file: paths, profiles, data,
# script variants and yes/no checks; and the mistakes compile (or the
# binary reading the lock) refuses.

# --- installer params ----------------------------------------------------
ts_repo paramrepo
ts_file paramrepo/programs/tool.loadout.ts <<'TS'
const faux = installer("faux", {
  params: ["flavor"],
  install: "echo installing {pkg} from {flavor}",
  check: "echo {pkg} 1.0",
  regex: "([0-9.]+)",
});

const tool = program("tool", {
  install: [via(faux, { params: { flavor: "vanilla" } })],
});

machine("m1", { install: [tool] });
TS
compile_repo paramrepo
OUT=$("$BIN" --repo paramrepo --machine m1 explain tool)
echo "$OUT" | grep -q "echo installing tool from vanilla" || fail "installer params substitute"
ts_file paramrepo/programs/tool.loadout.ts <<'TS'
const faux = installer("faux", { params: ["flavor"], install: "echo {flavor}" });

const tool = program("tool", { install: [faux] });

machine("m1", { install: [tool] });
TS
OUT=$("$BIN" --repo paramrepo compile 2>&1) && fail "a missing param must fail the compile"
echo "$OUT" | grep -q "needs a value for 'flavor'" || fail "the missing param is named: $OUT"
ok "installers take declared params, and a missing one is a compile error"

# A file() param is a path next to the program's own file, wherever the
# installer's command runs (here: the repo root, where root.loadout.ts
# declares it).
ts_root fparam <<'TS'
export const copyin = installer("copyin", {
  params: ["src"],
  install: "cp {src} installed-{pkg}.txt",
  check: "cat installed-{pkg}.txt",
  regex: "([0-9.]+)",
});
TS
ts_file fparam/programs/tool/tool.loadout.ts <<'TS'
import { copyin } from "../../root.loadout.ts";

const tool = program("tool", {
  install: [via(copyin, { params: { src: file("payload.txt") } })],
});

machine("m1", { install: [tool] });
TS
printf 'tool 4.2\n' > fparam/programs/tool/payload.txt
compile_repo fparam
"$BIN" --repo fparam --machine m1 install tool --yes >/dev/null 2>&1 || fail "an install with a file: param runs"
grep -qx "tool 4.2" fparam/installed-tool.txt || fail "the file: param reached the file next to the program's file"
rm fparam/programs/tool/payload.txt
OUT=$("$BIN" --repo fparam --machine m1 explain tool 2>&1) && fail "a missing file: param must fail the load"
echo "$OUT" | grep -q "with.src: file 'programs/tool/payload.txt' not found" || fail "the missing param file is named: $OUT"
ok "a file: param resolves next to its program and is checked when the lock is read"

# --- programs in several files, machines in another --------------------
basic_repo repo
ts_file repo/programs/split.loadout.ts <<'TS'
import { git } from "../root.loadout.ts";

const splitprog = program("splitprog", {
  version: "git --version",
  regex: "git version ([0-9.]+)",
  install: [custom("manual", { command: "false" })],
});

machine("m3", { install: [variant(git, "manual"), splitprog] });
TS
compile_repo repo
"$BIN" --repo repo --machine m3 status >/dev/null || fail "status with programs in another file"
grep -q '"splitprog"' repo/machines/state/m3.json || fail "the other file's program is checked"
"$BIN" --repo repo --machine m3 setup-new-machine --dry-run >/dev/null || fail "its machine plans"
rm repo/programs/split.loadout.ts repo/machines/state/m3.json
compile_repo repo
ok "every manifest loadout.ts includes compiles into one manifest"

# --- profiles ------------------------------------------------------------
ts_file repo/programs/profiles.loadout.ts <<'TS'
import { git, marker } from "../root.loadout.ts";

const testbase = profile("testbase", {
  install: [variant(git, "manual")],
  run: [marker],
});

machine("m9", { extends: [testbase] });
TS
compile_repo repo
OUT=$("$BIN" --repo repo --machine m9 setup-new-machine --dry-run) || fail "inherited machine plans"
echo "$OUT" | grep -q "git" || fail "the machine inherits the profile's mapping"
echo "$OUT" | grep -qE "~ marker +script" || fail "the machine inherits the profile's scripts"
"$BIN" --repo repo --machine m9 status --no-write >/dev/null || fail "status works for inherited machine"
"$BIN" --repo repo diff 2>/dev/null | grep -q "testbase" && fail "profiles must not appear as machines" || true
OUT=$("$BIN" --repo repo --machine m9 explain)
echo "$OUT" | grep -qE "extends +testbase" || fail "explain names the machine's profiles: $OUT"
echo "$OUT" | grep -qE "install manual +git" || fail "explain shows what the machine installs: $OUT"
echo "$OUT" | grep -qE "^ *run +marker" || fail "explain shows what the machine runs: $OUT"
ok "machines extend profiles, which are never machines themselves"

ts_file repo/programs/profiles.loadout.ts <<'TS'
import { git } from "../root.loadout.ts";

const a = profile("a", { install: [variant(git, "manual")] });
const b = profile("b", { install: [via(dnf, [git])] });

machine("m9", { extends: [a, b] });
TS
OUT=$("$BIN" --repo repo compile 2>&1) && fail "two profiles mapping a program differently must fail"
echo "$OUT" | grep -q "machine 'm9': profiles 'a' and 'b' map 'git' differently ('manual' vs 'dnf')" || fail "the disagreement is named: $OUT"
ok "two profiles of one machine that disagree are a compile error"

ts_file repo/programs/profiles.loadout.ts <<'TS'
import { git } from "../root.loadout.ts";

machine("m9", { install: [variant(git, "manual"), via(dnf, [git])] });
TS
OUT=$("$BIN" --repo repo compile 2>&1) && fail "a program installed twice must be refused"
echo "$OUT" | grep -qE "^error: programs/profiles\.loadout\.ts:5,[0-9]+: machine 'm9' installs 'git' twice" || fail "the double mapping is named with its file, line and column: $OUT"
# A reference is an import: one the declaring file doesn't export stops
# the compile, naming the module it was looked for in.
ts_file repo/programs/profiles.loadout.ts <<'TS'
import { ghostProgram } from "../root.loadout.ts";

machine("m9", { install: [ghostProgram] });
TS
OUT=$("$BIN" --repo repo compile 2>&1) && fail "an unknown program must not compile"
echo "$OUT" | grep -qE "^error: .*'ghostProgram' not found in module 'root\.loadout\.ts'" ||
    fail "the unknown program is named with the module it isn't in: $OUT"
# A name never imported is a ReferenceError, with its file, line and column.
ts_file repo/programs/profiles.loadout.ts <<'TS'
machine("m9", {
  install: [ghostProgram],
});
TS
OUT=$("$BIN" --repo repo compile 2>&1) && fail "an undefined name must not compile"
echo "$OUT" | grep -qE "^error: programs/profiles\.loadout\.ts:4,[0-9]+: ReferenceError: ghostProgram is not defined$" ||
    fail "the undefined name is named, with its file, line and column, on one line: $OUT"
[ "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" = 1 ] || fail "one line: $OUT"
echo "$OUT" | grep -qE '^ +at .+:[0-9]+:[0-9]+\)?$' && fail "a broken manifest must not crash: $OUT"
rm repo/programs/profiles.loadout.ts
compile_repo repo
ok "a program installed twice, or one that doesn't exist, doesn't compile"

# --- data: declared once, overridden per profile and machine --------------
ts_root datarepo 'data: { omarchy: flag(false), kitty: { opacity: number(0.85) } }' <<'TS'
export const git = program("git", {
  version: "git --version",
  regex: "git version ([0-9.]+)",
  install: [custom("manual", { command: "false" })],
});
TS
ts_file datarepo/machines/machines.loadout.ts <<'TS'
import { git } from "../root.loadout.ts";

const omarchyProfile = profile("omarchy", { data: { omarchy: true } });

machine("m9", {
  extends: [omarchyProfile],
  install: [git],
  data: { kitty: { opacity: 0.99 } },
});

machine("m2", { install: [git] });
TS
compile_repo datarepo
OUT=$("$BIN" --repo datarepo --machine m9 explain) || fail "explain shows a machine with data"
echo "$OUT" | grep -qE "data.kitty.opacity +0.99" || fail "the machine's own value wins: $OUT"
echo "$OUT" | grep -qE "data.omarchy +true" || fail "the profile's value comes through: $OUT"
OUT=$("$BIN" --repo datarepo --machine m2 explain)
echo "$OUT" | grep -qE "data.omarchy +false" || fail "a machine without data gets the defaults: $OUT"
grep -q '"opacity": 0.99' datarepo/loadout.lock.json || fail "the lock carries each machine's merged data"
ts_file datarepo/machines/machines.loadout.ts <<'TS'
import { git } from "../root.loadout.ts";

machine("m9", { install: [git], data: { kitty: { opacty: 0.5 } } });
TS
OUT=$("$BIN" --repo datarepo compile 2>&1) && fail "an undeclared data key must not compile"
echo "$OUT" | grep -q "machine 'm9': data key 'kitty.opacty' is not declared in the data schema" || fail "the typo is named: $OUT"
ok "data defaults, profile and machine values merge, and explain shows them; a typo doesn't compile"

# --- script file that doesn't exist ----------------------------------------
ts_file repo/maintenance/ghost.loadout.ts <<'TS'
script("ghost-script", { file: "scripts/does-not-exist.sh" });
TS
OUT=$("$BIN" --repo repo compile 2>&1) && fail "a missing script file must fail the compile"
echo "$OUT" | grep -q "file 'scripts/does-not-exist.sh' not found" || fail "the missing file is named: $OUT"
rm repo/maintenance/ghost.loadout.ts
ok "a script file that doesn't exist is caught at compile"

# --- installing through a variant the program doesn't have -------------------
ts_repo badmap
ts_file badmap/programs/tool.loadout.ts <<'TS'
const tool = program("tool", {
  install: [via(dnf, { command: "sudo dnf install -y tool" })],
});

machine("m1", { install: [via(brew, [tool])] });
TS
OUT=$("$BIN" --repo badmap compile 2>&1) && fail "a variant the program lacks must fail the compile"
echo "$OUT" | grep -q "machine 'm1' installs 'tool' via 'brew', but it can't be installed that way (it can via: dnf)" || fail "bad-mapping message: $OUT"
ok "a machine can't install a program through a variant it doesn't have"

# --- file: install values run as repo scripts, repo-root cwd, from anywhere
ts_root filerepo <<'TS'
const filetool = program("filetool", {
  version: "test -f installed-marker.txt && echo filetool 1.0",
  regex: "filetool ([0-9.]+)",
  install: [custom("script", { installedBy: "scripts/install-filetool.sh install" })],
});

machine("m1", { install: [filetool] });
TS
mkdir -p filerepo/scripts
# Requires the "install" argument and writes relative to cwd — proves both
# argument passing and repo-root cwd.
printf '#!/bin/sh\n[ "${1:-}" = "install" ] || exit 9\necho done > installed-marker.txt\n' > filerepo/scripts/install-filetool.sh
compile_repo filerepo
OUT=$("$BIN" --repo filerepo --machine m1 setup-new-machine --dry-run)
echo "$OUT" | grep -q "scripts/install-filetool.sh install" || fail "file: value with args shown as the script and its arguments in the plan"
"$BIN" --repo filerepo --machine m1 setup-new-machine --yes >/dev/null || fail "file: install exits 0"
[ -f filerepo/installed-marker.txt ] || fail "install ran with repo-root cwd and args"
ok "file: install values run repo scripts with arguments from the repo root"

rm filerepo/scripts/install-filetool.sh
OUT=$("$BIN" --repo filerepo --machine m1 status 2>&1 || true)
echo "$OUT" | grep -q "file 'scripts/install-filetool.sh' not found" || fail "missing file: script should error at load: $OUT"
ok "a file: install script deleted after compile is caught when the lock is read"

# runScript() works in check commands too.
ts_root filerepo <<'TS'
const filetool = program("filetool", {
  install: [
    custom("script", {
      command: "true",
      version: runScript("scripts/check-filetool.sh"),
      regex: "(done)",
    }),
  ],
});

machine("m1", { install: [filetool] });
TS
printf '#!/bin/sh\necho done\n' > filerepo/scripts/check-filetool.sh
compile_repo filerepo
"$BIN" --repo filerepo --machine m1 status >/dev/null || fail "file: check runs"
grep -q '"version": "done"' filerepo/machines/state/m1.json || fail "file: check observed"
ok "file: works in check commands"

# --- a yes/no check: installed, no version ----------------------------------
ts_root yesno <<'TS'
const setupThing = program("setup-thing", {
  install: [custom({ managedBy: "setup-thing.sh" })],
});

machine("m1", { install: [setupThing] });
TS
printf '#!/bin/sh\ncase "${1:-}" in check) test -f configured.txt ;; install) touch configured.txt ;; esac\n' > yesno/setup-thing.sh
compile_repo yesno
OUT=$("$BIN" --repo yesno --machine m1 explain setup-thing)
echo "$OUT" | grep -q "file:setup-thing.sh check  (yes/no)" || fail "explain shows a yes/no check: $OUT"
OUT=$("$BIN" --repo yesno --machine m1 status)
echo "$OUT" | grep -qE "setup-thing +missing" || fail "a failing yes/no check is missing: $OUT"
"$BIN" --repo yesno --machine m1 install setup-thing --yes >/dev/null || fail "the managing script installs it"
OUT=$("$BIN" --repo yesno --machine m1 status)
echo "$OUT" | grep -qE "setup-thing +installed +-" || fail "a passing yes/no check is installed, with no version: $OUT"
ok "a yes/no check reports installed without a version"

# --- a declaration's folder is its file's -----------------------------------
# Paths are relative to the file a script is declared in, so moving the file
# (with its scripts) to another folder needs no edit.
ts_repo moved
ts_file moved/maintenance/hello/hello.loadout.ts <<'TS'
const hello = script("hello", {
  description: "says hello",
  file: "hello.sh",
  check: "test -f hello-ran.txt",
});

machine("m1", { run: [hello] });
TS
printf '#!/bin/sh\ntouch hello-ran.txt\n' > moved/maintenance/hello/hello.sh
compile_repo moved
"$BIN" --repo moved --machine m1 run hello >/dev/null || fail "the script runs where it's declared"
[ -f moved/maintenance/hello/hello-ran.txt ] || fail "the script ran in its file's folder"
mkdir -p moved/maintenance/greetings
mv moved/maintenance/hello moved/maintenance/greetings/hello
compile_repo moved
"$BIN" --repo moved --machine m1 run hello --force >/dev/null || fail "the moved script runs with no edit"
[ -f moved/maintenance/greetings/hello/hello-ran.txt ] || fail "the moved script ran in its new folder"
OUT=$("$BIN" --repo moved explain hello)
echo "$OUT" | grep -qE "file +hello.sh" || fail "explain shows the path as written: $OUT"
ok "a file's declarations take its folder, so moving it needs no edit"

# --- script variants: the machine picks one ---------------------------------
ts_repo variants
ts_file variants/maintenance/keyboard.loadout.ts <<'TS'
const keyboard = script("keyboard", {
  description: "fn/ctrl swap",
  variants: {
    arch: { file: "arch.sh", check: "test -f arch-ran.txt" },
    fedora: { file: "fedora.sh", check: "test -f fedora-ran.txt" },
  },
});

machine("m1", { run: [variant(keyboard, "fedora")] });

machine("m2", { run: [keyboard] });
TS
printf '#!/bin/sh\ntouch arch-ran.txt\n' > variants/maintenance/arch.sh
printf '#!/bin/sh\ntouch fedora-ran.txt\n' > variants/maintenance/fedora.sh
OUT=$("$BIN" --repo variants compile 2>&1) && fail "running a script with variants without picking one must fail"
echo "$OUT" | grep -q "machine 'm2' runs 'keyboard' without saying which variant (has: arch, fedora)" || fail "the missing pick is named: $OUT"
sed -i.bak '/^machine("m2"/d' variants/maintenance/keyboard.loadout.ts && rm variants/maintenance/keyboard.loadout.ts.bak
compile_repo variants
OUT=$("$BIN" --repo variants --machine m1 explain keyboard)
echo "$OUT" | grep -qE "file +fedora.sh" || fail "explain shows the machine's variant: $OUT"
"$BIN" --repo variants --machine m1 run keyboard >/dev/null || fail "the variant runs"
[ -f variants/maintenance/fedora-ran.txt ] || fail "the machine's variant's file ran"
[ -f variants/maintenance/arch-ran.txt ] && fail "the other variant must not run" || true
grep -q '"status": "done"' variants/machines/state/m1.json || fail "the variant's own check observed it done"
ok "a machine runs the script variant it picked, checked by that variant's check"

# --- no lock, and a custom state directory ----------------------------------
"$BIN" --repo /nonexistent status >/dev/null 2>&1 && fail "a missing repo should exit 1" || true
OUT=$("$BIN" --repo /nonexistent status 2>&1 || true)
echo "$OUT" | grep -qx "error: no loadout.lock.json in /nonexistent — run: loadout compile" || fail "clean missing-lock error: $OUT"
ok "a repo without a lock gives one clean line"

ts_root custom <<'TS'
const git = program("git", {
  version: "git --version",
  regex: "git version ([0-9.]+)",
  install: [custom("manual", { command: "false" })],
});

machine("m1", { install: [git] });
TS
sed -i.bak 's|state: "machines/state"|state: "observed"|' custom/loadout.ts && rm custom/loadout.ts.bak
rm -rf custom/state custom/machines/state
compile_repo custom
"$BIN" --repo custom --machine m1 status >/dev/null || fail "a custom state dir loads"
[ -f custom/observed/m1.json ] || fail "state lands in the repo's state directory"
[ -d custom/machines/state ] && fail "nothing is written to a default state dir" || true
ok "state goes where the repo says"

# --- compile warns about what no machine uses -------------------------------
ts_repo unused
ts_file unused/programs/tools.loadout.ts <<'TS'
const tool = program("tool", { install: [dnf, brew] });

program("orphan", { install: [dnf] });

const jq = program("jq", { install: [brew] });

machine("m1", { install: [via(dnf, [tool]), jq] });
TS
OUT=$("$BIN" --repo unused compile 2>&1) || fail "warnings don't fail the compile: $OUT"
echo "$OUT" | grep -q "wrote loadout.lock.json" || fail "the lock is written anyway: $OUT"
echo "$OUT" | grep -q "program 'orphan' isn't installed on any machine" || fail "an unused program is named: $OUT"
echo "$OUT" | grep -q "program 'tool': machine 'm1' installs other programs via 'brew', but not tool" || fail "an unpicked way through an installer in use is named: $OUT"
ts_file unused/programs/tools.loadout.ts <<'TS'
const tool = program("tool", { install: [dnf, via(brew, { spare: "for macOS" })] });

const orphan = program("orphan", { spare: "for later", install: [dnf] });

const jq = program("jq", { install: [brew] });

machine("m1", { install: [via(dnf, [tool, orphan]), jq] });
TS
OUT=$("$BIN" --repo unused compile 2>&1) || fail "spare marks compile: $OUT"
echo "$OUT" | grep -q "tool" && fail "a spare variant isn't warned about: $OUT"
echo "$OUT" | grep -q "program 'orphan' is marked spare, but machine 'm1' uses it" || fail "a stale spare mark is named: $OUT"
ok "compile warns about what no machine uses, unless it's marked spare"

# A transitional script is named for deletion once every machine that runs
# it reports it done, read from their state files.
ts_root transit <<'TS'
export const cleanup = script("cleanup", {
  run: "rm -f old.txt",
  check: "test ! -e old.txt",
  transitional: true,
});
TS
ts_file transit/machines/machines.loadout.ts <<'TS'
import { cleanup } from "../root.loadout.ts";

machine("m1", { run: [cleanup] });

machine("m2", { run: [cleanup] });
TS
touch transit/old.txt
OUT=$("$BIN" --repo transit compile 2>&1) || fail "a transitional script compiles: $OUT"
OUT=$("$BIN" --repo transit --machine m1 status 2>&1 || true)
echo "$OUT" | grep -q "cleanup" || fail "m1 runs the transitional script: $OUT"
OUT=$("$BIN" --repo transit compile 2>&1)
echo "$OUT" | grep -q "transitional" && fail "not done anywhere yet, nothing is said: $OUT"
rm transit/old.txt
"$BIN" --repo transit --machine m1 status >/dev/null
OUT=$("$BIN" --repo transit compile 2>&1)
echo "$OUT" | grep -q "transitional" && fail "m2 has no state yet, so it hasn't done it: $OUT"
"$BIN" --repo transit --machine m2 status >/dev/null
OUT=$("$BIN" --repo transit compile 2>&1)
echo "$OUT" | grep -q "script 'cleanup' is done on every machine that runs it (m1, m2): it's transitional, so delete it" ||
    fail "done everywhere, it's named for deletion: $OUT"
ok "compile names a transitional script every machine has done"

# --- a syntax error ----------------------------------------------------------
# One line, with its file, line and column, like every manifest mistake.
ts_repo syntax
ts_file syntax/maintenance/broken.loadout.ts <<'TS'
script("broken", {
  run: "true",
  check: [
});
TS
OUT=$("$BIN" --repo syntax compile 2>&1) && fail "a syntax error must not compile"
echo "$OUT" | grep -qE '^ +at .+:[0-9]+:[0-9]+\)?$' && fail "a broken manifest must not crash: $OUT"
echo "$OUT" | grep -qE '^error: maintenance/broken\.loadout\.ts:[0-9]+,[0-9]+: ' || fail "the syntax error is reported with its file, line and column: $OUT"
ok "a syntax error is reported as error: <file>:<line>,<col>, and the compile fails"
