package loadout.core.engine

import loadout.core.exec.ProcessRunner
import loadout.core.model.ProgramState
import loadout.core.model.VersionCheck
import loadout.core.model.expandFilePrefix
import loadout.core.model.ProgramStatus
import loadout.core.platform.blockingDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

class VersionChecker(
    private val runner: ProcessRunner,
    /** When set, checks run with this directory as cwd (the config repo root). */
    private val workDir: String? = null,
) {
    /**
     * - no version check declared -> UNKNOWN
     * - command exits non-zero (typically 127, not found) -> MISSING
     * - command succeeds and regex matches -> INSTALLED with the captured version
     * - command succeeds but regex does not match -> INSTALLED without a version
     */
    fun check(versionCheck: VersionCheck?): ProgramState {
        if (versionCheck == null) return ProgramState(ProgramStatus.UNKNOWN)
        val result = runner.capture(expandFilePrefix(versionCheck.command), workDir)
        if (!result.success) return ProgramState(ProgramStatus.MISSING)

        val output = result.stdout.ifBlank { result.stderr }
        val version = Regex(versionCheck.regex).find(output)?.groupValues?.getOrNull(1)
        return ProgramState(ProgramStatus.INSTALLED, version)
    }

    /** Check all [checks] (program name -> version check) concurrently with bounded parallelism. */
    suspend fun checkAll(
        checks: Map<String, VersionCheck?>,
        parallelism: Int = 8,
    ): Map<String, ProgramState> = withContext(blockingDispatcher) {
        val semaphore = Semaphore(parallelism)
        coroutineScope {
            checks.map { (name, versionCheck) ->
                async {
                    semaphore.withPermit { name to check(versionCheck) }
                }
            }.awaitAll().toMap()
        }
    }
}
