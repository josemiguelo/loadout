# status observes; setup-new-machine / install converge; explain resolves.

basic_repo repo

# --- status -------------------------------------------------------------
"$BIN" --repo repo --machine m1 status >/dev/null || fail "status exits 0"
[ -f repo/machines/state/m1.json ] || fail "status writes state file"
grep -q '"status": "installed"' repo/machines/state/m1.json || fail "git detected as installed"
grep -q '"machine": "m1"' repo/machines/state/m1.json || fail "machine name recorded"
# The marker script never ran, but its check is observed -> pending.
grep -q '"marker"' repo/machines/state/m1.json || fail "script check observed on status"
grep -q '"status": "pending"' repo/machines/state/m1.json || fail "unrun script recorded as pending"
ok "status detects git, observes script checks, and writes state"

"$BIN" --repo repo --machine m1 status --json | grep -q '"schemaVersion": 1' || fail "status --json"
ok "status --json emits the state document"

# --- setup-new-machine (dry run + already installed) ----------------------
OUT=$("$BIN" --repo repo --machine m1 setup-new-machine --dry-run)
echo "$OUT" | grep -q "git" || fail "dry-run mentions git"
echo "$OUT" | grep -qE "~ marker +script" || fail "dry-run lists the script"
[ ! -f repo/marker.txt ] || fail "dry-run must not execute scripts"
ok "setup-new-machine --dry-run plans without executing"

"$BIN" --repo repo --machine m1 setup-new-machine --yes --skip-scripts >/dev/null || fail "install (all installed) exits 0"
ok "setup-new-machine with everything installed is a no-op"

# --- install (targeted programs; scripts are run's job) ------------------
OUT=$("$BIN" --repo repo --machine m1 install git --dry-run) || fail "install with names exits 0"
echo "$OUT" | grep -q "git" || fail "install plans the named program"
echo "$OUT" | grep -q "marker" && fail "install must not touch scripts" || true
"$BIN" --repo repo --machine m1 install ghost-prog --dry-run >/dev/null 2>&1 && fail "unknown program should fail" || true
"$BIN" --repo repo --machine m1 setup-new-machine git --dry-run >/dev/null 2>&1 && fail "setup-new-machine must not accept names" || true
ok "install targets named programs; setup-new-machine takes no names"

OUT=$("$BIN" --repo repo --machine m1 install --all --dry-run) || fail "install --all exits 0"
echo "$OUT" | grep -q "git" || fail "install --all plans every mapped program"
echo "$OUT" | grep -q "marker" && fail "install --all must not touch scripts" || true
"$BIN" --repo repo --machine m1 install --all git --dry-run >/dev/null 2>&1 && fail "--all with names should fail" || true
"$BIN" --repo repo --machine m1 install --dry-run >/dev/null 2>&1 && fail "install with no names and no --all should fail" || true
ok "install --all covers this machine's mapped programs, and rejects names alongside it"

# --- setup-new-machine runs eligible scripts -----------------------------
"$BIN" --repo repo --machine m1 setup-new-machine --yes >/dev/null || fail "install with script exits 0"
[ -f repo/marker.txt ] || fail "install ran the script"
ok "setup-new-machine runs eligible scripts"

# --- membership: a program no machine maps ------------------------------
# Skipped by converge, an error when explicitly requested, not observed.
hcl_file repo/programs/never.loadout.hcl <<'HCL'
program "never-mapped" {
  custom "manual" {
    command = "false"
  }
}
HCL
compile_repo repo
OUT=$("$BIN" --repo repo --machine m1 setup-new-machine --dry-run) || fail "converge with unmapped program should succeed"
echo "$OUT" | grep -q "never-mapped" && fail "converge must skip unmapped programs" || true
"$BIN" --repo repo --machine m1 install never-mapped --dry-run >/dev/null 2>&1 && fail "explicit unmapped should fail" || true
OUT=$("$BIN" --repo repo --machine m1 install never-mapped --dry-run 2>&1 || true)
echo "$OUT" | grep -q "program 'never-mapped' isn't installed on machine 'm1'" || fail "unmapped-program error message: $OUT"
"$BIN" --repo repo --machine m1 status >/dev/null
grep -q '"never-mapped"' repo/machines/state/m1.json && fail "unmapped program must not be observed" || true
ok "unmapped programs are not part of the machine's loadout"

# --- a machine the repo doesn't declare -----------------------------------
OUT=$("$BIN" --repo repo --machine ghost setup-new-machine --dry-run 2>&1 || true)
echo "$OUT" | grep -q "machine 'ghost' is not declared in the repo" || fail "undeclared-machine error message: $OUT"
ok "setup-new-machine fails for a machine the repo doesn't declare"

