package loadout.dsl

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import loadout.core.LoadoutException
import loadout.core.manifest.InstallerLibrary
import loadout.core.manifest.MachineData as Data
import loadout.core.manifest.ManifestAssembler
import loadout.core.manifest.ManifestDraft
import loadout.core.manifest.ManifestException
import loadout.core.model.InstallVariant
import loadout.core.model.Installer as InstallerModel
import loadout.core.model.MachineConfig
import loadout.core.model.Manifest
import loadout.core.model.Program as ProgramModel
import loadout.core.model.RepoLayout
import loadout.core.model.ScriptStep
import loadout.core.model.scriptEntry
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What [ManifestAssembler] makes of a repo's declarations: validation,
 * profile flattening (contract 2), data, `file:` paths, the built-ins. The
 * DSL's types rule out some mistakes (an unknown program in `runAfter`); those
 * are checked on a hand-built draft, since a lock is just JSON.
 */
class AssemblyTest {
    private val repoRoot = "/repo".toPath()

    private fun inRepo(draft: ManifestDraft, vararg files: String): Manifest {
        val fs = FakeFileSystem()
        fs.createDirectories(repoRoot)
        for (file in files) {
            (repoRoot / file).parent?.let(fs::createDirectories)
            fs.write(repoRoot / file) { writeUtf8("#!/bin/sh\n") }
        }
        return ManifestAssembler.assemble(draft, fs, repoRoot)
    }

    private fun repo(vararg files: String, block: () -> Unit): Manifest =
        inRepo(buildManifest { layout(state = "state"); block() }, *files)

    private fun refusal(vararg files: String, block: () -> Unit): String =
        assertFailsWith<LoadoutException> { repo(*files, block = block) }.message.orEmpty()

    /** A draft no DSL could write (unknown names, missing regexes), as a lock could hold one. */
    private fun draftRefusal(manifest: Manifest, profiles: Map<String, MachineConfig> = emptyMap()): String =
        assertFailsWith<ManifestException> {
            ManifestAssembler.assembleWithoutFiles(ManifestDraft(manifest.copy(layout = RepoLayout(state = "state")), profiles))
        }.message.orEmpty()

    // ─── programs and installers ───────────────────────────────────────

    @Test
    fun unknownNamesInADraftAreNamed() {
        val program = ProgramModel(install = mapOf("custom" to InstallVariant(command = "true")))
        assertTrue(
            "programs.a depends-on unknown program 'nope'" in
                draftRefusal(Manifest(programs = mapOf("a" to program.copy(dependsOn = listOf("nope"))))),
        )
        assertTrue(
            "programs.kitty.install.copr depends-on unknown program 'dnf-plugins-core'" in draftRefusal(
                Manifest(programs = mapOf("kitty" to ProgramModel(install = mapOf("copr" to InstallVariant(command = "x", dependsOn = listOf("dnf-plugins-core")))))),
            ),
        )
        assertTrue(
            "references unknown installer 'phantom'" in draftRefusal(
                Manifest(programs = mapOf("a" to ProgramModel(install = mapOf("x" to InstallVariant(installer = "phantom"))))),
            ),
        )
        assertTrue(
            "machine 'm' installs unknown program 'ghost'" in
                draftRefusal(Manifest(machines = mapOf("m" to MachineConfig(pm = mapOf("ghost" to "dnf"))))),
        )
        assertTrue(
            "machine 'm' runs unknown script 'ghost'" in
                draftRefusal(Manifest(machines = mapOf("m" to MachineConfig(scripts = listOf("ghost"))))),
        )
        assertTrue(
            "scripts.s after references unknown step 'programs.ghost'" in
                draftRefusal(Manifest(scripts = mapOf("s" to ScriptStep(run = "true", after = listOf("programs.ghost"))))),
        )
        assertTrue(
            "installers.dnf requires unknown program 'ghost'" in
                draftRefusal(Manifest(installers = mapOf("dnf" to InstallerModel(install = "x {pkg}", requires = listOf("ghost"))))),
        )
    }

