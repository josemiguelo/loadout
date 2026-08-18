package loadout.core.engine

import loadout.core.TOOL_VERSION
import loadout.core.exec.ProcessRunner
import loadout.core.model.MachineState
import loadout.core.model.Manifest
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus
import loadout.core.model.SystemInfo
import loadout.core.platform.nowIso
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
     * Only scripts this machine opted into (its `[scripts]` table) are
     * observed; the os filter applies on top.
     */
    suspend fun refresh(
        manifest: Manifest,
        system: SystemInfo,
        previous: MachineState?,
        scriptRuns: Map<String, ScriptState> = emptyMap(),
    ): MachineState {
        // Membership: only programs this machine maps are part of its loadout,
        // each checked with the version check its mapped key resolves to.
        val mapped = manifest.machines[system.machine]?.pm.orEmpty()
        val observedChecks = manifest.programs.keys.filter { it in mapped }
            .associateWith { name -> manifest.checkFor(name, mapped[name]) }

        val enabled = manifest.machines[system.machine]?.scriptArgs().orEmpty()
        val scripts = mutableMapOf<String, ScriptState>()
        for ((name, args) in enabled) {
            val step = manifest.scripts[name] ?: continue
            if (!step.appliesTo(system.os)) continue
            val history = scriptRuns[name] ?: previous?.scripts?.get(name)
            if (step.check != null) {
                val check = ScriptRunner.withArgs(step.check!!, args)
                val done = runner.capture(check, workDir = repoRoot.toString()).success
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
            programs = checker.checkAll(observedChecks),
            scripts = scripts,
        )
    }
}
