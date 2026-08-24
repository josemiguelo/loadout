package loadout.core

import loadout.core.exec.ExecResult
import loadout.core.exec.ProcessRunner
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi

/**
 * Scripted ProcessRunner for tests. Register responses per command; unregistered
 * commands fail with exit 127 (like a missing binary would). Checks run
 * concurrently in the engines, so the executed log is lock-free-atomic.
 */
@OptIn(ExperimentalAtomicApi::class)
class FakeProcessRunner : ProcessRunner {
    private val responses = mutableMapOf<String, ExecResult>()
    private val executedRef = AtomicReference<List<String>>(emptyList())

    val executed: List<String> get() = executedRef.load()

    fun onCommand(command: String, exitCode: Int = 0, stdout: String = "", stderr: String = "") {
        responses[command] = ExecResult(exitCode, stdout, stderr)
    }

    override fun capture(command: String, workDir: String?): ExecResult {
        while (true) {
            val current = executedRef.load()
            if (executedRef.compareAndSet(current, current + command)) break
        }
        return responses[command] ?: ExecResult(127, "", "sh: command not found")
    }

    override fun inherit(command: String, workDir: String?): Int =
        capture(command, workDir).exitCode
}