    @Test
    fun aCycleOnlyOneVariantWalksIsStillACycle() {
        // Values can't refer forward, so a cycle needs a hand-built draft.
        val a = ProgramModel(dependsOn = listOf("b"), install = mapOf("custom" to InstallVariant(command = "a")))
        val b = ProgramModel(
            install = mapOf(
                "custom" to InstallVariant(command = "b"),
                "other" to InstallVariant(command = "b2", dependsOn = listOf("a")),
            ),
        )
        val message = draftRefusal(Manifest(programs = mapOf("a" to a, "b" to b)))
        assertTrue("dependency cycle among programs: a -> b -> a" in message, message)
    }

    @Test
    fun anInstallersRequirementsCountTowardCyclesButNotItsOwn() {
        val brew = InstallerModel(install = "brew install {pkg}", requires = listOf("setup-brew"))
        // setup-brew through brew is exempt from brew's own rule...
        val setupViaBrew = ProgramModel(install = mapOf("brew" to InstallVariant()))
        ManifestAssembler.assembleWithoutFiles(
            ManifestDraft(Manifest(layout = RepoLayout(state = "state"), installers = mapOf("brew" to brew), programs = mapOf("setup-brew" to setupViaBrew))),
        )
        // ...but needing a brew program closes a loop.
        val setup = ProgramModel(dependsOn = listOf("curl"), install = mapOf("custom" to InstallVariant(command = "x")))
        val curl = ProgramModel(install = mapOf("brew" to InstallVariant()))
        val message = draftRefusal(Manifest(installers = mapOf("brew" to brew), programs = mapOf("setup-brew" to setup, "curl" to curl)))
        assertTrue("dependency cycle among programs" in message, message)
    }

    @Test
    fun viaInstallsEveryProgramInItsBlockThroughThatInstaller() {
        val manifest = repo {
            val git = root.program(name = "git") {
                installVia(
                    Builtin.dnf,
                    Builtin.brew,
                )
            }
            val jq = root.program(name = "jq") {
                installVia(
                    Builtin.brew,
                )
            }
            val vim = root.program(name = "vim") {
                installVia(
                    Builtin.dnf,
                    Builtin.brew,
                )
            }
            val cli = listOf(git, vim)
            machine(hostname = "m") {
                via(Builtin.brew) {
                    install(cli)
                    install(jq)
                }
            }
        }
        assertEquals(mapOf("git" to "brew", "jq" to "brew", "vim" to "brew"), manifest.machines.getValue("m").pm)
    }

    @Test
    fun aMachineInstallingThroughAVariantTheProgramLacksIsNamed() {
        val message = refusal {
            val git = root.program("git") { installVia(Builtin.dnf) }
            machine("m") { via(Builtin.brew) { install(git) } }
        }
        assertTrue("machine 'm' installs 'git' via 'brew', but it can't be installed that way (it can via: dnf)" in message, message)
    }

    @Test
    fun installerDefaultsApplyPkgAndOverrides() {
        val manifest = repo {
            val cask = root.installer("brew-cask") {
                probe = "brew"
                install = "brew install --cask {pkg}"
                check = "brew list --cask --versions {pkg}"
            }
            root.program("toolbox") {
                custom("linux") { command = "brew tap x/y && brew install --cask toolbox-linux" }
                installVia(cask)
            }
            root.program("toolbox-linux-cask") { installVia(cask("toolbox-linux")) }
        }
        val cask = manifest.resolveInstall("toolbox", "brew-cask")
        assertEquals("brew install --cask toolbox", cask.command)
        assertEquals("brew list --cask --versions toolbox", cask.check?.command)
        assertEquals("brew", cask.probe)
        val renamed = manifest.resolveInstall("toolbox-linux-cask", "brew-cask")
        assertEquals("brew install --cask toolbox-linux", renamed.command)
        // A custom variant has no installer: no probe, no derived check.
        assertNull(manifest.resolveInstall("toolbox", "linux").probe)
    }

