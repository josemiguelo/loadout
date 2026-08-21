package loadout.core.exec

import com.kgit2.kommand.process.Command
import com.kgit2.kommand.process.Stdio

class KommandProcessRunner : ProcessRunner {
    private fun command(command: String, workDir: String?): Command {
        var cmd = Command("sh").args(listOf("-c", command))
        if (workDir != null) cmd = cmd.cwd(workDir)
        return cmd
    }

    override fun capture(command: String, workDir: String?): ExecResult {
        val output = command(command, workDir)
            .stdout(Stdio.Pipe)
            .stderr(Stdio.Pipe)
            .output()
        return ExecResult(
            exitCode = output.status ?: -1,
            stdout = output.stdout.orEmpty(),
            stderr = output.stderr.orEmpty(),
        )
    }

    override fun inherit(command: String, workDir: String?): Int {
        return command(command, workDir)
            .stdout(Stdio.Inherit)
            .stderr(Stdio.Inherit)
            .spawn()
            .wait()
    }

    override fun stream(
        command: String,
        workDir: String?,
        onStart: (RunningProcess) -> Unit,
        onLine: (String) -> Unit,
    ): Int {
        // `exec 2>&1` merges stderr into the stdout pipe without a subshell,
        // so sh can tail-exec the command and kill() reaches the real process.
        // ponytail: kill() hits the direct child only — a grandchild that
        // keeps the pipe open delays the reader until it exits; process-group
        // kill if that ever bites.
        val child = command("exec 2>&1\n$command", workDir)
            .stdout(Stdio.Pipe)
            .stderr(Stdio.Pipe)
            .spawn()
        onStart(object : RunningProcess {
            override fun kill() {
                runCatching { child.kill() }
            }
        })
        val stdout = child.bufferedStdout()
        runCatching {
            while (true) onLine(stdout?.readLine() ?: break)
        }
        return runCatching { child.wait() }.getOrDefault(-1)
    }
}
