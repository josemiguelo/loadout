package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.UsageError
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.multiple
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.engine.ConfigEngine
import loadout.core.engine.ConfigException
import loadout.core.model.ConfigStatus

class ApplyCommand : CliktCommand(name = "apply") {
    override fun help(context: Context) = commandHelp(
        "Write the repo's configs to this machine (chezmoi apply), then refresh its state.",
        "<configs...>  config names as status lists them (default: all)",
        "--force       also replace files edited on this machine",
    )

    private val names by argument(name = "configs", help = "Config names, as status lists them").multiple()
    private val force by option("--force", help = "Replace files edited on this machine").flag()

    private val app by requireObject<AppContext>()

    override fun run() {
        val configs = app.configs ?: throw ConfigException("this repo has no configs (layout configs)")
        val manifest = app.loadManifest()
        val system = app.detectSystem()

        val units = configs.units()
        names.filterNot { name -> units.any { it.name == name } }.let { unknown ->
            if (unknown.isNotEmpty()) throw UsageError("Unknown configs: ${unknown.joinToString()} (loadout status lists them)")
        }
        val targets = if (names.isEmpty()) null else units.filter { it.name in names }.flatMap { it.targets }
        if (!force) refuseEdited(configs, targets)

        val exit = app.runner.inherit(configs.applyCommand(targets, force))
        if (exit != 0) throw ConfigException("chezmoi apply failed (exit $exit)")

        val after = spinning("updating state…") { app.refreshAndWriteState(manifest, system) }
        val applied = if (names.isEmpty()) after.configs.keys else names.toSet()
        val stillDrifted = applied.filter { after.configs[it]?.status == ConfigStatus.DRIFTED }.sorted()
        echo(" " + Style.ok("✔") + "  applied " + (if (names.isEmpty()) "every config" else names.joinToString()))
        if (stillDrifted.isNotEmpty()) {
            echo(" " + Style.warn("!") + "  still drifted: " + stillDrifted.joinToString())
            throw ProgramResult(1)
        }
    }
}

/**
 * Stops when a file apply would replace was edited on this machine:
 * chezmoi would ask, and only the user knows which version to keep.
 */
fun refuseEdited(configs: ConfigEngine, targets: Collection<String>? = null) {
    val edited = configs.edited(targets)
    if (edited.isEmpty()) return
    throw ConfigException(
        "${edited.size} config file(s) edited on this machine: ${edited.joinToString()} — " +
            "keep your edits with `chezmoi re-add`, or replace them with `loadout apply --force`",
    )
}
