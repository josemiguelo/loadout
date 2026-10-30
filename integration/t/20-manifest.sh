# What a compiled manifest means: params, file: paths, profiles, data,
# script variants and yes/no checks; and the mistakes compile (or the
# binary reading the lock) refuses.

# --- installer params ----------------------------------------------------
hcl_repo paramrepo
hcl_file paramrepo/programs/tool.loadout.hcl <<'HCL'
installer "faux" {
  params  = ["flavor"]
  install = "echo installing {pkg} from {flavor}"
  check   = "echo {pkg} 1.0"
  regex   = "([0-9.]+)"
}

program "tool" {
  via "faux" {
    params = { flavor = "vanilla" }
  }
}

machine "m1" {
  install = [program.tool]
}
HCL
compile_repo paramrepo
OUT=$("$BIN" --repo paramrepo --machine m1 explain tool)
echo "$OUT" | grep -q "echo installing tool from vanilla" || fail "installer params substitute"
hcl_file paramrepo/programs/tool.loadout.hcl <<'HCL'
installer "faux" {
  params  = ["flavor"]
  install = "echo {flavor}"
}

program "tool" {
  install_via = [faux]
}

machine "m1" {
  install = [program.tool]
}
HCL
OUT=$("$BIN" --repo paramrepo compile 2>&1) && fail "a missing param must fail the compile"
echo "$OUT" | grep -q "needs a value for 'flavor'" || fail "the missing param is named: $OUT"
ok "installers take declared params, and a missing one is a compile error"

# A file: param is a path next to the program's own file, wherever the
# installer's command runs (here: the repo root, where loadout.hcl
# declares it).
hcl_root fparam <<'HCL'
installer "copyin" {
  params  = ["src"]
  install = "cp {src} installed-{pkg}.txt"
  check   = "cat installed-{pkg}.txt"
  regex   = "([0-9.]+)"
}
HCL
hcl_file fparam/programs/tool/tool.loadout.hcl <<'HCL'
program "tool" {
  via "copyin" {
    params = { src = file("payload.txt") }
  }
}

machine "m1" {
  install = [program.tool]
}
HCL
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
hcl_file repo/programs/split.loadout.hcl <<'HCL'
program "splitprog" {
  version = "git --version"
  regex   = "git version ([0-9.]+)"
  custom "manual" {
    command = "false"
  }
}

machine "m3" {
  install = [variant(program.git, "manual"), program.splitprog]
}
HCL
compile_repo repo
"$BIN" --repo repo --machine m3 status >/dev/null || fail "status with programs in another file"
grep -q '"splitprog"' repo/machines/state/m3.json || fail "the other file's program is checked"
"$BIN" --repo repo --machine m3 setup-new-machine --dry-run >/dev/null || fail "its machine plans"
rm repo/programs/split.loadout.hcl repo/machines/state/m3.json
compile_repo repo
ok "every file the sources globs match compiles into one manifest"

# --- profiles ------------------------------------------------------------
hcl_file repo/programs/profiles.loadout.hcl <<'HCL'
profile "testbase" {
  install = [variant(program.git, "manual")]
  run     = [script.marker]
}

machine "m9" {
  extends = [profile.testbase]
}
HCL
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

hcl_file repo/programs/profiles.loadout.hcl <<'HCL'
profile "a" {
  install = [variant(program.git, "manual")]
}

profile "b" {
  via "dnf" {
    install = [program.git]
  }
}

machine "m9" {
  extends = [profile.a, profile.b]
}
HCL
OUT=$("$BIN" --repo repo compile 2>&1) && fail "two profiles mapping a program differently must fail"
echo "$OUT" | grep -q "machine 'm9': profiles 'a' and 'b' map 'git' differently ('manual' vs 'dnf')" || fail "the disagreement is named: $OUT"
ok "two profiles of one machine that disagree are a compile error"

