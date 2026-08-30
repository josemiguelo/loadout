package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import loadout.core.TOOL_VERSION
import loadout.core.engine.UpdateChecker
import loadout.core.model.ProgramStatus
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

private data class UpdateRow(val name: String, val current: String, val candidate: String, val source: String, val note: String = "")

class OutdatedCommand : CliktCommand(name = "outdated") {
    override fun help(context: Context) = commandHelp(
        "Ask each program's remote source (dnf/brew/flathub/...) for newer versions — the loadout binary included.",
    )

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()
        val mapped = manifest.machines[system.machine]?.pm.orEmpty()
        val state = app.stateStore.read(system.machine)
        if (state == null) {
            echo("error: no state for ${system.machine} yet — run `loadout status` first")
            throw ProgramResult(1)
        }

        // Only installed programs can be outdated; only variants whose
        // installer declares an oracle can be asked. An installer's batch
        // oracle (`outdated-all`) covers its programs with ONE command;
        // per-program oracles remain for explicit variant overrides.
        val installed = mapped.filterKeys {
            state.programs[it]?.status == ProgramStatus.INSTALLED
        }
        val resolved = installed.mapValues { (name, key) -> manifest.resolveInstall(name, key) }
        val oracles = resolved.mapNotNull { (name, r) -> r.outdated?.let { name to it } }.toMap()
        val batched = resolved.mapNotNull { (name, r) -> r.outdatedAll?.let { name to it } }.toMap()
        val batchCommands = batched.values.associate { it.installer to it.command }
        val unchecked = installed.keys - oracles.keys - batched.keys

        val checker = UpdateChecker(app.runner, app.repoRoot.toString())
        val sources = manifest.outdated.mapValues { (_, s) -> s.command!! }
        val extra = if (sources.isEmpty()) "" else " and ${sources.size} extra source(s)"
        val (perProgram, batchResults, sourceResults) = spinning(
            "asking the remotes about ${oracles.size + batched.size} programs$extra…",
        ) {
            coroutineScope {
                val batch = async { checker.batchAll(batchCommands) }
                val per = async { checker.candidates(oracles) }
                val custom = async { checker.sourcesAll(sources) }
                Triple(per.await(), batch.await(), custom.await())
            }
        }
        val candidates = perProgram + batched.mapValues { (_, oracle) ->
            batchResults[oracle.installer]?.get(oracle.pkg)?.let { raw ->
                Regex(oracle.regex).find(raw)?.groupValues?.getOrNull(1)
            }
        }

        // The tool itself is a program too: ask GitHub for the latest release
        // (uncached — outdated is the explicit ask-the-network command).
        val selfRow = SelfVersion.behind(app.runner, cached = false)
            ?.let { latest -> UpdateRow("loadout", TOOL_VERSION, latest, "release") }

        val sourceRows = sourceResults.flatMap { (label, res) ->
            res.rows.map { UpdateRow(it.name, it.current, it.candidate, label, it.note) }
        }
        // Custom sources that failed (non-zero exit): surfaced loud so a broken
        // oracle can never masquerade as "nothing outdated". Declaration order.
        val sourceErrors = manifest.outdated.keys.mapNotNull { label ->
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

        // Order: program rows grouped by installer DECLARATION order (list
        // native pms first in your installers fragment), then the self row,
        // then custom oracles in their declaration order. No pm knowledge
        // here — the repo's own ordering is the ordering.
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

        val updates = (listOfNotNull(selfRow) + sourceRows + programRows)
            .sortedWith(compareBy({ rank(it).first }, { rank(it).second }, { it.name }))

        // Same visual language as status: markers + color as signal only.
        if (updates.isEmpty() && sourceErrors.isEmpty()) {
            echo(" " + Style.ok("✔") + "  everything is up to date")
        } else if (updates.isNotEmpty()) {
            val nameWidth = updates.maxOf { it.name.length } + 2
            val currentWidth = updates.maxOf { it.current.length } + 2
            val candidateWidth = updates.maxOf { it.candidate.length } + 2
            echo(Style.header(" " + "PROGRAM".padEnd(nameWidth + 3) + "CURRENT".padEnd(currentWidth + 3) + "CANDIDATE".padEnd(candidateWidth) + "SOURCE"))
            val sourceWidth = updates.maxOf { it.source.length } + 2
            for ((name, current, candidate, source, note) in updates) {
                val annotation = if (note.isEmpty()) "" else Style.dim("  $note")
                echo(
                    " ${Style.warn("\u2191")}  ${name.padEnd(nameWidth)}${current.padEnd(currentWidth)}" +
                        "${Style.dim("-> ")}${Style.warn(candidate.padEnd(candidateWidth))}${Style.dim("[$source]".padEnd(sourceWidth))}$annotation",
                )
            }
            echo("")
            echo(
                " " + Style.warn("↑") + "  ${updates.size} update(s) available" +
                    Style.dim(" — `loadout setup-new-machine` won't upgrade; use the package manager, then `loadout status`"),
            )
        }
        for ((label, err) in sourceErrors) {
            echo(
                " " + Style.error("✖") + "  outdated source [$label] failed: $err" +
                    Style.dim(" — its results are missing this run"),
            )
        }
        if (unchecked.isNotEmpty()) {
            echo(Style.dim(" ·  ${unchecked.size} installed programs have no outdated oracle: ${unchecked.sorted().joinToString()}"))
        }
    }
}
