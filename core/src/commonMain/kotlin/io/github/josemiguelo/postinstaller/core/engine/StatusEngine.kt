package io.github.josemiguelo.postinstaller.core.engine

import io.github.josemiguelo.postinstaller.core.TOOL_VERSION
import io.github.josemiguelo.postinstaller.core.exec.ProcessRunner
import io.github.josemiguelo.postinstaller.core.model.MachineState
import io.github.josemiguelo.postinstaller.core.model.Manifest
import io.github.josemiguelo.postinstaller.core.model.ScriptState
import io.github.josemiguelo.postinstaller.core.model.ScriptStatus
import io.github.josemiguelo.postinstaller.core.model.SystemInfo
import io.github.josemiguelo.postinstaller.core.platform.nowIso
import okio.Path

/**
 * Builds this machine's [MachineState] by observing it: every program's
 * version check runs, and every applicable script's `check` command runs.
 */
class StatusEngine(
    private val checker: VersionChecker,
    private val runner: ProcessRunner,
    private val repoRoot: Path,
) {
    /**
     * [scriptRuns] are results of scripts the tool just executed; their
     * lastRun/exitCode history is kept, but a script's `check` has the final
     * word on its status:
     * - check exits 0 -> done (whether or not the tool ever ran it)
     * - check fails   -> pending (even right after a run — the check is the truth)
     * - no check      -> only actual run history can be recorded
     * Scripts whose os filter excludes this machine are absent from the state.
     */
    suspend fun refresh(
        manifest: Manifest,
        system: SystemInfo,
        previous: MachineState?,
        scriptRuns: Map<String, ScriptState> = emptyMap(),
    ): MachineState {
        val scripts = mutableMapOf<String, ScriptState>()
        for ((name, step) in manifest.scripts) {
            if (!step.appliesTo(system.os)) continue
            val history = scriptRuns[name] ?: previous?.scripts?.get(name)
            if (step.check != null) {
                val done = runner.capture(step.check, workDir = repoRoot.toString()).success
                scripts[name] = ScriptState(
                    status = if (done) ScriptStatus.DONE else ScriptStatus.PENDING,
                    lastRun = history?.lastRun,
                    exitCode = history?.exitCode,
                )
            } else if (history != null) {
                scripts[name] = history
            }
        }

        return MachineState(
            machine = system.machine,
            os = system.os.id,
            distro = system.distro,
            arch = system.arch,
            toolVersion = TOOL_VERSION,
            updatedAt = nowIso(),
            programs = checker.checkAll(manifest.programs),
            scripts = scripts,
        )
    }
}
