package io.github.josemiguelo.postinstaller.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.UsageError
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.multiple
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import io.github.josemiguelo.postinstaller.core.engine.ScriptOutcome
import io.github.josemiguelo.postinstaller.core.engine.ScriptRunner
import io.github.josemiguelo.postinstaller.core.manifest.ManifestLoader
import io.github.josemiguelo.postinstaller.core.model.ScriptState
import io.github.josemiguelo.postinstaller.core.model.ScriptStatus

class RunCommand : CliktCommand(name = "run") {
    override fun help(context: Context) = "Run the named setup scripts from the manifest"

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

        val runner = ScriptRunner(app.runner, app.repoRoot)
        val results = mutableMapOf<String, ScriptState>()
        for (name in ManifestLoader.scriptOrder(manifest, names)) {
            if (name !in names) continue
            val step = manifest.scripts.getValue(name)
            when (val outcome = runner.run(step, system.os, force)) {
                is ScriptOutcome.NotApplicable -> echo("skipped $name: not for ${system.os.id}")
                is ScriptOutcome.AlreadyDone -> echo("skipped $name: already done (check passed; use --force to run anyway)")
                is ScriptOutcome.Ran -> {
                    echo("ran $name (exit ${outcome.state.exitCode})")
                    results[name] = outcome.state
                }
            }
        }

        if (results.isNotEmpty()) {
            app.refreshAndWriteState(manifest, system, results)
            echo("State updated.")
        }
        if (results.any { it.value.status == ScriptStatus.FAILED }) throw ProgramResult(1)
    }
}
