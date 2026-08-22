package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import loadout.core.engine.UpdateChecker
import loadout.core.model.ProgramStatus
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

class OutdatedCommand : CliktCommand(name = "outdated") {
    override fun help(context: Context) =
        "Ask each program's remote source (dnf/brew/flatpak/...) whether a newer version exists"

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
        val (perProgram, batchResults) = spinning(
            "asking the remotes about ${oracles.size + batched.size} programs…",
        ) {
            coroutineScope {
                val batch = async { checker.batchAll(batchCommands) }
                val per = async { checker.candidates(oracles) }
                per.await() to batch.await()
            }
        }
        val candidates = perProgram + batched.mapValues { (_, oracle) ->
            batchResults[oracle.installer]?.get(oracle.pkg)?.let { raw ->
                Regex(oracle.regex).find(raw)?.groupValues?.getOrNull(1)
            }
        }

        val updates = candidates.mapNotNull { (name, candidate) ->
            val current = state.programs.getValue(name).version
            if (candidate != null && candidate != current) Triple(name, current ?: "?", candidate) else null
        }.sortedBy { it.first }

        // Same visual language as status: markers + color as signal only.
        if (updates.isEmpty()) {
            echo(" " + Style.ok("✔") + "  everything is up to date")
        } else {
            val nameWidth = updates.maxOf { it.first.length } + 2
            val currentWidth = updates.maxOf { it.second.length } + 2
            val candidateWidth = updates.maxOf { it.third.length } + 2
            echo(Style.bold(" " + "PROGRAM".padEnd(nameWidth + 3) + "CURRENT".padEnd(currentWidth + 3) + "CANDIDATE".padEnd(candidateWidth) + "SOURCE"))
            for ((name, current, candidate) in updates) {
                echo(
                    " ${Style.warn("↑")}  ${name.padEnd(nameWidth)}${Style.dim(current.padEnd(currentWidth))}" +
                        "${Style.dim("-> ")}${Style.warn(candidate.padEnd(candidateWidth))}${Style.dim("[${mapped.getValue(name)}]")}",
                )
            }
            echo("")
            echo(
                " " + Style.warn("↑") + "  ${updates.size} update(s) available" +
                    Style.dim(" — `loadout setup-new-machine` won't upgrade; use the package manager, then `loadout status`"),
            )
        }
        if (unchecked.isNotEmpty()) {
            echo(Style.dim(" ·  ${unchecked.size} installed programs have no outdated oracle: ${unchecked.sorted().joinToString()}"))
        }
    }
}