# --- mapped pm binary not present on this machine ------------------------
hcl_repo pmrepo
hcl_file pmrepo/programs/tool.loadout.hcl <<'HCL'
installer "pacman" {
  probe   = "pacman"
  install = "sudo pacman -S --noconfirm {pkg}"
  check   = "pacman -Q {pkg}"
  regex   = "([0-9.]+)"
}

program "tool" {
  install_via = [pacman]
}

machine "m1" {
  install = [program.tool]
}
HCL
compile_repo pmrepo
if ! command -v pacman >/dev/null 2>&1; then
    OUT=$("$BIN" --repo pmrepo --machine m1 setup-new-machine --dry-run 2>&1 || true)
    echo "$OUT" | grep -q "required binary 'pacman'" || fail "pm-not-installed error message"
    ok "setup-new-machine fails when the mapped pm is not installed"
else
    ok "skipped pm-not-installed check (pacman present on host)"
fi

# --- a probe binary the plan installs first ---------------------------------
hcl_repo providesrepo
hcl_file providesrepo/programs/tool.loadout.hcl <<'HCL'
installer "flat" {
  probe   = "loadout-test-flat"
  install = "loadout-test-flat install {pkg}"
  check   = "loadout-test-flat info {pkg}"
}

program "flat-runtime" {
  custom {
    command = "false"
    provides "loadout-test-flat" {}
  }
}

requires "flat" {
  programs = [program.flat-runtime]
}

program "app" {
  install_via = [flat]
}

machine "m1" {
  install = [program.flat-runtime, program.app]
}
HCL
compile_repo providesrepo
OUT=$("$BIN" --repo providesrepo --machine m1 install app --dry-run 2>&1) || fail "provided probe refused: $OUT"
echo "$OUT" | grep -q "flat-runtime" || fail "provider not planned: $OUT"
echo "$OUT" | grep -q "loadout-test-flat install app" || fail "app not planned: $OUT"
OUT=$("$BIN" --repo providesrepo --machine m1 explain flat-runtime)
echo "$OUT" | grep -q "provides.custom.*loadout-test-flat" || fail "explain shows provides: $OUT"
ok "a probe binary a program earlier in the plan provides isn't required up front"

# --- a provided tool off PATH, where its variant says it lands -------------
LANDED="$PWD/landed/bin"
mkdir -p "$LANDED"
cat >"$LANDED/loadout-test-brewish" <<'SH'
#!/bin/sh
[ "$1" = list ] && [ "$2" = app ] && echo "app 1.2.3"
SH
chmod +x "$LANDED/loadout-test-brewish"
hcl_repo landedrepo
# Unquoted: the shell puts $LANDED's path in, so HCL sees a plain string.
hcl_file landedrepo/programs/tool.loadout.hcl <<HCL
installer "brewish" {
  probe   = "loadout-test-brewish"
  install = "loadout-test-brewish install {pkg}"
  check   = "loadout-test-brewish list {pkg}"
}

program "setup-brewish" {
  custom {
    command = "false"
    present = "test -x $LANDED/loadout-test-brewish"
    provides "loadout-test-brewish" {
      at = "$LANDED"
    }
  }
}

requires "brewish" {
  programs = [program.setup-brewish]
}

program "app" {
  install_via = [brewish]
}

program "other" {
  install_via = [brewish]
}

machine "m1" {
  install = [program.setup-brewish, program.app]
}

machine "m2" {
  install = [program.setup-brewish, program.app, program.other]
}
HCL
compile_repo landedrepo
OUT=$("$BIN" --repo landedrepo --machine m1 status 2>&1) || fail "status: $OUT"
echo "$OUT" | grep -E "app .*1\.2\.3" >/dev/null || fail "check didn't run from where the tool lands: $OUT"
OUT=$("$BIN" --repo landedrepo --machine m2 install other --dry-run 2>&1) || fail "tool off PATH refused: $OUT"
echo "$OUT" | grep -qF "PATH=\"$LANDED:" || fail "install doesn't put where it lands first on PATH: $OUT"
ok "a provided tool off PATH is found, checked and run where its variant says it lands"

# --- explain ------------------------------------------------------------
OUT=$("$BIN" --repo repo --machine m1 explain git marker)
echo "$OUT" | grep -q "program git" || fail "explain prints the program"
echo "$OUT" | grep -qE "install\.manual +echo install git yourself && false +<- m1" || fail "explain marks this machine's mapped key"
echo "$OUT" | grep -q "script marker" || fail "explain prints the script"
echo "$OUT" | grep -qE "file +scripts/marker.sh" || fail "explain prints the script file"
"$BIN" --repo repo explain ghost-name >/dev/null 2>&1 && fail "explain of unknown name should fail" || true
OUT=$("$BIN" --repo repo --machine m1 explain)
echo "$OUT" | grep -q "program git" && echo "$OUT" | grep -q "script marker" || fail "bare explain covers the whole manifest"
ok "explain prints expanded programs and scripts (all of them with no names)"