hcl_file repo/programs/profiles.loadout.hcl <<'HCL'
machine "m9" {
  install = [variant(program.git, "manual")]
  via "dnf" {
    install = [program.git]
  }
}
HCL
OUT=$("$BIN" --repo repo compile 2>&1) && fail "a program installed twice must be refused"
echo "$OUT" | grep -q "machine 'm9' installs 'git' twice" || fail "the double mapping is named: $OUT"
hcl_file repo/programs/profiles.loadout.hcl <<'HCL'
machine "m9" {
  install = [program.ghost-program]
}
HCL
OUT=$("$BIN" --repo repo compile 2>&1) && fail "an unknown program must not compile"
echo "$OUT" | grep -qE '^error: ([^ ]*/)?programs/profiles\.loadout\.hcl:2,[0-9]+: Unsupported attribute; This object does not have an attribute named "ghost-program"' ||
    fail "the unknown program is named with its file, line and column: $OUT"
rm repo/programs/profiles.loadout.hcl
compile_repo repo
ok "a program installed twice, or one that doesn't exist, doesn't compile"

# Every diagnostic is reported, one line each, before the exit: two
# unknown names in one file. A syntax error is reported the same way.
hcl_file repo/programs/profiles.loadout.hcl <<'HCL'
machine "m9" {
  install = [program.ghost-program]
  run     = [script.ghost-script]
}
HCL
OUT=$("$BIN" --repo repo compile 2>&1) && fail "unknown names must not compile"
echo "$OUT" | grep -qE '^error: ([^ ]*/)?programs/profiles\.loadout\.hcl:2,[0-9]+: .*"ghost-program"' || fail "the first unknown name is reported: $OUT"
echo "$OUT" | grep -qE '^error: ([^ ]*/)?programs/profiles\.loadout\.hcl:3,[0-9]+: .*"ghost-script"' || fail "and the second: $OUT"
rm repo/programs/profiles.loadout.hcl
hcl_file repo/maintenance/broken.loadout.hcl <<'HCL'
script "broken" {
  run = "true"
  check = [
}
HCL
OUT=$("$BIN" --repo repo compile 2>&1) && fail "a syntax error must not compile"
echo "$OUT" | grep -qE '^error: ([^ ]*/)?maintenance/broken\.loadout\.hcl:[0-9]+,[0-9]+: ' || fail "the syntax error is reported with its file, line and column: $OUT"
echo "$OUT" | grep -qE '^panic:|goroutine [0-9]+' && fail "a broken manifest must not crash: $OUT"
rm repo/maintenance/broken.loadout.hcl
OUT=$("$BIN" --repo repo compile 2>&1) || fail "the repo compiles again: $OUT"
ok "every HCL diagnostic is reported as error: <file>:<line>,<col>, and the compile fails"

# --- data: declared once, overridden per profile and machine --------------
hcl_root datarepo <<'HCL'
data {
  omarchy = flag(false)
  kitty {
    opacity = number(0.85)
  }
}

program "git" {
  version = "git --version"
  regex   = "git version ([0-9.]+)"
  custom "manual" {
    command = "false"
  }
}
HCL
hcl_file datarepo/machines/machines.loadout.hcl <<'HCL'
profile "omarchy" {
  data = { omarchy = true }
}

machine "m9" {
  extends = [profile.omarchy]
  install = [program.git]
  data    = { kitty = { opacity = 0.99 } }
}

machine "m2" {
  install = [program.git]
}
HCL
compile_repo datarepo
OUT=$("$BIN" --repo datarepo --machine m9 explain) || fail "explain shows a machine with data"
echo "$OUT" | grep -qE "data.kitty.opacity +0.99" || fail "the machine's own value wins: $OUT"
echo "$OUT" | grep -qE "data.omarchy +true" || fail "the profile's value comes through: $OUT"
OUT=$("$BIN" --repo datarepo --machine m2 explain)
echo "$OUT" | grep -qE "data.omarchy +false" || fail "a machine without data gets the defaults: $OUT"
grep -q '"opacity": 0.99' datarepo/loadout.lock.json || fail "the lock carries each machine's merged data"
hcl_file datarepo/machines/machines.loadout.hcl <<'HCL'
machine "m9" {
  install = [program.git]
  data    = { kitty = { opacty = 0.5 } }
}
HCL
OUT=$("$BIN" --repo datarepo compile 2>&1) && fail "an undeclared data key must not compile"
echo "$OUT" | grep -q "machine 'm9': data key 'kitty.opacty' is not declared in the data schema" || fail "the typo is named: $OUT"
ok "data defaults, profile and machine values merge, and explain shows them; a typo doesn't compile"

# --- script file that doesn't exist ----------------------------------------
hcl_file repo/maintenance/ghost.loadout.hcl <<'HCL'
script "ghost-script" {
  file = "scripts/does-not-exist.sh"
}
HCL
OUT=$("$BIN" --repo repo compile 2>&1) && fail "a missing script file must fail the compile"
echo "$OUT" | grep -q "file 'scripts/does-not-exist.sh' not found" || fail "the missing file is named: $OUT"
rm repo/maintenance/ghost.loadout.hcl
ok "a script file that doesn't exist is caught at compile"

# --- installing through a variant the program doesn't have -------------------
hcl_repo badmap
hcl_file badmap/programs/tool.loadout.hcl <<'HCL'
program "tool" {
  via "dnf" {
    command = "sudo dnf install -y tool"
  }
}

machine "m1" {
  via "brew" {
    install = [program.tool]
  }
}
HCL
OUT=$("$BIN" --repo badmap compile 2>&1) && fail "a variant the program lacks must fail the compile"
echo "$OUT" | grep -q "machine 'm1' installs 'tool' via 'brew', but it can't be installed that way (it can via: dnf)" || fail "bad-mapping message: $OUT"
ok "a machine can't install a program through a variant it doesn't have"

# --- file: install values run as repo scripts, repo-root cwd, from anywhere
hcl_root filerepo <<'HCL'
program "filetool" {
  version = "test -f installed-marker.txt && echo filetool 1.0"
  regex   = "filetool ([0-9.]+)"
  custom "script" {
    installed_by = "scripts/install-filetool.sh install"
  }
}

machine "m1" {
  install = [program.filetool]
}
HCL
mkdir -p filerepo/scripts
# Requires the "install" argument and writes relative to cwd — proves both
# argument passing and repo-root cwd.
printf '#!/bin/sh\n[ "${1:-}" = "install" ] || exit 9\necho done > installed-marker.txt\n' > filerepo/scripts/install-filetool.sh
compile_repo filerepo
OUT=$("$BIN" --repo filerepo --machine m1 setup-new-machine --dry-run)
echo "$OUT" | grep -q "sh 'scripts/install-filetool.sh' install" || fail "file: value with args translated in plan"
"$BIN" --repo filerepo --machine m1 setup-new-machine --yes >/dev/null || fail "file: install exits 0"
[ -f filerepo/installed-marker.txt ] || fail "install ran with repo-root cwd and args"
ok "file: install values run repo scripts with arguments from the repo root"

rm filerepo/scripts/install-filetool.sh
OUT=$("$BIN" --repo filerepo --machine m1 status 2>&1 || true)
echo "$OUT" | grep -q "file 'scripts/install-filetool.sh' not found" || fail "missing file: script should error at load: $OUT"
ok "a file: install script deleted after compile is caught when the lock is read"

# file: works in check commands too.
hcl_root filerepo <<'HCL'
program "filetool" {
  custom "script" {
    command = "true"
    version = run_script("scripts/check-filetool.sh")
    regex   = "(done)"
  }
}

machine "m1" {
  install = [program.filetool]
}
HCL
printf '#!/bin/sh\necho done\n' > filerepo/scripts/check-filetool.sh
compile_repo filerepo
"$BIN" --repo filerepo --machine m1 status >/dev/null || fail "file: check runs"
grep -q '"version": "done"' filerepo/machines/state/m1.json || fail "file: check observed"
ok "file: works in check commands"

# --- a yes/no check: installed, no version ----------------------------------
hcl_root yesno <<'HCL'
program "setup-thing" {
  custom {
    managed_by = "setup-thing.sh"
  }
}

machine "m1" {
  install = [program.setup-thing]
}
HCL
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
hcl_repo moved
hcl_file moved/maintenance/hello/hello.loadout.hcl <<'HCL'
script "hello" {
  description = "says hello"
  file        = "hello.sh"
  check       = "test -f hello-ran.txt"
}

machine "m1" {
  run = [script.hello]
}
HCL
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
hcl_repo variants
hcl_file variants/maintenance/keyboard.loadout.hcl <<'HCL'
script "keyboard" {
  description = "fn/ctrl swap"
  variant "arch" {
    file  = "arch.sh"
    check = "test -f arch-ran.txt"
  }
  variant "fedora" {
    file  = "fedora.sh"
    check = "test -f fedora-ran.txt"
  }
}

machine "m1" {
  run = [variant(script.keyboard, "fedora")]
}

machine "m2" {
  run = [script.keyboard]
}
HCL
printf '#!/bin/sh\ntouch arch-ran.txt\n' > variants/maintenance/arch.sh
printf '#!/bin/sh\ntouch fedora-ran.txt\n' > variants/maintenance/fedora.sh
OUT=$("$BIN" --repo variants compile 2>&1) && fail "running a script with variants without picking one must fail"
echo "$OUT" | grep -q "machine 'm2' runs 'keyboard' without saying which variant (has: arch, fedora)" || fail "the missing pick is named: $OUT"
hcl_file variants/maintenance/keyboard.loadout.hcl <<'HCL'
script "keyboard" {
  description = "fn/ctrl swap"
  variant "arch" {
    file  = "arch.sh"
    check = "test -f arch-ran.txt"
  }
  variant "fedora" {
    file  = "fedora.sh"
    check = "test -f fedora-ran.txt"
  }
}

machine "m1" {
  run = [variant(script.keyboard, "fedora")]
}
HCL
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

hcl_file custom/loadout.hcl <<'HCL'
repo {
  name    = "test"
  state   = "observed"
  sources = ["programs/**/*.loadout.hcl", "maintenance/**/*.loadout.hcl", "machines/**/*.loadout.hcl"]
}

program "git" {
  version = "git --version"
  regex   = "git version ([0-9.]+)"
  custom "manual" {
    command = "false"
  }
}

machine "m1" {
  install = [program.git]
}
HCL
rm -rf custom/state
compile_repo custom
"$BIN" --repo custom --machine m1 status >/dev/null || fail "a custom state dir loads"
[ -f custom/observed/m1.json ] || fail "state lands in the repo's state directory"
[ -d custom/state ] && fail "nothing is written to a default state dir" || true
ok "state goes where the repo says"

# --- compile warns about what no machine uses -------------------------------
hcl_repo unused
hcl_file unused/programs/tools.loadout.hcl <<'HCL'
program "tool" {
  install_via = [dnf, brew]
}

program "orphan" {
  install_via = [dnf]
}

program "jq" {
  install_via = [brew]
}

machine "m1" {
  via "dnf" {
    install = [program.tool]
  }
  install = [program.jq]
}
HCL
OUT=$("$BIN" --repo unused compile 2>&1) || fail "warnings don't fail the compile: $OUT"
echo "$OUT" | grep -q "wrote loadout.lock.json" || fail "the lock is written anyway: $OUT"
echo "$OUT" | grep -q "program 'orphan' isn't installed on any machine" || fail "an unused program is named: $OUT"
echo "$OUT" | grep -q "program 'tool': machine 'm1' installs other programs via 'brew', but not tool" || fail "an unpicked way through an installer in use is named: $OUT"
hcl_file unused/programs/tools.loadout.hcl <<'HCL'
program "tool" {
  install_via = [dnf]
  via "brew" {
    spare = "for macOS"
  }
}

program "orphan" {
  spare       = "for later"
  install_via = [dnf]
}

program "jq" {
  install_via = [brew]
}

machine "m1" {
  via "dnf" {
    install = [program.tool, program.orphan]
  }
  install = [program.jq]
}
HCL
OUT=$("$BIN" --repo unused compile 2>&1) || fail "spare marks compile: $OUT"
echo "$OUT" | grep -q "tool" && fail "a spare variant isn't warned about: $OUT"
echo "$OUT" | grep -q "program 'orphan' is marked spare, but machine 'm1' uses it" || fail "a stale spare mark is named: $OUT"
ok "compile warns about what no machine uses, unless it's marked spare"

# A transitional script is named for deletion once every machine that runs
# it reports it done, read from their state files.
hcl_root transit <<'HCL'
script "cleanup" {
  run          = "rm -f old.txt"
  check        = "test ! -e old.txt"
  transitional = true
}
HCL
hcl_file transit/machines/machines.loadout.hcl <<'HCL'
machine "m1" {
  run = [script.cleanup]
}

machine "m2" {
  run = [script.cleanup]
}
HCL
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
