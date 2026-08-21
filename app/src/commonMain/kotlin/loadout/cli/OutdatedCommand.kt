package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import loadout.core.engine.UpdateChecker
import loadout.core.model.ProgramStatus
import kotlinx.coroutines.runBlocking

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
        // installer declares an `outdated` oracle can be asked.
        val installed = mapped.filterKeys {
            state.programs[it]?.status == ProgramStatus.INSTALLED
        }
        val oracles = installed.mapNotNull { (name, key) ->
            manifest.resolveInstall(name, key).outdated?.let { name to it }
        }.toMap()
        val unchecked = installed.keys - oracles.keys

        echo("Checking ${oracles.size} programs against their remote sources...")
        val candidates = runBlocking { UpdateChecker(app.runner, app.repoRoot.toString()).candidates(oracles) }

        val updates = candidates.mapNotNull { (name, candidate) ->
            val current = state.programs.getValue(name).version
            if (candidate != null && candidate != current) Triple(name, current ?: "?", candidate) else null
        }.sortedBy { it.first }

        if (updates.isEmpty()) {
            echo("Everything is up to date.")
        } else {
            val nameWidth = updates.maxOf { it.first.length } + 2
            val currentWidth = updates.maxOf { it.second.length } + 2
            val candidateWidth = updates.maxOf { it.third.length } + 2
            echo("")
            for ((name, current, candidate) in updates) {
                echo(
                    "  ${name.padEnd(nameWidth)}${current.padEnd(currentWidth)}" +
                        "-> ${candidate.padEnd(candidateWidth)}[${mapped.getValue(name)}]",
                )
            }
            echo("")
            echo("${updates.size} update(s) available. `loadout setup` won't upgrade — use the package manager, then `loadout status`.")
        }
        if (unchecked.isNotEmpty()) {
            echo("(${unchecked.size} installed programs have no outdated oracle: ${unchecked.sorted().joinToString()})")
        }
    }
}
