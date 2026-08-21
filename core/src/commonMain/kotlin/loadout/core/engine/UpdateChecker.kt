package loadout.core.engine

import loadout.core.exec.ProcessRunner
import loadout.core.model.VersionCheck
import loadout.core.model.expandFilePrefix
import loadout.core.platform.blockingDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/**
 * Runs installers' `outdated` commands: each prints the candidate version
 * available from the remote source (nothing when up to date). Unlike a
 * version check, the exit code is ignored — `dnf check-update` exits 100
 * exactly when updates exist — only the regex match matters.
 */
class UpdateChecker(
    private val runner: ProcessRunner,
    /** Commands run with this directory as cwd (the config repo root). */
    private val workDir: String? = null,
) {
    /** The candidate version the remote offers, or null for up to date / no answer. */
    fun candidate(outdated: VersionCheck): String? {
        val result = runner.capture(expandFilePrefix(outdated.command), workDir)
        val output = result.stdout.ifBlank { result.stderr }
        return Regex(outdated.regex).find(output)?.groupValues?.getOrNull(1)
    }

    /** Check all [checks] (program name -> outdated command) concurrently. */
    suspend fun candidates(
        checks: Map<String, VersionCheck>,
        parallelism: Int = 8,
    ): Map<String, String?> = withContext(blockingDispatcher) {
        val semaphore = Semaphore(parallelism)
        coroutineScope {
            checks.map { (name, check) ->
                async {
                    semaphore.withPermit { name to candidate(check) }
                }
            }.awaitAll().toMap()
        }
    }
}