    @Test
    fun aVariantCheckWithoutRegexKeepsItsInstallersRegex() {
        val dnf = InstallerModel(install = "sudo dnf install -y {pkg}", check = "rpm -q {pkg}", regex = "([0-9.]+)", probe = "dnf")
        val manifest = ManifestAssembler.assembleWithoutFiles(
            ManifestDraft(
                Manifest(
                    layout = RepoLayout(state = "state"),
                    installers = mapOf("dnf" to dnf),
                    programs = mapOf("zlib-devel" to ProgramModel(install = mapOf("dnf" to InstallVariant(check = "rpm -q --whatprovides zlib-devel")))),
                ),
            ),
        )
        val resolved = manifest.resolveInstall("zlib-devel", "dnf")
        assertEquals("sudo dnf install -y zlib-devel", resolved.command)
        assertEquals("rpm -q --whatprovides zlib-devel", resolved.check?.command)
        assertEquals("([0-9.]+)", resolved.check?.regex)
        assertEquals("dnf", resolved.probe)
    }

    @Test
    fun checksNeedARegexUnlessTheyAreYesNo() {
        assertTrue(
            "installers.bad has a check but no regex" in
                draftRefusal(Manifest(installers = mapOf("bad" to InstallerModel(install = "x {pkg}", check = "q {pkg}")))),
        )
        assertTrue(
            "programs.a.install.manual has a check but no regex" in draftRefusal(
                Manifest(programs = mapOf("a" to ProgramModel(install = mapOf("manual" to InstallVariant(command = "x", check = "q"))))),
            ),
        )
        assertTrue(
            "programs.a.install.manual is a yes/no check and also sets a regex" in draftRefusal(
                Manifest(programs = mapOf("a" to ProgramModel(install = mapOf("manual" to InstallVariant(command = "x", check = "q", present = true, regex = "(.*)"))))),
            ),
        )
        // The DSL's present() is the yes/no form: no regex, no version.
        val manifest = repo { root.program("a") { custom { command = "x"; present("test -f /etc/a") } } }
        assertNull(manifest.resolveInstall("a", "custom").check!!.regex)
    }

    @Test
    fun aVariantWithNoCommandIsRefused() {
        assertTrue("programs.a.install.custom resolves to no install command" in refusal { root.program("a") { custom { } } })
    }

    @Test
    fun installerParamsSubstituteIntoEveryPattern() {
        val manifest = repo {
            val copr = root.installer("copr") {
                params("copr")
                install = "sudo dnf copr enable -y {copr} && sudo dnf install -y {pkg}"
                check = "rpm -q {pkg} && echo {copr}"
            }
            root.program("kitty") { installVia(copr { param("copr", "solopasha/kitty") }) }
        }
        val resolved = manifest.resolveInstall("kitty", "copr")
        assertEquals("sudo dnf copr enable -y solopasha/kitty && sudo dnf install -y kitty", resolved.command)
        assertEquals("rpm -q kitty && echo solopasha/kitty", resolved.check?.command)
    }

    @Test
    fun aMissingOrUndeclaredParamIsAnError() {
        fun coprInstaller() = root.installer("copr") {
            params("copr")
            install = "dnf copr enable {copr} && dnf install {pkg}"
        }
        val missing = refusal {
            val copr = coprInstaller()
            root.program("kitty") { installVia(copr) }
        }
        assertTrue("needs a value for 'copr'" in missing, missing)
        val undeclared = refusal {
            val copr = coprInstaller()
            root.program("kitty") { installVia(copr { param("copr", "x"); param("extra", "y") }) }
        }
        assertTrue("sets 'extra', which installer 'copr' does not declare in params" in undeclared, undeclared)
        val noInstaller = refusal { root.program("kitty") { custom { command = "x"; param("copr", "y") } } }
        assertTrue("sets 'copr' but resolves to no installer" in noInstaller, noInstaller)
        val reserved = refusal { root.installer("bad") { params("pkg"); install = "x {pkg}" } }
        assertTrue("installers.bad declares param 'pkg', which is always available" in reserved, reserved)
    }

    @Test
    fun installOrderPutsDependenciesFirst() {
        val manifest = repo {
            val git = root.program("git") { installVia(Builtin.dnf) }
            root.program("ripgrep") {
                dependsOn(git)
                installVia(Builtin.dnf)
            }
            root.program("rustup") { custom { command = "x" } }
        }
        assertEquals(listOf("git", "ripgrep"), ManifestAssembler.installOrder(manifest, listOf("ripgrep")))
        assertEquals(listOf("git", "ripgrep", "rustup"), ManifestAssembler.installOrder(manifest))
    }

    // ─── scripts ───────────────────────────────────────────────────────