# --- a check whose TOOL is absent is "not checked", never "missing" ------
# brew off PATH once reported every brew program missing. A check through
# a mechanism (its installer has a probe) that dies with the shell's own
# "command not found" is a question that couldn't be asked; a check that IS
# the program (`rg --version`, no probe) means what it says.
hcl_repo probed
hcl_file probed/programs/probed.loadout.hcl <<'HCL'
installer "ghostpm" {
  probe   = "ghostpm-definitely-not-here"
  install = "ghostpm-definitely-not-here install {pkg}"
  check   = "ghostpm-definitely-not-here query {pkg}"
  regex   = "([0-9.]+)"
}

program "viapm" {
  install_via = [ghostpm]
}

program "byitself" {
  version = "byitself-definitely-not-here --version"
  regex   = "([0-9.]+)"
  custom "manual" {
    command = "false"
  }
}

machine "m1" {
  install = [program.viapm, program.byitself]
}
HCL
compile_repo probed
OUT=$("$BIN" --repo probed --machine m1 status) || fail "status exits 0 with an unrunnable check"
echo "$OUT" | grep -qE "viapm +not checked" || fail "a check whose tool is absent is 'not checked'"
# The shell's own words: bash says "command not found", dash (Ubuntu's sh) "not found".
echo "$OUT" | grep -qE "ghostpm-definitely-not-here: (command )?not found" || fail "status says what wasn't there"
echo "$OUT" | grep -qE "byitself +missing" || fail "a program's own check not found means missing"
grep -q '"reason"' probed/machines/state/m1.json || fail "the reason is recorded in state"
echo "$OUT" | grep -q "ghostpm-definitely-not-here is not on PATH — 1 program(s) not checked" || fail "status says, once and in words, which tool was missing"
ok "a check whose tool is absent is 'not checked' with the reason, not 'missing'"

# --- a variant's own depends-on comes only with that variant --------------
hcl_repo vdeps
hcl_file vdeps/programs/vdeps.loadout.hcl <<'HCL'
program "prereq" {
  custom "manual" {
    command = "true"
  }
}

program "tool" {
  custom "withprereq" {
    command    = "true"
    depends_on = [program.prereq]
  }
  custom "plain" {
    command = "true"
  }
}

machine "m1" {
  install = [variant(program.tool, "withprereq"), program.prereq]
}

machine "m2" {
  install = [variant(program.tool, "plain")]
}
HCL
compile_repo vdeps
OUT=$("$BIN" --repo vdeps --machine m1 install tool --dry-run) || fail "dry-run with a variant dependency"
echo "$OUT" | grep -q "prereq" || fail "the mapped variant's dependency is planned"
OUT=$("$BIN" --repo vdeps --machine m2 install tool --dry-run) || fail "the other variant needs no mapping for it"
echo "$OUT" | grep -q "prereq" && fail "another variant's dependency must not be planned" || true
OUT=$("$BIN" --repo vdeps --machine m1 explain tool)
echo "$OUT" | grep -qE "depends-on.withprereq +prereq" || fail "explain shows a variant's depends-on"
ok "a variant's depends-on is planned only on machines mapping that variant"

# --- a failed install skips what needs it -----------------------------------
# (A program's command runs in its own directory: the markers land in programs/.)
hcl_repo skipdeps
hcl_file skipdeps/programs/tool.loadout.hcl <<'HCL'
program "base" {
  custom {
    command = "false"
  }
}

program "needs-base" {
  depends_on = [program.base]
  custom {
    command = "touch needs-base.ran"
  }
}

program "alone" {
  custom {
    command = "touch alone.ran"
  }
}

machine "m1" {
  install = [program.base, program.needs-base, program.alone]
}
HCL
compile_repo skipdeps
OUT=$("$BIN" --repo skipdeps --machine m1 setup-new-machine --yes --skip-scripts 2>&1) && fail "a failed install exits non-zero: $OUT"
[ -e skipdeps/programs/needs-base.ran ] && fail "needs-base ran after base failed"
[ -e skipdeps/programs/alone.ran ] || fail "alone didn't run: $OUT"
echo "$OUT" | grep -q "skipping needs-base (needs base, which didn't install)" || fail "the skip isn't announced: $OUT"
echo "$OUT" | grep -q "skipped installs: needs-base (needs base)" || fail "the summary doesn't name the skip: $OUT"
ok "a failed install skips the programs that need it, and only those"
