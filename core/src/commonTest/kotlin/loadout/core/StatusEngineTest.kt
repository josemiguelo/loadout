package loadout.core

import loadout.core.engine.StatusEngine
import loadout.core.engine.VersionChecker
import loadout.core.manifest.ManifestLoader
import loadout.core.model.OsFamily
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus
import loadout.core.model.SystemInfo
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest
import okio.Path.Companion.toPath

class StatusEngineTest {
    private val manifest = ManifestLoader.parse(
        """
        [programs.git]
        [programs.git.version]
        command = "git --version"
        regex = "git version ([0-9.]+)"
        [programs.git.install.dnf]
        command = "sudo dnf install -y git"

        [scripts.dotfiles]
        run = "echo setup"
        check = "test -d ${'$'}HOME/.dotfiles"

        [scripts.mac-only]
        run = "echo mac"
        os = ["macos"]
        check = "true"

        [scripts.uncheckable]
        run = "echo once"

        [scripts.not-opted-in]
        run = "echo never"
        check = "true"

        [machines.laptop]
        scripts = ["dotfiles", "mac-only", "uncheckable"]

        [machines.laptop.pm]
        git = "dnf"
        """.trimIndent(),
    )

    private val system = SystemInfo("laptop", OsFamily.LINUX, "fedora", "x86_64")

    private fun engine(runner: FakeProcessRunner) =
        StatusEngine(VersionChecker(runner), runner, "/repo".toPath())

    @Test
    fun checkedScriptObservedAsDoneEvenIfNeverRunByTool() = runTest {
        val runner = FakeProcessRunner()
        runner.onCommand("git --version", stdout = "git version 2.55.0")
        runner.onCommand("test -d \$HOME/.dotfiles")

        val state = engine(runner).refresh(manifest, system, previous = null)
        assertEquals(ScriptStatus.DONE, state.scripts.getValue("dotfiles").status)
        assertNull(state.scripts.getValue("dotfiles").lastRun)
    }

    @Test
    fun checkedScriptObservedAsPendingWhenCheckFails() = runTest {
        val state = engine(FakeProcessRunner()).refresh(manifest, system, previous = null)
        assertEquals(ScriptStatus.PENDING, state.scripts.getValue("dotfiles").status)
    }

    @Test
    fun osFilteredScriptIsAbsent() = runTest {
        val state = engine(FakeProcessRunner()).refresh(manifest, system, previous = null)
        assertFalse("mac-only" in state.scripts)
    }

    @Test
    fun scriptsWithoutOptInAreNotObserved() = runTest {
        val state = engine(FakeProcessRunner()).refresh(manifest, system, previous = null)
        assertFalse("not-opted-in" in state.scripts)
    }

    @Test
    fun uncheckableScriptKeepsRunHistoryOnly() = runTest {
        val runner = FakeProcessRunner()
        val noHistory = engine(runner).refresh(manifest, system, previous = null)
        assertFalse("uncheckable" in noHistory.scripts)

        val run = ScriptState(ScriptStatus.DONE, lastRun = "2026-08-17T10:00:00Z", exitCode = 0)
        val withRun = engine(runner).refresh(
            manifest, system, previous = null, scriptRuns = mapOf("uncheckable" to run),
        )
        assertEquals(run, withRun.scripts.getValue("uncheckable"))

        // ...and it survives later refreshes via the previous state.
        val later = engine(runner).refresh(manifest, system, previous = withRun)
        assertEquals(run, later.scripts.getValue("uncheckable"))
    }

    @Test
    fun checkOverridesFreshRunStatusButKeepsHistory() = runTest {
        val runner = FakeProcessRunner()
        // The tool just ran the script "successfully", but the check still fails.
        val run = ScriptState(ScriptStatus.DONE, lastRun = "2026-08-17T10:00:00Z", exitCode = 0)
        val state = engine(runner).refresh(
            manifest, system, previous = null, scriptRuns = mapOf("dotfiles" to run),
        )
        val entry = state.scripts.getValue("dotfiles")
        assertEquals(ScriptStatus.PENDING, entry.status)
        assertEquals("2026-08-17T10:00:00Z", entry.lastRun)
        assertEquals(0, entry.exitCode)
    }
}
