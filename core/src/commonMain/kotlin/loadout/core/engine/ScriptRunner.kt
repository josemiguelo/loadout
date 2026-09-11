package loadout.core.engine

import loadout.core.exec.ProcessRunner
import loadout.core.model.OsFamily
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus
import loadout.core.model.ScriptStep
import loadout.core.model.expandFilePrefix
import loadout.core.platform.nowIso
import okio.Path

sealed interface ScriptOutcome {
    /** The step's os filter excludes this machine. */
    data object NotApplicable : ScriptOutcome

    /** The check command exited 0, so the step was already done. */
    data object AlreadyDone : ScriptOutcome

    data class Ran(val state: ScriptState) : ScriptOutcome
}

class ScriptRunner(
    private val runner: ProcessRunner,
    private val repoRoot: Path,
) {
    companion object {
        /**
         * Give [command] (a check, `file:` prefix allowed) the machine's
         * script arguments as positional parameters.
         */
        fun withArgs(command: String, args: String): String {
            val expanded = expandFilePrefix(command)
            return if (args.isEmpty()) expanded else "set -- $args; $expanded"
        }

        /** The shell command that executes [step] itself (not its check). */
        fun commandFor(step: ScriptStep, args: String): String =
            step.file?.let { "sh '$it'" + if (args.isEmpty()) "" else " $args" } ?: step.run!!
    }

    /**
     * Run [step] unless its `check` already passes (or [force]). [args] is the
     * machine's argument string; it reaches both the `check` (as positional
     * parameters) and a `file` script's argv. Output goes straight to the
     * terminal — the maintain screen streams via ProcessRunner.stream instead.
     */
    fun run(
        step: ScriptStep,
        os: OsFamily,
        force: Boolean = false,
        args: String = "",
    ): ScriptOutcome {
        if (!step.appliesTo(os)) return ScriptOutcome.NotApplicable

        if (!force && step.check != null) {
            if (runner.capture(withArgs(step.check!!, args), workDir = repoRoot.toString()).success) {
                return ScriptOutcome.AlreadyDone
            }
        }

        // Validation guarantees exactly one of file/run is set, and that args
        // are only used with file scripts.
        val exitCode = runner.inherit(commandFor(step, args), repoRoot.toString())
        return ScriptOutcome.Ran(
            ScriptState(
                status = if (exitCode == 0) ScriptStatus.DONE else ScriptStatus.FAILED,
                lastRun = nowIso(),
                exitCode = exitCode,
            ),
        )
    }
}
