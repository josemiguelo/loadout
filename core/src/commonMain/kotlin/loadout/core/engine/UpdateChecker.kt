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

    /**
     * Run one installer's batch oracle (`outdated-all`): every output line is
     * `<pkg> <candidate text>` — first whitespace-separated token is the
     * package id, the rest is the text the per-program regex extracts the
     * version from. Exit code ignored, like [candidate].
     */
    fun batchCandidates(command: String): Map<String, String> {
        val result = runner.capture(expandFilePrefix(command), workDir)
        return result.stdout.ifBlank { result.stderr }.lineSequence()
            .mapNotNull { line ->
                val trimmed = line.trim()
                val split = trimmed.indexOfFirst { it.isWhitespace() }
                if (split <= 0) null else trimmed.take(split) to trimmed.drop(split).trim()
            }
            .toMap()
    }

    /** Run all batch oracles (installer name -> command) concurrently. */
    suspend fun batchAll(commands: Map<String, String>): Map<String, Map<String, String>> =
        withContext(blockingDispatcher) {
            coroutineScope {
                commands.map { (installer, command) ->
                    async { installer to batchCandidates(command) }
                }.awaitAll().toMap()
            }
        }

    /**
     * Run one custom `[outdated.<name>]` source: each output line is
     * `<item> <current> <candidate> [note...]` (whitespace-separated; the
     * optional tail renders as a dim annotation, short lines are skipped).
     * Exit code ignored, like the rest.
     */
    fun sourceRows(command: String): List<SourceRow> {
        val result = runner.capture(expandFilePrefix(command), workDir)
        return result.stdout.ifBlank { result.stderr }.lineSequence()
            .mapNotNull { line ->
                val tokens = line.trim().split(Regex("\\s+"))
                if (tokens.size >= 3) {
                    SourceRow(tokens[0], tokens[1], tokens[2], tokens.drop(3).joinToString(" "))
                } else {
                    null
                }
            }
            .toList()
    }

    /** Run all custom sources (name -> command) concurrently. */
    suspend fun sourcesAll(commands: Map<String, String>): Map<String, List<SourceRow>> =
        withContext(blockingDispatcher) {
            coroutineScope {
                commands.map { (name, command) ->
                    async { name to sourceRows(command) }
                }.awaitAll().toMap()
            }
        }
}

/** One row from a custom outdated source; [note] is an optional annotation. */
data class SourceRow(val name: String, val current: String, val candidate: String, val note: String = "")
