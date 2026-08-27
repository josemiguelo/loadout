package loadout.tui

import loadout.cli.AppContext
import loadout.core.exec.ExecResult
import loadout.core.exec.ProcessRunner
import loadout.theme.detectDarkTerminal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import okio.Path.Companion.toPath

/** Scripted runner; stream() uses the interface default over capture(). */
private class ScriptedRunner(private val results: Map<String, ExecResult>) : ProcessRunner {
    override fun capture(command: String, workDir: String?): ExecResult =
        results[command] ?: ExecResult(127, "", "sh: command not found")

    override fun inherit(command: String, workDir: String?): Int = capture(command, workDir).exitCode
}

class ThemeDetectionTest {
    @Test
    fun oscLumaWinsOverColorFgBg() {
        assertEquals(true, detectDarkTerminal(0.08, null))
        assertEquals(false, detectDarkTerminal(0.93, "15;0"))
    }

    @Test
    fun colorFgBgFallbackAndUnknownDefaultsDark() {
        assertEquals(true, detectDarkTerminal(null, "15;0"))
        assertEquals(false, detectDarkTerminal(null, "0;15"))
        assertEquals(false, detectDarkTerminal(null, "0;7"))
        assertEquals(true, detectDarkTerminal(null, null))
        assertEquals(true, detectDarkTerminal(null, "garbage"))
        assertEquals(false, detectDarkTerminal(null, "12;default;15"))
    }
}

class DisplayLinesTest {
    @Test
    fun carriageReturnProgressCollapsesToFinalState() {
        assertEquals(listOf("progress 100%"), displayLines("progress 10%\rprogress 50%\rprogress 100%"))
    }

    @Test
    fun ansiEscapesAreStrippedAndTabsExpanded() {
        assertEquals(listOf("colored ok"), displayLines("\u001b[32mcolored ok\u001b[0m"))
        assertEquals(listOf("a    b    c"), displayLines("a\tb\tc"))
    }

    @Test
    fun embeddedNewlinesSplitAndBlanksDrop() {
        assertEquals(listOf("one", "two"), displayLines("one\n\ntwo\n"))
    }
}

class MaintainModelTest {
    private fun model(
        rows: List<MaintainRow>,
        phase: MaintainPhase = MaintainPhase.SELECT,
        selected: Set<String> = emptySet(),
        viewing: String? = null,
        results: Map<String, ExecResult> = emptyMap(),
    ): MaintainModel {
        val m = MaintainModel(
            AppContext("/repo".toPath(), "manifest.toml", null, false),
            runner = ScriptedRunner(results),
        )
        m.setStateForTest(MaintainState(rows = rows, phase = phase, selected = selected, viewing = viewing))
        return m
    }

    private fun rows(vararg names: String) = names.map { MaintainRow(it, "run-$it") }

    @Test
    fun spaceTogglesSelectionAllAndNoneWork() {
        val m = model(rows("one", "two"))
        m.handleKey(MaintainKey.SPACE)
        assertEquals(setOf("one"), m.state.selected)
        m.handleKey(MaintainKey.SPACE)
        assertEquals(emptySet(), m.state.selected)
        m.handleKey(MaintainKey.A)
        assertEquals(setOf("one", "two"), m.state.selected)
        m.handleKey(MaintainKey.N)
        assertEquals(emptySet(), m.state.selected)
    }

    @Test
    fun enterNeedsASelection() {
        val m = model(rows("one"))
        assertFalse(m.handleKey(MaintainKey.ENTER))
        assertTrue(m.state.message!!.startsWith("nothing selected"))
        m.handleKey(MaintainKey.SPACE)
        assertTrue(m.handleKey(MaintainKey.ENTER))
    }

    @Test
    fun runSelectedRunsOnlySelectedAndChecksDecideStatus() = runBlocking {
        val m = model(
            rows = listOf(
                MaintainRow("fixed", "run-fixed", checkCommand = "check-fixed"),
                MaintainRow("stubborn", "run-stubborn", checkCommand = "check-stubborn"),
                MaintainRow("unpicked", "run-unpicked"),
            ),
            selected = setOf("fixed", "stubborn"),
            results = mapOf(
                "run-fixed" to ExecResult(0, "installing things\n", ""),
                "check-fixed" to ExecResult(0, "", ""),
                // Script exits 0 but its check still fails -> pending.
                "run-stubborn" to ExecResult(0, "", ""),
                "check-stubborn" to ExecResult(1, "", ""),
            ),
        )
        m.runSelected()
        val byName = m.state.rows.associateBy { it.name }
        assertEquals(RunStatus.DONE, byName.getValue("fixed").status)
        assertEquals(RunStatus.PENDING, byName.getValue("stubborn").status)
        assertEquals(RunStatus.WAITING, byName.getValue("unpicked").status)
        assertEquals(
            listOf("$ run-fixed", "installing things", "exit 0", "check: passed"),
            byName.getValue("fixed").log,
        )
        assertEquals(MaintainPhase.DONE, m.state.phase)
        assertEquals(1, m.state.exitCode)
        assertTrue("1 of 2 failed or still pending" in m.state.message!!)
    }

