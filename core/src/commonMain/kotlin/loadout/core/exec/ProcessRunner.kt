package loadout.core.exec

data class ExecResult(
    val exitCode: Int,
    val stdout: String,
    val stderr: String,
) {
    val success: Boolean get() = exitCode == 0
}

/**
 * One shell command line and the frame it runs in: [cwd] (null = the
 * caller's) and [env], added to the inherited environment.
 */
data class ShellCommand(
    val line: String,
    val cwd: String? = null,
    val env: Map<String, String> = emptyMap(),
)

/**
 * Runs shell commands. All commands go through `sh -c`, so pipes, redirects
 * and env-var references work as they would in a terminal.
 */
interface ProcessRunner {
    /** Run [command] capturing stdout/stderr (version checks, probes, git plumbing). */
    fun capture(command: ShellCommand): ExecResult

    /**
     * Run [command] with stdio inherited from the parent terminal, so
     * interactive prompts (sudo) and progress bars work. Returns the exit code.
     */
    fun inherit(command: ShellCommand): Int

    fun capture(command: String, workDir: String? = null): ExecResult = capture(ShellCommand(command, workDir))

    fun inherit(command: String, workDir: String? = null): Int = inherit(ShellCommand(command, workDir))
}
