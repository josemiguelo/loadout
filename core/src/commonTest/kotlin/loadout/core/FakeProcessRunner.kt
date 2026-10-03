package loadout.core

import loadout.core.exec.ExecResult
import loadout.core.exec.ProcessRunner
import loadout.core.exec.ShellCommand
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi

/**
 * Scripted ProcessRunner for tests. Register responses per command; unregistered
 * commands fail with exit 127 (like a missing binary would). Checks run
 * concurrently in the engines, so the received log is lock-free-atomic.
 */
@OptIn(ExperimentalAtomicApi::class)
class FakeProcessRunner : ProcessRunner {
    private val responses = mutableMapOf<String, ExecResult>()
    private val receivedRef = AtomicReference<List<ShellCommand>>(emptyList())

    /** Every command with its cwd and env, in execution order. */
    val received: List<ShellCommand> get() = receivedRef.load()

    /** Every command line, in execution order. */
    val executed: List<String> get() = received.map { it.line }

    fun onCommand(command: String, exitCode: Int = 0, stdout: String = "", stderr: String = "") {
        responses[command] = ExecResult(exitCode, stdout, stderr)
    }

    override fun capture(command: ShellCommand): ExecResult {
        while (true) {
            val current = receivedRef.load()
            if (receivedRef.compareAndSet(current, current + command)) break
        }
        return responses[command.line] ?: ExecResult(127, "", "sh: command not found")
    }

    override fun inherit(command: ShellCommand): Int =
        capture(command).exitCode
}
