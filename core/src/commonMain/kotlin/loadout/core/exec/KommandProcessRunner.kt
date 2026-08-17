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
}
