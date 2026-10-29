package loadout.core

import loadout.core.exec.CommandFrame
import loadout.core.engine.InstallEngine
import loadout.core.engine.PlanItem
import loadout.core.engine.ResolutionException
import loadout.core.engine.VersionChecker
import loadout.dsl.Builtin
import loadout.dsl.invoke
import loadout.dsl.machine
import loadout.dsl.manifestOf
import loadout.dsl.root
import loadout.core.model.ProgramState
import loadout.core.model.ProgramStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import okio.Path.Companion.toPath

class InstallEngineTest {
    private val manifest = EXAMPLE_MANIFEST

    private fun engine(runner: FakeProcessRunner = FakeProcessRunner()) =
        InstallEngine(runner, VersionChecker(runner), CommandFrame("/repo"))

    @Test
    fun planUsesMachineMappingSkipsInstalledAndExpandsDeps() {
        val states = mapOf(
            "git" to ProgramState(ProgramStatus.INSTALLED, "2.46.0"),
            "ripgrep" to ProgramState(ProgramStatus.MISSING),
        )
        val plan = engine().plan(manifest, "laptop", listOf("ripgrep"), states) { true }

        // ripgrep depends on git: git first (already installed), then ripgrep via laptop's dnf mapping.
        assertEquals(
            listOf(
                PlanItem.AlreadyInstalled("git", "2.46.0"),
                PlanItem.Install("ripgrep", "dnf", "sudo dnf install -y ripgrep", sudo = true),
            ),
            plan,
        )
    }

    @Test
    fun planPicksDifferentKeysPerMachine() {
        val laptop = engine().plan(manifest, "laptop", listOf("git"), emptyMap()) { true }
        val macbook = engine().plan(manifest, "macbook", listOf("git"), emptyMap()) { true }
        assertEquals("sudo dnf install -y git", (laptop.single() as PlanItem.Install).command)
        assertEquals("brew install git", (macbook.single() as PlanItem.Install).command)
    }

    @Test
    fun planResolvesCustomScriptKeys() {
        val plan = engine().plan(manifest, "laptop", listOf("rustup"), emptyMap()) { true }
        assertEquals(
            PlanItem.Install("rustup", "script", "curl -sSf https://sh.rustup.rs | sh -s -- -y"),
            plan.single(),
        )
    }

    @Test
    fun aVariantsDependenciesOnlyComeWithThatVariant() {
        // kitty from a COPR needs dnf-plugins-core first; kitty from pacman
        // needs nothing — and must not drag a dnf package into the plan.
        val m = manifestOf {
            val plugins = root.program("dnf-plugins-core") { installVia(Builtin.dnf { command = "dnf install dnf-plugins-core" }) }
            val kitty = root.program("kitty") {
                custom("copr") {
                    command = "dnf copr enable kitty"
                    dependsOn(plugins)
                }
                custom("pacman") { command = "pacman -S kitty" }
            }
            machine("fedora") {
                install(kitty.variant("copr"))
                via(Builtin.dnf) {
                    install(plugins)
                }
            }
            machine("arch") { install(kitty.variant("pacman")) }
        }
        val fedora = engine().plan(m, "fedora", listOf("kitty"), emptyMap()) { true }
        assertEquals(listOf("dnf-plugins-core", "kitty"), fedora.map { it.program })
        val arch = engine().plan(m, "arch", listOf("kitty"), emptyMap()) { true }
        assertEquals(listOf("kitty"), arch.map { it.program })
    }

    @Test
    fun sudoDeclarationsReachThePlan() {
        // `sudo` on an installer marks its installs; a variant's replaces it.
        val m = manifestOf {
            val pkg = root.installer("omarchy-pkg") {
                install = "omarchy pkg add {pkg}"
                needsSudo()
            }
            val zsh = root.program("zsh") { installVia(pkg) }
            val plain = root.program("plain") { custom { command = "true" } }
            machine("m") {
                install(zsh, plain)
            }
        }
        val plan = engine().plan(m, "m", listOf("zsh", "plain"), emptyMap()) { true }
            .filterIsInstance<PlanItem.Install>().associate { it.program to it.sudo }
        assertEquals(mapOf("zsh" to true, "plain" to false), plan)
    }

