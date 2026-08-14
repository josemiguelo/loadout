package io.github.josemiguelo.postinstaller.core.engine

import io.github.josemiguelo.postinstaller.core.exec.ProcessRunner
import io.github.josemiguelo.postinstaller.core.model.Program
import io.github.josemiguelo.postinstaller.core.model.ProgramState
import io.github.josemiguelo.postinstaller.core.model.ProgramStatus
import io.github.josemiguelo.postinstaller.core.platform.blockingDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

class VersionChecker(private val runner: ProcessRunner) {
    /**
     * - no version check declared -> UNKNOWN
     * - command exits non-zero (typically 127, not found) -> MISSING
     * - command succeeds and regex matches -> INSTALLED with the captured version
     * - command succeeds but regex does not match -> INSTALLED without a version
     */
    fun check(program: Program): ProgramState {
        val versionCheck = program.version ?: return ProgramState(ProgramStatus.UNKNOWN)
        val result = runner.capture(versionCheck.command)
        if (!result.success) return ProgramState(ProgramStatus.MISSING)

        val output = result.stdout.ifBlank { result.stderr }
        val version = Regex(versionCheck.regex).find(output)?.groupValues?.getOrNull(1)
        return ProgramState(ProgramStatus.INSTALLED, version)
    }

    /** Check all [programs] concurrently with bounded parallelism. */
    suspend fun checkAll(
        programs: Map<String, Program>,
        parallelism: Int = 8,
    ): Map<String, ProgramState> = withContext(blockingDispatcher) {
        val semaphore = Semaphore(parallelism)
        coroutineScope {
            programs.map { (name, program) ->
                async {
                    semaphore.withPermit { name to check(program) }
                }
            }.awaitAll().toMap()
        }
    }
}
