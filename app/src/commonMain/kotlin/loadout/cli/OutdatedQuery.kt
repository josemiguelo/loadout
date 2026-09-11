package loadout.cli

import loadout.core.TOOL_VERSION
import loadout.core.engine.UpdateChecker
import loadout.core.model.MachineState
import loadout.core.model.Manifest
import loadout.core.model.ProgramStatus
import loadout.core.model.SystemInfo
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/** One "something newer exists" row, shared by `outdated` and the home screen. */
data class UpdateRow(
    val name: String,
    val current: String,
    val candidate: String,
    val source: String,
    val note: String = "",
)

/** Everything one round of asking the remotes produced. */
internal data class OutdatedReport(
    val updates: List<UpdateRow>,
    /** Custom sources that exited non-zero: label to reason. */
    val errors: List<Pair<String, String>>,
    /** Installed programs no oracle can answer for. */
    val unchecked: Set<String>,
)

/**
 * Ask every remote this machine's loadout resolves to. Shared by the
 * `outdated` command and the home screen, so neither owns this logic twice —
 * the home screen in particular must stay a dispatcher.
 *
 * [freshSelfCheck] hits GitHub for loadout's own release instead of the 6h
 * cache: true for the explicit command, false for the screen that opens on
 * every invocation.
 */
internal suspend fun outdatedReport(
    app: AppContext,
    manifest: Manifest,
    system: SystemInfo,
    state: MachineState,
    freshSelfCheck: Boolean,
): OutdatedReport {
    val mapped = manifest.machines[system.machine]?.pm.orEmpty()

    // Only installed programs can be outdated; only variants whose installer
    // declares an oracle can be asked. An installer's batch oracle
    // (`outdated-all`) covers its programs with ONE command; per-program
    // oracles remain for explicit variant overrides.
    val installed = mapped.filterKeys { state.programs[it]?.status == ProgramStatus.INSTALLED }
    val resolved = installed.mapValues { (name, key) -> manifest.resolveInstall(name, key) }
    val oracles = resolved.mapNotNull { (name, r) -> r.outdated?.let { name to it } }.toMap()
    val batched = resolved.mapNotNull { (name, r) -> r.outdatedAll?.let { name to it } }.toMap()
    val batchCommands = batched.values.associate { it.installer to it.command }
    val unchecked = installed.keys - oracles.keys - batched.keys

    val checker = UpdateChecker(app.runner, app.repoRoot.toString())
    val sources = manifest.outdated.mapValues { (_, s) -> s.command!! }
    val (perProgram, batchResults, sourceResults) = coroutineScope {
        val batch = async { checker.batchAll(batchCommands) }
        val per = async { checker.candidates(oracles) }
        val custom = async { checker.sourcesAll(sources) }
        Triple(per.await(), batch.await(), custom.await())
    }
    val candidates = perProgram + batched.mapValues { (_, oracle) ->
        batchResults[oracle.installer]?.get(oracle.pkg)?.let { raw ->
            Regex(oracle.regex).find(raw)?.groupValues?.getOrNull(1)
        }
    }

    // The tool itself is a program too.
    val selfRow = SelfVersion.behind(app.runner, app.fs, cached = !freshSelfCheck)
        ?.let { latest -> UpdateRow("loadout", TOOL_VERSION, latest, "release") }

    val sourceRows = sourceResults.flatMap { (label, res) ->
        res.rows.map { UpdateRow(it.name, it.current, it.candidate, label, it.note) }
    }
    // Custom sources that failed (non-zero exit): surfaced loud so a broken
    // oracle can never masquerade as "nothing outdated". Declaration order.
    val errors = manifest.outdated.keys.mapNotNull { label ->
        sourceResults[label]?.error?.let { label to it }
    }
    val programRows = candidates.mapNotNull { (name, candidate) ->
        val current = state.programs.getValue(name).version
        if (candidate != null && candidate != current) {
            UpdateRow(name, current ?: "?", candidate, mapped.getValue(name))
        } else {
            null
        }
    }

    // Order: program rows grouped by installer DECLARATION order (list native
    // pms first in your installers fragment), then the self row, then custom
    // oracles in their declaration order. No pm knowledge here — the repo's
    // own ordering is the ordering.
    val installerOrder = manifest.installers.keys.withIndex().associate { (i, k) -> k to i }
    val oracleOrder = manifest.outdated.keys.withIndex().associate { (i, k) -> k to i }
    fun installerOf(program: String): String? {
        val key = mapped.getValue(program)
        val variant = manifest.programs[program]?.install?.get(key)
        return variant?.installer ?: key.takeIf { it in manifest.installers }
    }
    fun rank(row: UpdateRow): Pair<Int, Int> = when {
        row.source == "release" -> 1 to 0
        row.source in oracleOrder -> 2 to oracleOrder.getValue(row.source)
        else -> 0 to (installerOf(row.name)?.let { installerOrder[it] } ?: Int.MAX_VALUE)
    }

    return OutdatedReport(
        updates = (listOfNotNull(selfRow) + sourceRows + programRows)
            .sortedWith(compareBy({ rank(it).first }, { rank(it).second }, { it.name })),
        errors = errors,
        unchecked = unchecked,
    )
}
