package io.github.josemiguelo.postinstaller.core

import io.github.josemiguelo.postinstaller.core.exec.ExecResult
import io.github.josemiguelo.postinstaller.core.exec.ProcessRunner

/**
 * Scripted ProcessRunner for tests. Register responses per command; unregistered
 * commands fail with exit 127 (like a missing binary would).
 */
class FakeProcessRunner : ProcessRunner {
    private val responses = mutableMapOf<String, ExecResult>()
    val executed = mutableListOf<String>()

    fun onCommand(command: String, exitCode: Int = 0, stdout: String = "", stderr: String = "") {
        responses[command] = ExecResult(exitCode, stdout, stderr)
    }

    override fun capture(command: String, workDir: String?): ExecResult {
        executed += command
        return responses[command] ?: ExecResult(127, "", "sh: command not found")
    }

    override fun inherit(command: String, workDir: String?): Int =
        capture(command, workDir).exitCode
}
