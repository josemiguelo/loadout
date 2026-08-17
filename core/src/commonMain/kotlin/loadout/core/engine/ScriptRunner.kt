package loadout.core.engine

import loadout.core.exec.ProcessRunner
import loadout.core.model.OsFamily
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus
import loadout.core.model.ScriptStep
import loadout.core.platform.nowIso
import okio.Path

sealed interface ScriptOutcome {
    /** The step's os filter excludes this machine. */
    data object NotApplicable : ScriptOutcome

    /** The check command exited 0, so the step was already done. */
    data object AlreadyDone : ScriptOutcome

    data class Ran(val state: ScriptState, val output: String = "") : ScriptOutcome
}

class ScriptRunner(
    private val runner: ProcessRunner,
    private val repoRoot: Path,
) {
    /**
     * [captureOutput] runs the script with captured (not inherited) stdio and
     * returns it in [ScriptOutcome.Ran.output] — for UIs that own the terminal.
     */
    fun run(
        step: ScriptStep,
        os: OsFamily,
        force: Boolean = false,
        captureOutput: Boolean = false,
    ): ScriptOutcome {
        if (!step.appliesTo(os)) return ScriptOutcome.NotApplicable

        if (!force && step.check != null) {
            if (runner.capture(step.check, workDir = repoRoot.toString()).success) {
                return ScriptOutcome.AlreadyDone
            }
        }

        // Validation guarantees exactly one of file/run is set.
        val command = step.file?.let { "sh '$it'" } ?: step.run!!
        val workDir = repoRoot.toString()
        val (exitCode, output) = if (captureOutput) {
            val result = runner.capture(command, workDir)
            result.exitCode to (result.stdout + result.stderr)
        } else {
            runner.inherit(command, workDir) to ""
        }
        return ScriptOutcome.Ran(
            ScriptState(
                status = if (exitCode == 0) ScriptStatus.DONE else ScriptStatus.FAILED,
                lastRun = nowIso(),
                exitCode = exitCode,
            ),
            output = output,
        )
    }
}