    @Test
    fun fileInstallValuesRunAsRepoScripts() {
        val withFile = manifestOf {
            val tool = root.program("tool") { custom("script") { command = "file:scripts/install-tool.sh" } }
            machine("m") { install(tool) }
        }
        val plan = engine().plan(withFile, "m", emptyList(), emptyMap()) { true }
        assertEquals(
            PlanItem.Install("tool", "script", "sh 'scripts/install-tool.sh'"),
            plan.single(),
        )
    }

    @Test
    fun fileInstallValuesPassArgumentsThrough() {
        val withArgs = manifestOf {
            val tool = root.program("tool") { custom("script") { command = "file:scripts/tool.sh install --verbose" } }
            machine("m") { install(tool) }
        }
        val plan = engine().plan(withArgs, "m", emptyList(), emptyMap()) { true }
        assertEquals(
            PlanItem.Install("tool", "script", "sh 'scripts/tool.sh' install --verbose"),
            plan.single(),
        )
    }

    @Test
    fun aProgramsPathComesFirstOnTheInstallCommandsPath() {
        val m = manifestOf {
            val tool = root.program("tool") {
                path("\$HOME/.local/bin")
                custom { command = "file:install.sh" }
            }
            machine("m") { install(tool) }
        }
        val item = engine().plan(m, "m", emptyList(), emptyMap()) { true }.single() as PlanItem.Install
        assertEquals("PATH=\"\$HOME/.local/bin:\$PATH\"; export PATH; sh 'install.sh'", item.command)
    }

    @Test
    fun anInstallersRequirementIsPlannedFirst() {
        val m = manifestOf {
            val setup = root.program("setup-brew") { custom { command = "setup" } }
            val brew = root.installer("brew") { install = "brew install {pkg}" }
            brew.requires(setup)
            val jq = root.program("jq") { installVia(brew) }
            machine("m") { install(setup, jq) }
            machine("bare") { install(jq) }
        }
        val plan = engine().plan(m, "m", listOf("jq"), emptyMap()) { true }
        assertEquals(listOf("setup-brew", "jq"), plan.map { it.program })

        // The requirement is a dependency: a machine that doesn't install it can't install jq.
        val e = assertFailsWith<ResolutionException> {
            engine().plan(m, "bare", emptyList(), emptyMap()) { true }
        }
        assertTrue("'setup-brew' is required as a dependency" in e.message.orEmpty(), e.message)
    }

    @Test
    fun tiesBreakByName() {
        val m = manifestOf {
            val zeta = root.program("zeta") { custom { command = "z" } }
            val alpha = root.program("alpha") { custom { command = "a" } }
            machine("m") { install(zeta, alpha) }
        }
        val plan = engine().plan(m, "m", listOf("zeta", "alpha"), emptyMap()) { true }
        assertEquals(listOf("alpha", "zeta"), plan.map { it.program })
    }

    @Test
    fun emptyRequestPlansEverything() {
        val plan = engine().plan(manifest, "laptop", emptyList(), emptyMap()) { true }
        assertEquals(setOf("git", "ripgrep", "rustup"), plan.map { it.program }.toSet())
    }

    @Test
    fun failsWhenMachineIsNotDeclared() {
        val e = assertFailsWith<ResolutionException> {
            engine().plan(manifest, "unknown-box", emptyList(), emptyMap()) { true }
        }
        assertTrue("machine 'unknown-box' is not declared in the repo" in e.message.orEmpty(), e.message)
    }

    @Test
    fun convergeSkipsUnmappedPrograms() {
        val partial = manifestOf {
            val a = root.program("a") { installVia(Builtin.dnf { command = "sudo dnf install -y a" }) }
            root.program("b") { installVia(Builtin.dnf { command = "sudo dnf install -y b" }) }
            machine("m") { install(a) }
        }
        // b is not part of m's loadout: converge plans only a, no error.
        val plan = engine().plan(partial, "m", emptyList(), emptyMap()) { true }
        assertEquals(listOf("a"), plan.map { it.program })

        // ...but explicitly requesting it is an error.
        val e = assertFailsWith<ResolutionException> {
            engine().plan(partial, "m", listOf("b"), emptyMap()) { true }
        }
        assertTrue("program 'b' isn't installed on machine 'm'" in e.message.orEmpty(), e.message)
    }

