package loadout.core.exec

import com.kgit2.kommand.process.Command
import com.kgit2.kommand.exception.KommandException
import com.kgit2.kommand.process.Stdio
import loadout.core.LoadoutException
import loadout.core.platform.takeInterrupt

/** Ctrl-C stopped a command the home screen handed the terminal to. */
class InterruptedByUser : LoadoutException("interrupted")

/** The exit code reported for a child killed by a signal, which has none. */
private const val KILLED = -1

class KommandProcessRunner : ProcessRunner {
    private fun command(command: ShellCommand): Command {
        var cmd = Command("sh").args(listOf("-c", command.line))
        if (command.cwd != null) cmd = cmd.cwd(command.cwd)
        for ((key, value) in command.env) cmd = cmd.env(key, value)
        return cmd
    }

    override fun capture(command: ShellCommand): ExecResult {
        val output = command(command)
            .stdout(Stdio.Pipe)
            .stderr(Stdio.Pipe)
            .output()
        stopIfInterrupted()
        return ExecResult(
            exitCode = output.status ?: -1,
            stdout = output.stdout.orEmpty(),
            stderr = output.stderr.orEmpty(),
        )
    }

    override fun inherit(command: ShellCommand): Int {
        val child = command(command)
            .stdout(Stdio.Inherit)
            .stderr(Stdio.Inherit)
            .spawn()
        // A child killed by a signal (Ctrl-C, the OOM killer) has no exit
        // code; kommand's wait() throws for it. Report a failure instead.
        val exit = try {
            child.wait()
        } catch (e: KommandException) {
            KILLED
        }
        stopIfInterrupted()
        return exit
    }

    /**
     * After a Ctrl-C during a home-screen hand-off, stop the command too,
     * not just the child, so it doesn't go on to its next step. Outside a
     * hand-off Ctrl-C ends loadout itself (see trapInterrupts).
     */
    private fun stopIfInterrupted() {
        if (takeInterrupt()) throw InterruptedByUser()
    }
}