    @Test
    fun scriptModesDefaultToBothSurfaces() {
        val manifest = repo {
            root.script("bootstrap") { run("true"); setupOnly() }
            root.script("tidy") { run("true"); maintainOnly() }
            root.script("everyday") { run("true") }
        }
        assertTrue(manifest.scripts.getValue("bootstrap").runsIn("setup"))
        assertTrue(!manifest.scripts.getValue("bootstrap").runsIn("maintain"))
        assertTrue(!manifest.scripts.getValue("tidy").runsIn("setup"))
        assertTrue(manifest.scripts.getValue("everyday").runsIn("setup"))
        assertTrue(manifest.scripts.getValue("everyday").runsIn("maintain"))
        assertTrue("unknown mode 'bogus'" in draftRefusal(Manifest(scripts = mapOf("s" to ScriptStep(run = "x", modes = listOf("bogus"))))))
        assertTrue("empty modes list" in draftRefusal(Manifest(scripts = mapOf("s" to ScriptStep(run = "x", modes = emptyList())))))
    }

    @Test
    fun aScriptHasExactlyOneOfAFileOrACommand() {
        assertTrue("scripts.s must define exactly one of a file or an inline command" in refusal("s.sh") {
            root.script("s") { file("s.sh"); run("true") }
        })
        assertTrue("scripts.s must define exactly one of a file or an inline command" in refusal { root.script("s") { } })
        assertTrue("scripts.s has variants, so its file or command belongs in each variant" in refusal("a.sh") {
            root.script("s") { run("true"); variant("a") { file("a.sh") } }
        })
    }

    @Test
    fun argumentsNeedAFileScript() {
        val message = refusal {
            val inline = root.script("inline") { run("echo hi") }
            machine("m") { run(inline, "x") }
        }
        assertTrue("machine 'm' passes arguments to script 'inline', which is an inline command" in message, message)
    }

    @Test
    fun aMachinePicksAVariantTheScriptHas() {
        assertTrue(
            "machine 'm' runs 'k' as 'zzz', which it doesn't have (has: none)" in draftRefusal(
                Manifest(
                    scripts = mapOf("k" to ScriptStep(run = "x")),
                    machines = mapOf("m" to MachineConfig(scripts = listOf("k"), scriptVariants = mapOf("k" to "zzz"))),
                ),
            ),
        )
    }

    @Test
    fun aScriptEntrysWhitespaceBecomesSingleSpaces() {
        assertEquals("name" to "a b", scriptEntry("  name\n\ta \n  b  "))
    }

    @Test
    fun declaringOrRunningTwiceIsAnError() {
        val twice = assertFailsWith<DslException> {
            buildManifest {
                val s = root.script("s") { run("true") }
                val p = root.program("p") { custom { command = "x" } }
                machine("m") {
                    run(s)
                    run(s)
                    install(p)
                    install(p)
                }
            }
        }.message.orEmpty()
        assertTrue("machine 'm' runs 's' twice" in twice, twice)
        assertTrue("machine 'm' installs 'p' twice" in twice, twice)
        val variants = assertFailsWith<DslException> {
            buildManifest { root.program("p") { custom { command = "x" }; custom { command = "y" } } }
        }.message.orEmpty()
        assertTrue("program 'p' has two 'custom' variants" in variants, variants)
    }

    // ─── machines and profiles (contract 2) ────────────────────────────

    @Test
    fun profilesFlattenIntoMachinesAndAreDropped() {
        val manifest = repo("dotfiles.sh", "ssh.sh") {
            val git = root.program("git") { installVia(Builtin.dnf, Builtin.brew) }
            val kitty = root.program("kitty") { installVia(Builtin.dnf) }
            val dotfiles = root.script("dotfiles") { file("dotfiles.sh") }
            val ssh = root.script("setup-ssh") { file("ssh.sh") }
            val base = profile("base") {
                via(Builtin.dnf) {
                    install(git, kitty)
                }
                run(dotfiles)
                run(ssh, "basekey")
            }
            val linux = profile("linux") { extends(base) }
            machine("laptop") {
                extends(linux)
                via(Builtin.brew) {
                    install(git)
                }
                run(ssh, "laptopkey")
            }
        }
        assertEquals(setOf("laptop"), manifest.machines.keys)
        val laptop = manifest.machines.getValue("laptop")
        // Mappings merge per program, the machine wins; chains flatten through.
        assertEquals(mapOf("git" to "brew", "kitty" to "dnf"), laptop.pm)
        // Scripts union; a machine's entry replaces the profile's by name (args too).
        assertEquals(mapOf("dotfiles" to "", "setup-ssh" to "laptopkey"), laptop.scriptArgs())
        assertEquals(listOf("linux"), laptop.extends)
    }

