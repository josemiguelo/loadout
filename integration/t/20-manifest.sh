# What a compiled manifest means: params, file: paths, profiles, data,
# script variants and yes/no checks; and the mistakes compile (or the
# binary reading the lock) refuses.

# --- installer params ----------------------------------------------------
kt_repo paramrepo
kt_file paramrepo/programs/tool.loadout.kt <<'KT'
val faux = root.installer("faux") {
    params("flavor")
    install = "echo installing {pkg} from {flavor}"
    check = "echo {pkg} 1.0"
    regex = "([0-9.]+)"
}

val tool = root.program("tool") {
    installVia(faux { param("flavor", "vanilla") })
}

val m1 = machine("m1") { install(tool) }
KT
compile_repo paramrepo
OUT=$("$BIN" --repo paramrepo --machine m1 explain tool)
echo "$OUT" | grep -q "echo installing tool from vanilla" || fail "installer params substitute"
kt_file paramrepo/programs/tool.loadout.kt <<'KT'
val faux = root.installer("faux") {
    params("flavor")
    install = "echo {flavor}"
}

val tool = root.program("tool") { installVia(faux) }

val m1 = machine("m1") { install(tool) }
KT
OUT=$("$BIN" --repo paramrepo compile 2>&1) && fail "a missing param must fail the compile"
echo "$OUT" | grep -q "needs a value for 'flavor'" || fail "the missing param is named: $OUT"
ok "installers take declared params, and a missing one is a compile error"

# A file: param is a path next to the program's own file, wherever the
# installer's command runs (here: the repo root).
kt_repo fparam
kt_file fparam/programs/tool/tool.loadout.kt <<'KT'
val copyin = root.installer("copyin") {
    params("src")
    install = "cp {src} installed-{pkg}.txt"
    check = "cat installed-{pkg}.txt"
    regex = "([0-9.]+)"
}

val tool = program("tool") {
    installVia(copyin { param("src", file("payload.txt")) })
}

val m1 = machine("m1") { install(tool) }
KT
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
kt_file repo/programs/split.loadout.kt <<'KT'
val splitprog = root.program("splitprog") {
    version("git --version", "git version ([0-9.]+)")
    custom("manual") { command = "false" }
}

val m3 = machine("m3") {
    install(git.variant("manual"), splitprog)
}
KT
compile_repo repo
"$BIN" --repo repo --machine m3 status >/dev/null || fail "status with programs in another file"
grep -q '"splitprog"' repo/state/m3.json || fail "the other file's program is checked"
"$BIN" --repo repo --machine m3 setup-new-machine --dry-run >/dev/null || fail "its machine plans"
rm repo/programs/split.loadout.kt repo/state/m3.json
compile_repo repo
ok "every file the sources globs match compiles into one manifest"

# --- profiles ------------------------------------------------------------
kt_file repo/programs/profiles.loadout.kt <<'KT'
val testbase = profile("testbase") {
    install(git.variant("manual"))
    run(marker)
}

val m9 = machine("m9") { extends(testbase) }
KT
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

kt_file repo/programs/profiles.loadout.kt <<'KT'
val a = profile("a") { install(git.variant("manual")) }
val b = profile("b") { install(Builtin.dnf, git) }
val m9 = machine("m9") { extends(a, b) }
KT
OUT=$("$BIN" --repo repo compile 2>&1) && fail "two profiles mapping a program differently must fail"
echo "$OUT" | grep -q "machine 'm9': profiles 'a' and 'b' map 'git' differently ('manual' vs 'dnf')" || fail "the disagreement is named: $OUT"
ok "two profiles of one machine that disagree are a compile error"

kt_file repo/programs/profiles.loadout.kt <<'KT'
val m9 = machine("m9") {
    install(git.variant("manual"))
    install(Builtin.dnf, git)
}
KT
OUT=$("$BIN" --repo repo compile 2>&1) && fail "a program installed twice must be refused"
echo "$OUT" | grep -q "machine 'm9' installs 'git' twice" || fail "the double mapping is named: $OUT"
kt_file repo/programs/profiles.loadout.kt <<'KT'
val m9 = machine("m9") { install(ghostProgram) }
KT
OUT=$("$BIN" --repo repo compile 2>&1) && fail "an unknown program must not compile"
echo "$OUT" | grep -q "profiles.loadout.kt.*Unresolved reference 'ghostProgram'" || fail "Kotlin names the unknown program and its file: $OUT"
rm repo/programs/profiles.loadout.kt
compile_repo repo
ok "a program installed twice, or one that doesn't exist, doesn't compile"