    @Test
    fun unmappedDependencyOfMappedProgramFails() {
        val partial = manifestOf {
            val base = root.program("base") { installVia(Builtin.dnf { command = "sudo dnf install -y base" }) }
            val tool = root.program("tool") {
                dependsOn(base)
                installVia(Builtin.dnf { command = "sudo dnf install -y tool" })
            }
            machine("m") { install(tool) }
        }
        val e = assertFailsWith<ResolutionException> {
            engine().plan(partial, "m", emptyList(), emptyMap()) { true }
        }
        assertTrue("required as a dependency" in e.message.orEmpty())
        assertTrue("'base'" in e.message.orEmpty())
    }

    @Test
    fun failsWhenMappedPmIsNotInstalled() {
        val e = assertFailsWith<ResolutionException> {
            engine().plan(manifest, "laptop", listOf("ripgrep"), emptyMap()) { false }
        }
        assertTrue("required binary 'dnf'" in e.message.orEmpty())
        assertTrue("not installed on machine 'laptop'" in e.message.orEmpty())
    }

    @Test
    fun probeProvidedByAnEarlierProgramInThePlan() {
        val m = manifestOf {
            val pkg = root.installer("pkg") {
                probe = "pkg"
                install = "pkg add {pkg}"
                check = "pkg info {pkg}"
            }
            val flat = root.installer("flat") {
                probe = "flat"
                install = "flat install {pkg}"
                check = "flat info {pkg}"
            }
            val runtime = root.program("flat-runtime") {
                installVia(pkg { provides("flat") })
            }
            flat.requires(runtime)
            val app = root.program("app") { installVia(flat) }
            machine("m") { install(runtime, app) }
        }
        val onlyPkg: (String) -> Boolean = { it == "pkg" }

        // flat is missing, but flat-runtime installs it first.
        val plan = engine().plan(m, "m", listOf("app"), emptyMap(), onlyPkg)
        assertEquals(listOf("flat-runtime", "app"), plan.map { it.program })

        // Already installed and still no binary: nothing in the plan provides it.
        val installed = mapOf("flat-runtime" to ProgramState(ProgramStatus.INSTALLED, "1.0"))
        val e = assertFailsWith<ResolutionException> {
            engine().plan(m, "m", listOf("app"), installed, onlyPkg)
        }
        assertTrue("required binary 'flat' (needed to install app) is not installed" in e.message.orEmpty())

        // A provider later in the plan doesn't count, and the error says how to order it.
        val m2 = manifestOf {
            val pkg = root.installer("pkg") { probe = "pkg"; install = "pkg add {pkg}"; check = "pkg info {pkg}" }
            val first = root.program("first") { installVia(pkg { probe = "flat" }) }
            val runtime = root.program("flat-runtime") {
                dependsOn(first)
                installVia(pkg { provides("flat") })
            }
            machine("m") { install(first, runtime) }
        }
        val late = assertFailsWith<ResolutionException> {
            engine().plan(m2, "m", emptyList(), emptyMap(), onlyPkg)
        }
        assertTrue("comes from 'flat-runtime', which would install after them" in late.message.orEmpty())
        assertTrue("needed to install first)" in late.message.orEmpty())
    }

