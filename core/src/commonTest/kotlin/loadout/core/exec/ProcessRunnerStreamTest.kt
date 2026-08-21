package loadout.core.exec

import loadout.core.FakeProcessRunner
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class ProcessRunnerStreamTest {
    @Test
    fun defaultStreamDeliversLinesAndExitCode() {
        val runner = FakeProcessRunner()
        runner.onCommand("drift-check", exitCode = 1, stdout = "missing: rust 1.97.1\n", stderr = "warn: slow\n")
        val lines = mutableListOf<String>()
        var handle: RunningProcess? = null
        val exit = runner.stream("drift-check", onStart = { handle = it }) { lines += it }
        assertEquals(1, exit)
        assertEquals(listOf("missing: rust 1.97.1", "warn: slow"), lines)
        assertNotNull(handle).kill() // no-op, must not throw
    }
}
