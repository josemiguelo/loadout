package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.UsageError
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.multiple
import loadout.core.engine.ScriptRunner
import loadout.core.manifest.ManifestLoader

class CheckCommand : CliktCommand(name = "check") {
    override fun help(context: Context) =
        "Run this machine's script checks and show WHAT each failing one reported " +
            "(status only says pending; this shows the missing items). Read-only — " +
            "`loadout maintain` runs the scripts themselves."

    private val names by argument(name = "names", help = "Scripts to check (default: all opted-in)")
        .multiple()

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()
        val enabled = manifest.machines[system.machine]?.scriptArgs().orEmpty()
        names.filterNot { it in manifest.scripts }.let { unknown ->
            if (unknown.isNotEmpty()) throw UsageError("Unknown scripts: ${unknown.joinToString()}")
        }

        val targets = ManifestLoader.scriptOrder(manifest, names.ifEmpty { enabled.keys })
            .filter { name ->
                name in enabled &&
                    manifest.scripts.getValue(name).appliesTo(system.os) &&
                    manifest.scripts.getValue(name).check != null
            }
        if (targets.isEmpty()) {
            echo("No opted-in scripts with checks${if (names.isNotEmpty()) " match" else ""}.")
            return
        }

        val nameWidth = targets.maxOf { it.length } + 2
        var pending = 0
        for (name in targets) {
            val step = manifest.scripts.getValue(name)
            val command = ScriptRunner.withArgs(step.check!!, enabled.getValue(name))
            val result = app.runner.capture(command, workDir = app.repoRoot.toString())
            if (result.success) {
                echo("  ${name.padEnd(nameWidth)}done")
            } else {
                pending++
                echo("  ${name.padEnd(nameWidth)}pending")
                (result.stdout + result.stderr).lineSequence()
                    .filter { it.isNotBlank() }
                    .forEach { echo("  ${"".padEnd(nameWidth)}  $it") }
            }
        }
        if (pending > 0) {
            echo("")
            echo("$pending pending — converge with: loadout maintain  (or loadout run <name>)")
            throw ProgramResult(1)
        }
    }
}