    @Test
    fun aProvidedToolOffPathIsFoundWhereItLandsAndRunsFromThere() {
        val m = manifestOf {
            val pkg = root.installer("pkg") { probe = "pkg"; install = "pkg add {pkg}"; check = "pkg info {pkg}" }
            val brewish = root.installer("brewish") {
                probe = "brewish"
                install = "brewish install {pkg}"
                check = "brewish list {pkg}"
            }
            val setup = root.program("setup-brewish") {
                custom(name = "linux") {
                    command = "install-brewish"
                    provides("brewish", at = "/opt/brewish/bin")
                }
                custom(name = "macos") {
                    command = "install-brewish"
                    provides("brewish", at = "/opt/other/bin")
                }
            }
            brewish.requires(setup)
            val tool = root.program("tool") { installVia(brewish) }
            machine("m") { install(setup.variant(name = "linux"), tool) }
        }.forMachine("m")

        // Only the mapped variant's folder counts.
        assertEquals(mapOf("brewish" to listOf("/opt/brewish/bin")), m.toolPaths)

        // Installed already, off PATH: found where it lands, and the install runs with it first on PATH.
        val installed = mapOf("setup-brewish" to ProgramState(ProgramStatus.INSTALLED, null))
        val plan = engine().plan(m, "m", listOf("tool"), installed) { it == "/opt/brewish/bin/brewish" }
        val step = plan.filterIsInstance<PlanItem.Install>().single()
        assertEquals("""PATH="/opt/brewish/bin:${'$'}PATH"; export PATH; brewish install tool""", step.command)

        // The check goes through it from there too.
        assertEquals(listOf("/opt/brewish/bin"), m.checkFor("tool", "brewish")?.path)
        assertEquals(listOf("/opt/brewish/bin"), m.toolPathOf("brewish"))
    }

    @Test
    fun pmCheckSkippedForInstalledProgramsAndCustomKeys() {
        // Everything installed -> no Install items -> pm availability never consulted.
        val states = mapOf(
            "git" to ProgramState(ProgramStatus.INSTALLED, "2.46.0"),
            "ripgrep" to ProgramState(ProgramStatus.INSTALLED, "14.1.0"),
            "rustup" to ProgramState(ProgramStatus.INSTALLED, "1.27.1"),
        )
        val plan = engine().plan(manifest, "laptop", emptyList(), states) { error("must not probe") }
        assertTrue(plan.all { it is PlanItem.AlreadyInstalled })

        // Custom keys (script) are never probed either.
        val scriptOnly = engine().plan(manifest, "laptop", listOf("rustup"), emptyMap()) { false }
        assertEquals("rustup", (scriptOnly.single() as PlanItem.Install).program)
    }

    @Test
    fun installerMechanicsResolveByMappedKey() {
        val m = manifestOf {
            val cask = root.installer("brew-cask") {
                probe = "brew"
                install = "brew install --cask {pkg}"
                check = "brew list --cask --versions {pkg}"
                regex = "([0-9.]+)"
            }
            val toolbox = root.program("toolbox") { installVia(cask("toolbox-linux")) }
            machine("m") { install(toolbox) }
        }
        // Probe: the variant inherits its installer's probe binary.
        val probed = mutableListOf<String>()
        engine().plan(m, "m", emptyList(), emptyMap()) { probed += it; true }
        assertEquals(listOf("brew"), probed)

        // Probe failure names the binary.
        val e = assertFailsWith<ResolutionException> {
            engine().plan(m, "m", emptyList(), emptyMap()) { false }
        }
        assertTrue("required binary 'brew'" in e.message.orEmpty())

        // Post-install re-check uses the mapped key's check, not the default.
        val runner = FakeProcessRunner()
        runner.onCommand("brew install --cask toolbox-linux")
        runner.onCommand("brew list --cask --versions toolbox-linux", stdout = "toolbox-linux 3.5.0")
        val plan = engine(runner).plan(m, "m", emptyList(), emptyMap()) { true }
        val outcome = engine(runner).execute(m, plan).single()
        assertTrue(outcome.success)
        assertEquals("3.5.0", outcome.stateAfter.version)
    }

    @Test
    fun executeRunsInstallsAndRechecksVersions() {
        val runner = FakeProcessRunner()
        runner.onCommand("sudo dnf install -y ripgrep")
        runner.onCommand("rg --version", stdout = "ripgrep 14.1.0")

        val plan = engine(runner).plan(manifest, "laptop", listOf("ripgrep"), emptyMap()) { true }
        val outcomes = engine(runner).execute(manifest, plan)

        // git (dependency) install fails (unregistered command); ripgrep succeeds.
        assertEquals(listOf("git", "ripgrep"), outcomes.map { it.program })
        val ripgrep = outcomes.first { it.program == "ripgrep" }
        assertTrue(ripgrep.success)
        assertEquals("14.1.0", ripgrep.stateAfter.version)
        assertTrue(!outcomes.first { it.program == "git" }.success)
    }
}
