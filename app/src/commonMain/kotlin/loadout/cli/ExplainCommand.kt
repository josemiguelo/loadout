package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.multiple
import loadout.core.model.ProgramStatus
import loadout.core.model.ScriptStatus

class ExplainCommand : CliktCommand(name = "explain") {
    override fun help(context: Context) =
        "Explain programs or scripts — the fully expanded definition exactly as the " +
            "engine sees it, templates resolved. With no names, explains the whole manifest."

    private val names by argument(name = "names", help = "Program or script names (default: everything)")
        .multiple()

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()
        val state = app.stateStore.read(system.machine)
        val mapping = manifest.machines[system.machine]?.pm.orEmpty()

        val targets = names.ifEmpty { (manifest.programs.keys + manifest.scripts.keys).toList() }
        targets.forEachIndexed { index, name ->
            if (index > 0) echo("")
            val program = manifest.programs[name]
            val script = manifest.scripts[name]
            val rows = mutableListOf<Pair<String, String>>()
            val notes = mutableListOf<String>()
            when {
                program != null -> {
                    echo("program $name" + program.description.ifEmpty { null }?.let { "  — $it" }.orEmpty())
                    rows += "version" to (
                        program.version?.let { "${it.command}  =~ /${it.regex}/" }
                            ?: "(none — status will always be 'unknown')"
                        )
                    if (program.dependsOn.isNotEmpty()) rows += "depends-on" to program.dependsOn.joinToString()
                    if (program.tags.isNotEmpty()) rows += "tags" to program.tags.joinToString()
                    if (program.install.isEmpty()) rows += "install" to "(none — not installable anywhere)"
                    for ((key, variant) in program.install) {
                        val resolved = manifest.resolveInstall(name, key)
                        val installerName = variant.installer
                            ?: key.takeIf { it in manifest.installers && variant.installer == null }
                        val via = installerName?.let { "  [installer: $it]" }.orEmpty()
                        val marker = if (key == mapping[name]) "   <- ${system.machine}" else ""
                        rows += "install.$key" to "${resolved.command}$via$marker"
                        resolved.check?.takeIf { it != program.version }?.let {
                            rows += "check.$key" to "${it.command}  =~ /${it.regex}/"
                        }
                        resolved.probe?.let { rows += "probe.$key" to it }
                    }
                    if (name !in mapping) {
                        notes += "! not mapped for ${system.machine} (add it to machines/${system.machine}.toml)"
                    }
                    state?.programs?.get(name)?.let {
                        val status = when (it.status) {
                            ProgramStatus.INSTALLED -> "installed"
                            ProgramStatus.MISSING -> "missing"
                            ProgramStatus.UNKNOWN -> "unknown"
                        }
                        rows += "observed" to
                            "$status${it.version?.let { v -> " $v" }.orEmpty()}  (state/${system.machine}.json)"
                    }
                }
                script != null -> {
                    echo("script $name" + script.description.ifEmpty { null }?.let { "  — $it" }.orEmpty())
                    script.file?.let { rows += "file" to it }
                    script.run?.let { rows += "run" to it }
                    script.check?.let { rows += "check" to it }
                    if (script.os.isNotEmpty()) rows += "os" to script.os.joinToString()
                    if (script.after.isNotEmpty()) rows += "after" to script.after.joinToString()
                    if (script.modes != listOf("setup", "maintain")) rows += "modes" to script.modes.joinToString()
                    val enabled = manifest.machines[system.machine]?.scriptArgs()?.get(name)
                    rows += "enabled" to when {
                        enabled == null -> "no — add it to the scripts list in machines/${system.machine}.toml"
                        enabled.isEmpty() -> "yes (${system.machine})"
                        else -> "yes (${system.machine}, args: $enabled)"
                    }
                    state?.scripts?.get(name)?.let {
                        val status = when (it.status) {
                            ScriptStatus.DONE -> "done"
                            ScriptStatus.FAILED -> "failed"
                            ScriptStatus.PENDING -> "pending"
                        }
                        rows += "observed" to "$status  (state/${system.machine}.json)"
                    }
                }
                else -> {
                    echo("error: no program or script named '$name'")
                    throw ProgramResult(1)
                }
            }
            val width = rows.maxOf { it.first.length }
            for ((label, value) in rows) echo("  ${label.padEnd(width)}  $value")
            for (note in notes) echo("  $note")
        }
    }
}
