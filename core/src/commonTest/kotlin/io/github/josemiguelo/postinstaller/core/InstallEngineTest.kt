package io.github.josemiguelo.postinstaller.core

import io.github.josemiguelo.postinstaller.core.engine.InstallEngine
import io.github.josemiguelo.postinstaller.core.engine.PlanItem
import io.github.josemiguelo.postinstaller.core.engine.ResolutionException
import io.github.josemiguelo.postinstaller.core.engine.VersionChecker
import io.github.josemiguelo.postinstaller.core.manifest.ManifestLoader
import io.github.josemiguelo.postinstaller.core.model.ProgramState
import io.github.josemiguelo.postinstaller.core.model.ProgramStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import okio.Path.Companion.toPath

class InstallEngineTest {
    private val manifest = ManifestLoader.parse(EXAMPLE_MANIFEST)

    private fun engine(runner: FakeProcessRunner = FakeProcessRunner()) =
        InstallEngine(runner, VersionChecker(runner), "/repo".toPath())

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
                PlanItem.Install("ripgrep", "dnf", "sudo dnf install -y ripgrep"),
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
    fun fileInstallValuesRunAsRepoScripts() {
        val withFile = ManifestLoader.parse(
            """
            [programs.tool]
            [programs.tool.install]
            script = "file:scripts/install-tool.sh"

            [machines.m.pm]
            tool = "script"
            """.trimIndent(),
        )
        val plan = engine().plan(withFile, "m", emptyList(), emptyMap()) { true }
        assertEquals(
            PlanItem.Install("tool", "script", "sh 'scripts/install-tool.sh'"),
            plan.single(),
        )
    }

    @Test
    fun emptyRequestPlansEverything() {
        val plan = engine().plan(manifest, "laptop", emptyList(), emptyMap()) { true }
        assertEquals(setOf("git", "ripgrep", "rustup"), plan.map { it.program }.toSet())
    }

    @Test
    fun failsWhenMachineHasNoMapping() {
        val e = assertFailsWith<ResolutionException> {
            engine().plan(manifest, "unknown-box", emptyList(), emptyMap()) { true }
        }
        assertTrue("machines/unknown-box.toml" in e.message.orEmpty())
    }

    @Test
    fun failsWhenProgramIsUnmapped() {
        val partial = ManifestLoader.parse(
            """
            [programs.a]
            [programs.a.install]
            dnf = "sudo dnf install -y a"

            [programs.b]
            [programs.b.install]
            dnf = "sudo dnf install -y b"

            [machines.m.pm]
            a = "dnf"
            """.trimIndent(),
        )
        val e = assertFailsWith<ResolutionException> {
            engine().plan(partial, "m", emptyList(), emptyMap()) { true }
        }
        assertTrue("program 'b' has no pm defined for machine 'm'" in e.message.orEmpty())
    }

    @Test
    fun failsWhenMappedPmIsNotInstalled() {
        val e = assertFailsWith<ResolutionException> {
            engine().plan(manifest, "laptop", listOf("ripgrep"), emptyMap()) { false }
        }
        assertTrue("package manager 'dnf'" in e.message.orEmpty())
        assertTrue("not installed on machine 'laptop'" in e.message.orEmpty())
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
