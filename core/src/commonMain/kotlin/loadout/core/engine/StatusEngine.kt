package loadout.core.engine

import loadout.core.TOOL_VERSION
import loadout.core.exec.ProcessRunner
import loadout.core.model.MachineState
import loadout.core.model.Manifest
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus
import loadout.core.model.SystemInfo
import loadout.core.platform.blockingDispatcher
import loadout.core.platform.nowIso
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okio.Path

/**
 * Builds this machine's [MachineState] by observing it: every program's
 * version check runs, and every applicable script's `check` command runs.
 * All checks are read-only, so they run concurrently (bounded), scripts
 * overlapping with programs — one slow check no longer serializes `status`.
 */
class StatusEngine(
    private val checker: VersionChecker,
    private val runner: ProcessRunner,
    private val repoRoot: Path,
) {
    /**
     * What each failing script check printed during the last [refresh] —
     * the "missing: ..." detail two-mode checks emit. Same surfacing pattern
     * as StateStore.lastWarnings: read it right after the call.
     */
    var lastScriptDetail: Map<String, String> = emptyMap()
        private set

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
    ): MachineState = withContext(blockingDispatcher) {
        // Membership: only programs this machine maps are part of its loadout,
        // each checked with the version check its mapped key resolves to.
        val mapped = manifest.machines[system.machine]?.pm.orEmpty()
        val observedChecks = manifest.programs.keys.filter { it in mapped }
            .associateWith { name -> manifest.checkFor(name, mapped[name]) }

        val enabled = manifest.machines[system.machine]?.scriptArgs().orEmpty()
        coroutineScope {
            val programs = async { checker.checkAll(observedChecks) }
            val semaphore = Semaphore(8)
            val scripts = enabled.mapNotNull { (name, args) ->
                val step = manifest.scripts[name] ?: return@mapNotNull null
                if (!step.appliesTo(system.os)) return@mapNotNull null
                val history = scriptRuns[name] ?: previous?.scripts?.get(name)
                when {
                    step.check != null -> {
                        val check = ScriptRunner.withArgs(step.check!!, args)
                        name to async {
                            semaphore.withPermit {
                                val result = runner.capture(check, workDir = repoRoot.toString())
                                val state = ScriptState(
                                    status = if (result.success) ScriptStatus.DONE else ScriptStatus.PENDING,
                                    lastRun = history?.lastRun,
                                    exitCode = history?.exitCode,
                                )
                                val detail = if (result.success) null else {
                                    (result.stdout + result.stderr).lineSequence()
                                        .filter { it.isNotBlank() }
                                        .joinToString("\n")
                                        .ifBlank { null }
                                }
                                state to detail
                            }
                        }
                    }
                    history != null -> name to CompletableDeferred(history to null)
                    else -> null
                }
            }

            val observed = scripts.map { (name, deferred) -> name to deferred.await() }
            lastScriptDetail = observed.mapNotNull { (name, pair) -> pair.second?.let { name to it } }.toMap()
            MachineState(
                machine = system.machine,
                os = system.os.id,
                distro = system.distro,
                arch = system.arch,
                toolVersion = TOOL_VERSION,
                updatedAt = nowIso(),
                programs = programs.await(),
                scripts = observed.associate { (name, pair) -> name to pair.first },
            )
        }
    }
}
