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
import loadout.core.engine.ScriptOutcome
import loadout.core.engine.ScriptRunner
import loadout.core.manifest.ManifestLoader
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus

class RunCommand : CliktCommand(name = "run") {
    override fun help(context: Context) = commandHelp(
        "Run the named scripts from the manifest.",
        "<scripts...>  script names (must be opted in by this machine)",
        "--force       run even when the check already passes",
    )

    private val names by argument(name = "scripts", help = "Script names from the manifest")
        .multiple(required = true)
    private val force by option("--force", help = "Run even if the script's check passes").flag()

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()
        names.filterNot { it in manifest.scripts }.let { unknown ->
            if (unknown.isNotEmpty()) throw UsageError("Unknown scripts: ${unknown.joinToString()}")
        }
        val enabled = manifest.machines[system.machine]?.scriptArgs().orEmpty()
        names.filterNot { it in enabled }.let { disabled ->
            if (disabled.isNotEmpty()) {
                for (name in disabled) {
                    echo("error: script '$name' is not enabled for machine '${system.machine}' " +
                        "(add it to the scripts list in machines/${system.machine}.toml)")
                }
                throw ProgramResult(1)
            }
        }

        val runner = ScriptRunner(app.runner, app.repoRoot)
        val results = mutableMapOf<String, ScriptState>()
        for (name in ManifestLoader.scriptOrder(manifest, names)) {
            if (name !in names) continue
            val step = manifest.scripts.getValue(name)
            when (val outcome = runner.run(step, system.os, force, args = enabled.getValue(name))) {
                is ScriptOutcome.NotApplicable -> echo(" " + Style.dim("\u00b7") + "  skipped $name " + Style.dim("(not for ${system.os.id})"))
                is ScriptOutcome.AlreadyDone -> echo(" " + Style.ok("\u2714") + "  skipped $name " + Style.dim("(already done; use --force to run anyway)"))
                is ScriptOutcome.Ran -> {
                    echo(" " + (if (outcome.state.exitCode == 0) Style.ok("\u2714") else Style.error("\u2718")) + "  ran $name (exit ${outcome.state.exitCode})")
                    results[name] = outcome.state
                }
            }
        }

        if (results.isNotEmpty()) {
            kotlinx.coroutines.runBlocking { app.refreshAndWriteState(manifest, system, results) }
            echo(Style.dim("State updated."))
        }
        if (results.any { it.value.status == ScriptStatus.FAILED }) throw ProgramResult(1)
    }
}