    @Test
    fun siblingProfilesMustAgreeAndTheMachineOverridesThem() {
        val agree = repo("ssh.sh") {
            val git = root.program("git") { installVia(Builtin.dnf, Builtin.brew) }
            val ssh = root.script("ssh") { file("ssh.sh") }
            val a = profile("a") { via(Builtin.dnf) { install(git) }; run(ssh, "one") }
            val b = profile("b") { via(Builtin.dnf) { install(git) }; run(ssh, "one") }
            machine("m") { extends(a, b); via(Builtin.brew) { install(git) } }
        }
        assertEquals("brew", agree.machines.getValue("m").pm["git"])
        assertEquals(mapOf("ssh" to "one"), agree.machines.getValue("m").scriptArgs())

        val disagree = refusal("ssh.sh", "k1.sh", "k2.sh") {
            machineData(::Flags)
            val git = root.program("git") { installVia(Builtin.dnf, Builtin.brew) }
            val ssh = root.script("ssh") { file("ssh.sh") }
            val keyboard = root.script("keyboard") {
                variant("one") { file("k1.sh") }
                variant("two") { file("k2.sh") }
            }
            val a = profile("a") {
                via(Builtin.dnf) {
                    install(git)
                }
                run(ssh, "one")
                run(keyboard.variant("one"))
                data(::Flags) { omarchy = true }
            }
            val b = profile("b") {
                via(Builtin.brew) {
                    install(git)
                }
                run(ssh, "two")
                run(keyboard.variant("two"))
                data(::Flags) { omarchy = false }
            }
            machine("m") { extends(a, b) }
        }
        assertTrue("machine 'm': profiles 'a' and 'b' map 'git' differently ('dnf' vs 'brew')" in disagree, disagree)
        assertTrue("machine 'm': profiles 'a' and 'b' run 'ssh' with different arguments" in disagree, disagree)
        assertTrue("machine 'm': profiles 'a' and 'b' run 'keyboard' as different variants ('one' vs 'two')" in disagree, disagree)
        assertTrue("machine 'm': profiles 'a' and 'b' set data key 'omarchy' differently" in disagree, disagree)
    }

    @Test
    fun profileCyclesAndUnknownProfilesAreNamed() {
        val p = MachineConfig(extends = listOf("q"), label = "profile 'p'")
        val q = MachineConfig(extends = listOf("p"), label = "profile 'q'")
        assertTrue("profile cycle" in draftRefusal(Manifest(), profiles = mapOf("p" to p, "q" to q)))
        val unknown = MachineConfig(extends = listOf("laptop"), label = "machine 'm'")
        assertTrue(
            "machine 'm': extends unknown profile 'laptop'" in draftRefusal(Manifest(machines = mapOf("m" to unknown))),
        )
    }

    class Flags : MachineData() {
        var omarchy by flag(false)
        var tags by list(listOf("a"))
        val kitty by table(::Kitty)

        class Kitty : MachineData() {
            var opacity by number(0.85)
            var font by text("mono")
        }
    }

    @Test
    fun dataMergesDefaultsProfilesAndMachine() {
        val manifest = repo {
            machineData(::Flags)
            val omarchy = profile("omarchy") {
                data(::Flags) {
                    omarchy = true
                    kitty.font = "fira"
                }
            }
            machine("m") {
                extends(omarchy)
                data(::Flags) {
                    kitty.opacity = 0.9
                    tags = listOf("b")
                }
            }
            machine("bare") { }
        }
        // Defaults under profile under machine; tables merge key by key, lists replace.
        assertEquals(
            listOf("kitty.font" to "\"fira\"", "kitty.opacity" to "0.9", "omarchy" to "true", "tags" to "[\"b\"]"),
            Data.lines(manifest.machines.getValue("m").data),
        )
        // Every machine carries every declared key.
        assertEquals(manifest.data, manifest.machines.getValue("bare").data)
        assertEquals(JsonPrimitive(false), manifest.data["omarchy"])
    }

