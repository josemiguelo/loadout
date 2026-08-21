package loadout.core.exec

data class ExecResult(
    val exitCode: Int,
    val stdout: String,
    val stderr: String,
) {
    val success: Boolean get() = exitCode == 0
}

/** Handle to a live process started by [ProcessRunner.stream]. */
interface RunningProcess {
    fun kill()
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

    /**
     * Run [command] with stderr merged into stdout, delivering each output
     * line to [onLine] (the TUI's live log panes). [onStart] receives a kill
     * handle before the first line. Blocks until exit; returns the exit code.
     * This default delivers all lines only after the process exits;
     * [KommandProcessRunner] overrides it with true line-by-line streaming.
     */
    fun stream(
        command: String,
        workDir: String? = null,
        onStart: (RunningProcess) -> Unit = {},
        onLine: (String) -> Unit,
    ): Int {
        onStart(object : RunningProcess {
            override fun kill() {}
        })
        val result = capture(command, workDir)
        (result.stdout + result.stderr).lineSequence().filter { it.isNotEmpty() }.forEach(onLine)
        return result.exitCode
    }
}