# --- data: declared once, overridden per profile and machine --------------
kt_repo datarepo
kt_file datarepo/loadout.kt <<'KT'
val repo = repo(name = "test", state = "state", data = ::Data)

class Data : MachineData() {
    var omarchy by flag(false)
    val kitty by table(::Kitty)

    class Kitty : MachineData() {
        var opacity by number(0.85)
    }
}

fun MachineScope.data(block: Data.() -> Unit) = data(::Data, block)

val git = root.program("git") {
    version("git --version", "git version ([0-9.]+)")
    custom("manual") { command = "false" }
}
KT
kt_file datarepo/machines.loadout.kt <<'KT'
val omarchyProfile = profile("omarchy") { data { omarchy = true } }

val m9 = machine("m9") {
    extends(omarchyProfile)
    install(git)
    data { kitty.opacity = 0.99 }
}

val m2 = machine("m2") { install(git) }
KT
compile_repo datarepo
OUT=$("$BIN" --repo datarepo --machine m9 explain) || fail "explain shows a machine with data"
echo "$OUT" | grep -qE "data.kitty.opacity +0.99" || fail "the machine's own value wins: $OUT"
echo "$OUT" | grep -qE "data.omarchy +true" || fail "the profile's value comes through: $OUT"
OUT=$("$BIN" --repo datarepo --machine m2 explain)
echo "$OUT" | grep -qE "data.omarchy +false" || fail "a machine without data gets the defaults: $OUT"
grep -q '"opacity": 0.99' datarepo/loadout.lock.json || fail "the lock carries each machine's merged data"
kt_file datarepo/machines.loadout.kt <<'KT'
val m9 = machine("m9") {
    install(git)
    data { kitty.opacty = 0.5 }
}
KT
OUT=$("$BIN" --repo datarepo compile 2>&1) && fail "an undeclared data key must not compile"
echo "$OUT" | grep -q "Unresolved reference 'opacty'" || fail "Kotlin names the typo: $OUT"
ok "data defaults, profile and machine values merge, and explain shows them; a typo doesn't compile"

# --- script file that doesn't exist ----------------------------------------
kt_file repo/maintenance/ghost.loadout.kt <<'KT'
val ghostScript = root.script("ghost-script") { file("scripts/does-not-exist.sh") }
KT
OUT=$("$BIN" --repo repo compile 2>&1) && fail "a missing script file must fail the compile"
echo "$OUT" | grep -q "file 'scripts/does-not-exist.sh' not found" || fail "the missing file is named: $OUT"
rm repo/maintenance/ghost.loadout.kt
ok "a script file that doesn't exist is caught at compile"

# --- installing through a variant the program doesn't have -------------------
kt_repo badmap
kt_file badmap/programs/tool.loadout.kt <<'KT'
val tool = root.program("tool") {
    installVia(Builtin.dnf { command = "sudo dnf install -y tool" })
}

val m1 = machine("m1") { install(Builtin.brew, tool) }
KT
OUT=$("$BIN" --repo badmap compile 2>&1) && fail "a variant the program lacks must fail the compile"
echo "$OUT" | grep -q "machine 'm1' installs 'tool' through 'brew', but it has no such variant (has: dnf)" || fail "bad-mapping message: $OUT"
ok "a machine can't install a program through a variant it doesn't have"

# --- file: install values run as repo scripts, repo-root cwd, from anywhere
kt_repo filerepo
kt_file filerepo/programs/filetool.loadout.kt <<'KT'
val filetool = root.program("filetool") {
    version("test -f installed-marker.txt && echo filetool 1.0", "filetool ([0-9.]+)")
    custom("script") { command = "file:scripts/install-filetool.sh install" }
}

val m1 = machine("m1") { install(filetool) }
KT
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
kt_file filerepo/programs/filetool.loadout.kt <<'KT'
val filetool = root.program("filetool") {
    custom("script") {
        command = "true"
        version("file:scripts/check-filetool.sh", "(done)")
    }
}

val m1 = machine("m1") { install(filetool) }
KT
printf '#!/bin/sh\necho done\n' > filerepo/scripts/check-filetool.sh
compile_repo filerepo
"$BIN" --repo filerepo --machine m1 status >/dev/null || fail "file: check runs"
grep -q '"version": "done"' filerepo/state/m1.json || fail "file: check observed"
ok "file: works in check commands"