    @Test
    fun undeclaredOrMistypedDataIsAnError() {
        val defaults = JsonObject(mapOf("work" to JsonPrimitive(false)))
        val typo = draftRefusal(
            Manifest(data = defaults, machines = mapOf("m" to MachineConfig(data = JsonObject(mapOf("wrok" to JsonPrimitive(true))), label = "machine 'm'"))),
        )
        assertTrue("machine 'm': data key 'wrok' is not declared in the data schema" in typo, typo)
        val kind = draftRefusal(
            Manifest(data = defaults, machines = mapOf("m" to MachineConfig(data = JsonObject(mapOf("work" to JsonPrimitive("yes"))), label = "machine 'm'"))),
        )
        assertTrue("machine 'm': data key 'work' is a string, but the data schema declares a boolean" in kind, kind)
    }

    // ─── files and origins (contracts 4, 5) ────────────────────────────

    @Test
    fun pathsAreRelativeToTheDeclaringDirectoryAndStayInTheRepo() {
        val missing = refusal("plugins.sh") {
            Dir("configs/tmux").script("tmux-plugins") { managedBy("plugins.sh") }
        }
        assertTrue("scripts.tmux-plugins: file 'plugins.sh' not found (relative to configs/tmux/)" in missing, missing)
        assertEquals(
            "configs/tmux",
            repo("configs/tmux/plugins.sh") { Dir("configs/tmux").script("tmux-plugins") { managedBy("plugins.sh") } }
                .scripts.getValue("tmux-plugins").origin,
        )
        val escaping = refusal { Dir("a/b").script("x") { file("../../../outside.sh") } }
        assertTrue("file '../../../outside.sh' leaves the repo" in escaping, escaping)
        // `..` that stays inside the repo reaches a shared helper.
        assertEquals(
            "../lib/helper.sh",
            repo("a/lib/helper.sh") { Dir("a/b").script("x") { file("../lib/helper.sh") } }.scripts.getValue("x").file,
        )
    }

    @Test
    fun everyFileCommandIsChecked() {
        val message = refusal {
            root.program("tool") {
                custom("script") {
                    command = "file:scripts/tool.sh install --verbose"
                    version("file:scripts/tool-check.sh")
                }
            }
            root.script("setup") { run("true"); check("file:scripts/setup.sh check") }
            root.outdated("pins", command = "file:pins.sh", upgrade = "file:pins.sh bump {item}")
        }
        // The path is named alone, never its arguments.
        assertTrue("programs.tool.install.script: file 'scripts/tool.sh' not found" in message, message)
        assertTrue("programs.tool.install.script check: file 'scripts/tool-check.sh' not found" in message, message)
        assertTrue("scripts.setup.check: file 'scripts/setup.sh' not found" in message, message)
        assertTrue("outdated.pins: file 'pins.sh' not found" in message, message)
        assertTrue("outdated.pins.upgrade: file 'pins.sh' not found" in message, message)
    }

    @Test
    fun anInstallRunsWhereItsCommandWasWritten() {
        val manifest = repo {
            val pm = Dir("programs/installers").installer("pm") {
                install = "pm add {pkg}"
                check = "pm query {pkg}"
            }
            Dir("programs/cli").program("jq") { installVia(pm) }
            Dir("programs/cli").program("odd") { installVia(pm { command = "make install" }) }
        }
        val jq = manifest.resolveInstall("jq", "pm")
        assertEquals("programs/installers", jq.commandOrigin)
        assertEquals("programs/installers", jq.check?.origin)
        val odd = manifest.resolveInstall("odd", "pm")
        assertEquals("programs/cli", odd.commandOrigin)
        assertEquals("programs/installers", odd.check?.origin)
    }

