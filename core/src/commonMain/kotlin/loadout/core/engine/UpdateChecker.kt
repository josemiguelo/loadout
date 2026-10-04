package loadout.core.engine

import loadout.core.exec.CommandFrame
import loadout.core.exec.ShellCommand
import loadout.core.exec.ProcessRunner
import loadout.core.model.BatchOracle
import loadout.core.model.OutdatedSource
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
    /** Where manifest commands run and what they get (contract 5). */
    private val frame: CommandFrame = CommandFrame(),
) {
    /** The candidate version the remote offers, or null for up to date / no answer. */
    fun candidate(outdated: VersionCheck): String? {
        val result = runner.capture(frame.command(expandFilePrefix(outdated.command), outdated.origin))
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
    fun batchCandidates(command: String, origin: String = ""): Map<String, String> {
        val result = runner.capture(frame.command(expandFilePrefix(command), origin))
        // stdout ONLY: an empty stdout is "nothing outdated", and a tool's
        // stderr is warnings — `brew outdated --cask` once turned a
        // deprecation notice into packages named "Warning:" and "Please".
        return result.stdout.lineSequence()
            .mapNotNull { line ->
                val trimmed = line.trim()
                val split = trimmed.indexOfFirst { it.isWhitespace() }
                if (split <= 0) null else trimmed.take(split) to trimmed.drop(split).trim()
            }
            .toMap()
    }

    /** Run all batch oracles (installer name -> its oracle) concurrently. */
    suspend fun batchAll(oracles: Map<String, BatchOracle>): Map<String, Map<String, String>> =
        withContext(blockingDispatcher) {
            coroutineScope {
                oracles.map { (installer, oracle) ->
                    async { installer to batchCandidates(oracle.command, oracle.origin) }
                }.awaitAll().toMap()
            }
        }

    /**
     * Run one custom `outdated.<name>` source: each output line is
     * `<item> <current> <candidate> [note...]` (whitespace-separated; the
     * optional tail renders as a dim annotation, short lines are skipped).
     *
     * Unlike the installer oracles above (which ignore exit codes because
     * `dnf check-update` exits 100 on updates), a custom source is a plain
     * user script and MUST exit 0 when it ran fine — otherwise loadout can't
     * tell a crashed source from one honestly reporting "nothing outdated",
     * and a persistent failure would silently hide updates forever. So a
     * non-zero exit is reported as [SourceResult.error] (no rows trusted),
     * which the CLI surfaces as a loud line instead of empty output.
     */
    fun sourceRows(command: String, origin: String = ""): SourceResult {
        val result = runner.capture(frame.command(expandFilePrefix(command), origin))
        if (!result.success) {
            val detail = result.stderr.ifBlank { result.stdout }
                .lineSequence().map { it.trim() }.lastOrNull { it.isNotEmpty() }
            val message = buildString {
                append("exited ${result.exitCode}")
                if (!detail.isNullOrEmpty()) append(": ${detail.take(200)}")
            }
            return SourceResult(emptyList(), message)
        }
        val rows = result.stdout.ifBlank { result.stderr }.lineSequence()
            .mapNotNull { line ->
                val tokens = line.trim().split(Regex("\\s+"))
                if (tokens.size >= 3) {
                    // A URL in the tail is the row's LINK (the compare page
                    // for the two shas, say), not part of the annotation.
                    val tail = tokens.drop(3)
                    val link = tail.firstOrNull { it.startsWith("https://") || it.startsWith("http://") }
                    SourceRow(tokens[0], tokens[1], tokens[2], tail.filter { it != link }.joinToString(" "), link)
                } else {
                    null
                }
            }
            .toList()
        return SourceResult(rows)
    }

    /** Run all custom sources (name -> source) concurrently. */
    suspend fun sourcesAll(sources: Map<String, OutdatedSource>): Map<String, SourceResult> =
        withContext(blockingDispatcher) {
            coroutineScope {
                sources.map { (name, source) ->
                    async { name to sourceRows(source.command!!, source.origin) }
                }.awaitAll().toMap()
            }
        }
}

/**
 * One row from a custom outdated source; [note] is an optional annotation,
 * [link] a page about the change (a GitHub compare URL) when the source
 * printed one in the tail.
 */
data class SourceRow(val name: String, val current: String, val candidate: String, val note: String = "", val link: String? = null)

/**
 * Outcome of running one custom source: parsed [rows] on success, or an
 * [error] one-liner (exit code + last stderr line) when the command failed.
 */
data class SourceResult(val rows: List<SourceRow>, val error: String? = null)