# --- a yes/no check: installed, no version ----------------------------------
kt_repo yesno
kt_file yesno/programs/setup.loadout.kt <<'KT'
val setupThing = root.program("setup-thing") {
    custom { managedBy("setup-thing.sh") }
}

val m1 = machine("m1") { install(setupThing) }
KT
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
kt_repo moved
kt_file moved/maintenance/hello/hello.loadout.kt <<'KT'
val hello = script("hello", "says hello") {
    file("hello.sh")
    check("test -f hello-ran.txt")
}

val m1 = machine("m1") { run(hello) }
KT
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

# A namespace: declarations inside an object take their file's folder too,
# and keep their own names (a machine runs Things.hello as "things-hello").
kt_repo spaced
kt_file spaced/maintenance/things/things.loadout.kt <<'KT'
object Things {
    val hello = script(name = "things-hello", description = "says hello") {
        file("hello.sh")
        check("test -f hello-ran.txt")
    }
}

val m1 = machine(hostname = "m1") { run(Things.hello) }
KT
printf '#!/bin/sh\ntouch hello-ran.txt\n' > spaced/maintenance/things/hello.sh
compile_repo spaced
"$BIN" --repo spaced --machine m1 run things-hello >/dev/null || fail "a script declared in an object runs"
[ -f spaced/maintenance/things/hello-ran.txt ] || fail "an object's script runs in its file's folder"
ok "an object groups declarations; they keep their names and their file's folder"

# --- script variants: the machine picks one ---------------------------------
kt_repo variants
kt_file variants/maintenance/keyboard.loadout.kt <<'KT'
val keyboard = script("keyboard", "fn/ctrl swap") {
    variant("arch") {
        file("arch.sh")
        check("test -f arch-ran.txt")
    }
    variant("fedora") {
        file("fedora.sh")
        check("test -f fedora-ran.txt")
    }
}

val m1 = machine("m1") { run(keyboard.variant("fedora")) }
val m2 = machine("m2") { run(keyboard) }
KT
printf '#!/bin/sh\ntouch arch-ran.txt\n' > variants/maintenance/arch.sh
printf '#!/bin/sh\ntouch fedora-ran.txt\n' > variants/maintenance/fedora.sh
OUT=$("$BIN" --repo variants compile 2>&1) && fail "running a script with variants without picking one must fail"
echo "$OUT" | grep -q "machine 'm2' runs 'keyboard' without saying which variant (has: arch, fedora)" || fail "the missing pick is named: $OUT"
kt_file variants/maintenance/keyboard.loadout.kt <<'KT'
val keyboard = script("keyboard", "fn/ctrl swap") {
    variant("arch") {
        file("arch.sh")
        check("test -f arch-ran.txt")
    }
    variant("fedora") {
        file("fedora.sh")
        check("test -f fedora-ran.txt")
    }
}

val m1 = machine("m1") { run(keyboard.variant("fedora")) }
KT
compile_repo variants
OUT=$("$BIN" --repo variants --machine m1 explain keyboard)
echo "$OUT" | grep -qE "file +fedora.sh" || fail "explain shows the machine's variant: $OUT"
"$BIN" --repo variants --machine m1 run keyboard >/dev/null || fail "the variant runs"
[ -f variants/maintenance/fedora-ran.txt ] || fail "the machine's variant's file ran"
[ -f variants/maintenance/arch-ran.txt ] && fail "the other variant must not run" || true
grep -q '"status": "done"' variants/state/m1.json || fail "the variant's own check observed it done"
ok "a machine runs the script variant it picked, checked by that variant's check"

# --- no lock, and a custom state directory ----------------------------------
"$BIN" --repo /nonexistent status >/dev/null 2>&1 && fail "a missing repo should exit 1" || true
OUT=$("$BIN" --repo /nonexistent status 2>&1 || true)
echo "$OUT" | grep -qx "error: no loadout.lock.json in /nonexistent — run: loadout compile" || fail "clean missing-lock error: $OUT"
ok "a repo without a lock gives one clean line"

kt_repo custom
kt_file custom/loadout.kt <<'KT'
val repo = repo(name = "test", state = "observed")

val git = root.program("git") {
    version("git --version", "git version ([0-9.]+)")
    custom("manual") { command = "false" }
}

val m1 = machine("m1") { install(git) }
KT
rm -rf custom/state
compile_repo custom
"$BIN" --repo custom --machine m1 status >/dev/null || fail "a custom state dir loads"
[ -f custom/observed/m1.json ] || fail "state lands in the repo's state directory"
[ -d custom/state ] && fail "nothing is written to a default state dir" || true
ok "state goes where the repo says"