    @Test
    fun aFileWithValueIsAPathNextToItsProgram() {
        val here = Dir("programs/apps")
        val manifest = repo("programs/apps/repos/code.repo") {
            here.program("code") { installVia(dnfRepo(repofile = here.file("repos/code.repo"))) }
            here.program("teams") { installVia(dnfRepo(repofile = "https://example.com/teams.repo")) }
        }
        assertTrue(
            "--from-repofile=\$LOADOUT_REPO/programs/apps/repos/code.repo" in manifest.resolveInstall("code", "dnf-repo").command.orEmpty(),
        )
        // Unmarked values (a URL) pass through as written.
        assertTrue("--from-repofile=https://example.com/teams.repo" in manifest.resolveInstall("teams", "dnf-repo").command.orEmpty())
        val missing = refusal { here.program("code") { installVia(dnfRepo(repofile = here.file("repos/code.repo"))) } }
        assertTrue("programs.code.install.dnf-repo.with.repofile: file 'repos/code.repo' not found (relative to programs/apps/)" in missing, missing)
    }

    // ─── a child repo's parent (contract 18) ───────────────────────────

    private val parentRoot = "/parent".toPath()

    /** A child's draft with files under the child's root and the parent's (`parent:` paths). */
    private fun inChild(draft: ManifestDraft, vararg files: String): Manifest {
        val fs = FakeFileSystem()
        fs.createDirectories(repoRoot)
        fs.createDirectories(parentRoot)
        for (file in files) {
            val path = if (file.startsWith("parent:")) parentRoot / file.removePrefix("parent:") else repoRoot / file
            path.parent?.let(fs::createDirectories)
            fs.write(path) { writeUtf8("#!/bin/sh\n") }
        }
        return ManifestAssembler.assemble(draft, fs, repoRoot, parentRoot)
    }

    @Test
    fun aParentsFilesResolveInItsCheckout() {
        val draft = buildManifest {
            layout(state = "state")
            Dir("parent:maintenance/lib").script("helper") { managedBy("helper.sh") }
            Dir("scripts").script("mine") { managedBy("mine.sh") }
        }
        val manifest = inChild(draft, "parent:maintenance/lib/helper.sh", "scripts/mine.sh")
        assertEquals("parent:maintenance/lib", manifest.scripts.getValue("helper").origin)
        // The same file in the child's root is not the parent's.
        val missing = assertFailsWith<LoadoutException> { inChild(draft, "maintenance/lib/helper.sh", "scripts/mine.sh") }.message.orEmpty()
        assertTrue("scripts.helper: file 'helper.sh' not found (relative to parent:maintenance/lib/)" in missing, missing)
    }

    @Test
    fun aParentsFileWithValueIsUnderLoadoutParent() {
        val draft = buildManifest {
            layout(state = "state")
            val here = Dir("parent:programs/apps")
            here.program("code") { installVia(dnfRepo(repofile = here.file("repos/code.repo"))) }
        }
        val manifest = inChild(draft, "parent:programs/apps/repos/code.repo")
        // The built-in dnf-repo runs in the child: the path can't lean on LOADOUT_REPO.
        assertTrue(
            "--from-repofile=\$LOADOUT_PARENT/programs/apps/repos/code.repo" in manifest.resolveInstall("code", "dnf-repo").command.orEmpty(),
        )
        val missing = assertFailsWith<LoadoutException> { inChild(draft, "programs/apps/repos/code.repo") }.message.orEmpty()
        assertTrue("programs.code.install.dnf-repo.with.repofile: file 'repos/code.repo' not found (relative to parent:programs/apps/)" in missing, missing)
    }

    @Test
    fun aLockWithoutAParentSaysNothingOfOne() {
        val lock = loadout.core.manifest.Lock(toolVersion = "1.0.0", sources = "x", manifest = repo { })
        val text = loadout.core.manifest.LockFile.encode(lock)
        assertTrue("parent" !in text, text)
        val parent = loadout.core.model.ParentLayout(
            name = "dotfiles", path = "~/.local/share/chezmoi", state = "state", configs = "configs",
            sources = listOf("loadout.kt"), hash = "abc",
        )
        val child = lock.copy(manifest = lock.manifest.copy(layout = lock.manifest.layout.copy(parent = parent)))
        assertEquals(parent, loadout.core.manifest.LockFile.decode(loadout.core.manifest.LockFile.encode(child)).manifest.layout.parent)
    }

    // ─── built-ins (contract 13) ───────────────────────────────────────