    @Test
    fun checklessScriptStatusComesFromExitCode() = runBlocking {
        val m = model(
            rows = listOf(
                MaintainRow("ok", "run-ok"),
                MaintainRow("broken", "run-broken"),
            ),
            selected = setOf("ok", "broken"),
            results = mapOf(
                "run-ok" to ExecResult(0, "", ""),
                "run-broken" to ExecResult(3, "boom\n", ""),
            ),
        )
        m.runSelected()
        assertEquals(RunStatus.DONE, m.state.rows[0].status)
        assertEquals(RunStatus.FAILED, m.state.rows[1].status)
        assertEquals(listOf("$ run-broken", "boom", "exit 3"), m.state.rows[1].log)
        assertEquals(1, m.state.exitCode)
    }

    @Test
    fun allDoneExitsZero() = runBlocking {
        val m = model(
            rows = listOf(MaintainRow("ok", "run-ok")),
            selected = setOf("ok"),
            results = mapOf("run-ok" to ExecResult(0, "", "")),
        )
        m.runSelected()
        assertEquals(0, m.state.exitCode)
        assertTrue(m.state.message!!.startsWith("all 1 done"))
    }

    @Test
    fun sudoWithoutCachedCredentialsRefusesToRun() = runBlocking {
        val m = model(
            rows = listOf(MaintainRow("root-thing", "sudo something")),
            selected = setOf("root-thing"),
            results = mapOf("sudo -n true" to ExecResult(1, "", "")),
        )
        m.runSelected()
        assertEquals(MaintainPhase.SELECT, m.state.phase)
        assertTrue("sudo needs a password" in m.state.message!!)
    }

    @Test
    fun escDuringRunCancelsCurrentAndFinishes() {
        val m = model(
            rows = listOf(
                MaintainRow("first", "c1", status = RunStatus.DONE),
                MaintainRow("stuck", "c2", status = RunStatus.CHECKING),
                MaintainRow("later", "c3"),
            ),
            phase = MaintainPhase.RUNNING,
        )
        m.handleKey(MaintainKey.ESC)
        assertEquals(MaintainPhase.DONE, m.state.phase)
        assertEquals(RunStatus.CANCELLED, m.state.rows[1].status)
        assertEquals(RunStatus.WAITING, m.state.rows[2].status)
        assertEquals(1, m.state.exitCode)
        assertTrue(m.state.message!!.startsWith("cancelled"))
    }

    @Test
    fun doneViewerOpensScrollsClampedAndCloses() {
        val log = (1..30).map { "line $it" }
        val m = model(
            rows = listOf(MaintainRow("noisy", "c", status = RunStatus.PENDING, log = log)),
            phase = MaintainPhase.DONE,
        )
        m.handleKey(MaintainKey.ENTER, viewerHeight = 10)
        assertEquals("noisy", m.state.viewing)
        assertEquals(0, m.state.scroll)
        m.handleKey(MaintainKey.UP, viewerHeight = 10)
        assertEquals(0, m.state.scroll)
        m.handleKey(MaintainKey.PAGE_DOWN, viewerHeight = 10)
        assertEquals(10, m.state.scroll)
        repeat(5) { m.handleKey(MaintainKey.PAGE_DOWN, viewerHeight = 10) }
        assertEquals(20, m.state.scroll) // clamped to log.size - height
        m.handleKey(MaintainKey.ESC, viewerHeight = 10)
        assertNull(m.state.viewing)
        assertFalse(m.state.exit)
    }

    @Test
    fun viewerNeedsALogAndQuitWorksFromEveryBrowsePhase() {
        val m = model(rows = listOf(MaintainRow("silent", "c", status = RunStatus.WAITING)), phase = MaintainPhase.DONE)
        m.handleKey(MaintainKey.ENTER)
        assertNull(m.state.viewing)
        m.handleKey(MaintainKey.Q)
        assertTrue(m.state.exit)

        val select = model(rows("one"))
        select.handleKey(MaintainKey.Q)
        assertTrue(select.state.exit)
    }
}
