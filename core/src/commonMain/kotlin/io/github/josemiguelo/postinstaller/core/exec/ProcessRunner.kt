package io.github.josemiguelo.postinstaller.core.exec

data class ExecResult(
    val exitCode: Int,
    val stdout: String,
    val stderr: String,
) {
    val success: Boolean get() = exitCode == 0
}

/**
 * Runs shell commands. All commands go through `sh -c`, so pipes, redirects
 * and env-var references work as they would in a terminal.
 */
interface ProcessRunner {
    /** Run [command] capturing stdout/stderr (version checks, probes, git plumbing). */
    fun capture(command: String, workDir: String? = null): ExecResult

    /**
     * Run [command] with stdio inherited from the parent terminal, so
     * interactive prompts (sudo) and progress bars work. Returns the exit code.
     */
    fun inherit(command: String, workDir: String? = null): Int
}