    @Test
    fun builtInsResolveWithoutBeingDeclared() {
        val manifest = repo { root.program("ripgrep") { installVia(Builtin.dnf) } }
        val resolved = manifest.resolveInstall("ripgrep", "dnf")
        assertEquals("sudo dnf install -y ripgrep", resolved.command)
        assertEquals("rpm -q ripgrep", resolved.check?.command)
        assertEquals("dnf", resolved.probe)
        assertTrue("dnf" in manifest.builtinInstallers)
    }

    @Test
    fun aRepoInstallerReplacesTheBuiltInOfTheSameName() {
        val manifest = repo {
            val dnf = root.installer("dnf") { probe = "dnf"; install = "sudo dnf5 install -y {pkg}" }
            root.program("ripgrep") { installVia(dnf) }
        }
        assertEquals("sudo dnf5 install -y ripgrep", manifest.resolveInstall("ripgrep", "dnf").command)
        // Replaced outright, not merged: the built-in's oracle is gone with it.
        assertTrue("dnf" !in manifest.builtinInstallers)
        assertNull(manifest.installers.getValue("dnf").outdatedAll)
        assertTrue("brew" in manifest.builtinInstallers)
    }

    @Test
    fun aRequirementOnABuiltInKeepsItBuiltIn() {
        val manifest = repo("setup-dnf.sh") {
            val setup = root.program("setup-dnf") { installVia(Builtin.dnf { managedBy("setup-dnf.sh") }) }
            Builtin.dnf.requires(setup)
            root.program("curl") { installVia(Builtin.dnf) }
        }
        assertEquals(listOf("setup-dnf"), manifest.installers.getValue("dnf").requires)
        assertTrue("dnf" in manifest.builtinInstallers)
    }

    @Test
    fun theShippedLibraryIsUsable() {
        val installers = InstallerLibrary.installers
        assertTrue(installers.keys.containsAll(setOf("dnf", "apt", "pacman", "omarchy", "omarchy-aur", "brew", "brew-cask", "flatpak")))
        for ((name, installer) in installers) {
            assertTrue(installer.probe != null, "$name has no probe")
            assertTrue(installer.install?.contains("{pkg}") == true, "$name install ignores {pkg}")
            assertTrue(installer.check?.contains("{pkg}") == true, "$name check ignores {pkg}")
            // A batch oracle always wins over the per-pkg one: both would ship dead config.
            assertEquals(null, installer.outdated, "$name declares an unreachable per-pkg oracle")
        }
        // Builtin names every one of them.
        assertEquals(installers.keys, setOf(Builtin.dnf, Builtin.dnfRepo, Builtin.dnfCopr, Builtin.brew, Builtin.brewCask, Builtin.flatpak, Builtin.pacman, Builtin.omarchy, Builtin.omarchyAur, Builtin.apt).map { it.name }.toSet())
    }

    @Test
    fun theShippedMechanismsShareTheirSweeps() {
        // `upgrade` dedupes steps by command: the dnf mechanisms must spell
        // theirs identically, and refresh (the oracle reads a local cache).
        val installers = InstallerLibrary.installers
        val sweeps = listOf("dnf", "dnf-repo", "dnf-copr").map { installers.getValue(it).upgrade }
        assertEquals(listOf("sudo dnf upgrade --refresh -y"), sweeps.distinct())
        // Omarchy's update upgrades repo and AUR packages alike, never a bare pacman -Syu.
        val omarchy = listOf("omarchy", "omarchy-aur").map(installers::getValue)
        assertEquals(listOf("omarchy update -y"), omarchy.map { it.upgrade }.distinct())
        assertEquals(listOf("omarchy"), omarchy.map { it.probe }.distinct())
        assertEquals("omarchy pkg add {pkg}", omarchy[0].install)
        assertEquals("omarchy pkg aur add {pkg}", omarchy[1].install)
    }

    @Test
    fun metaVersionIsADottedNumber() {
        assertTrue(
            "meta min-tool-version 'soon' is not a dotted version number" in
                refusal { meta("x", minToolVersion = "soon") },
        )
        assertTrue("layout state is missing" in assertFailsWith<ManifestException> { inRepo(buildManifest { }) }.message.orEmpty())
    }
}
