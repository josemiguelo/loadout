package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.multiple
import loadout.core.manifest.MachineData
import loadout.core.model.ConfigStatus
import loadout.core.model.scriptEntry
import loadout.core.model.ProgramStatus
import loadout.core.model.ScriptStatus

class ExplainCommand : CliktCommand(name = "explain") {
    override fun help(context: Context) = commandHelp(
        "Explain programs, scripts or configs: the fully expanded definition exactly as the engine sees it.",
        "[names...]  programs, scripts or configs (default: every program and script)",
    )

    private val names by argument(name = "names", help = "Program, script or config names (default: every program and script)")
        .multiple()

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()
        val state = app.stateStore.read(system.machine)
        val mapping = manifest.machines[system.machine]?.pm.orEmpty()

        // Everything explained starts with the machine: the profiles it
        // extends, its own groups, and its merged [data] (what its chezmoi
        // templates see).
        if (names.isEmpty()) {
            val machine = manifest.machines[system.machine]
            echo(Style.header("machine ") + Style.bold(system.machine) + Style.dim("  ${app.layout.machines}/${system.machine}.toml"))
            if (machine == null) echo("  " + Style.warn("! no machine file — showing loadout.toml's [data] defaults"))
            val rows = mutableListOf<Pair<String, String>>()
            if (machine != null && machine.extends.isNotEmpty()) rows += "extends" to machine.extends.joinToString()
            for ((group, contents) in machine?.groups.orEmpty()) {
                val parts = listOfNotNull(
                    contents.install.entries.joinToString { (program, key) -> "$program = $key" }.ifEmpty { null },
                    contents.scripts.joinToString { scriptEntry(it).first }.ifEmpty { null }?.let { "scripts $it" },
                )
                rows += "[$group]" to parts.joinToString(" · ").ifEmpty { "data only" }
            }
            rows += MachineData.lines(machine?.data ?: manifest.data).map { (key, value) -> "data.$key" to value }
            if (rows.none { it.first.startsWith("data.") }) echo("  " + Style.dim("no [data] declared in loadout.toml"))
            val width = rows.maxOfOrNull { it.first.length } ?: 0
            for ((label, value) in rows) echo("  " + Style.dim(label.padEnd(width)) + "  $value")
            echo("")
        }

        val targets = names.ifEmpty { (manifest.programs.keys + manifest.scripts.keys).toList() }
        // Configs are asked about only for names given: the default list is
        // programs and scripts, and needs no chezmoi.
        val asked = if (names.isEmpty()) Result.success(emptyList()) else runCatching { app.configs?.units().orEmpty() }
        val units = asked.getOrDefault(emptyList())
        targets.forEachIndexed { index, name ->
            if (index > 0) echo("")
            val program = manifest.programs[name]
            val script = manifest.scripts[name]
            if (program == null && script == null && units.none { it.name == name }) {
                val kinds = if (app.configs != null) "program, script or config" else "program or script"
                val why = asked.exceptionOrNull()?.let { " (configs not checked: ${it.message})" }.orEmpty()
                echo("error: no $kinds named '$name'$why")
                throw ProgramResult(1)
            }
            val rows = mutableListOf<Pair<String, String>>()
            val notes = mutableListOf<String>()
            when {
                program != null -> {
                    echo(Style.header("program ") + Style.bold(name) + program.description.ifEmpty { null }?.let { Style.dim("  — $it") }.orEmpty())
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
                        // Where the mechanics came from: loadout's library or this repo.
                        val via = installerName?.let {
                            val origin = if (it in manifest.builtinInstallers) "built-in" else "repo"
                            "  [installer: $it ($origin)]"
                        }.orEmpty()
                        val marker = if (key == mapping[name]) Style.machine("   <- ${system.machine}") else ""
                        rows += "install.$key" to "${resolved.command}$via$marker"
                        resolved.check?.takeIf { it != program.version }?.let {
                            rows += "check.$key" to "${it.command}  =~ /${it.regex}/"
                        }
                        resolved.probe?.let { rows += "probe.$key" to it }
                        if (variant.dependsOn.isNotEmpty()) rows += "depends-on.$key" to variant.dependsOn.joinToString()
                    }
                    if (name !in mapping) {
                        notes += "! not mapped for ${system.machine} (add it to ${app.layout.machines}/${system.machine}.toml)"
                    }
                    state?.programs?.get(name)?.let {
                        val status = when (it.status) {
                            ProgramStatus.INSTALLED -> "installed"
                            ProgramStatus.MISSING -> "missing"
                            ProgramStatus.UNKNOWN -> "unknown"
                        }
                        rows += "observed" to
                            "$status${it.version?.let { v -> " $v" }.orEmpty()}  (${app.layout.state}/${system.machine}.json)"
                    }
                }
                script != null -> {
                    echo(Style.header("script ") + Style.bold(name) + script.description.ifEmpty { null }?.let { Style.dim("  — $it") }.orEmpty())
                    script.file?.let { rows += "file" to it }
                    script.run?.let { rows += "run" to it }
                    script.check?.let { rows += "check" to it }
                    if (script.os.isNotEmpty()) rows += "os" to script.os.joinToString()
                    if (script.after.isNotEmpty()) rows += "after" to script.after.joinToString()
                    if (script.modes != listOf("setup", "maintain")) rows += "modes" to script.modes.joinToString()
                    val enabled = manifest.machines[system.machine]?.scriptArgs()?.get(name)
                    rows += "enabled" to when {
                        enabled == null -> "no — add it to a group's scripts in ${app.layout.machines}/${system.machine}.toml"
                        enabled.isEmpty() -> "yes (${system.machine})"
                        else -> "yes (${system.machine}, args: $enabled)"
                    }
                    state?.scripts?.get(name)?.let {
                        val status = when (it.status) {
                            ScriptStatus.DONE -> "done"
                            ScriptStatus.FAILED -> "failed"
                            ScriptStatus.PENDING -> "pending"
                        }
                        rows += "observed" to "$status  (${app.layout.state}/${system.machine}.json)"
                    }
                }
            }
            if (rows.isNotEmpty()) {
                val width = rows.maxOf { it.first.length }
                for ((label, value) in rows) echo("  " + Style.dim(label.padEnd(width)) + "  $value")
                for (note in notes) echo("  " + Style.warn(note))
            }
            // A config often shares its tool's name (tmux the program, tmux
            // the config): both are shown.
            units.firstOrNull { it.name == name }?.let { unit ->
                if (rows.isNotEmpty()) echo("")
                echo(Style.header("config ") + Style.bold(name) + Style.dim("  ${app.layout.configs}/"))
                val configRows = unit.targets.mapIndexed { i, target -> (if (i == 0) "targets" else "") to target }.toMutableList()
                state?.configs?.get(name)?.let {
                    val status = when (it.status) {
                        ConfigStatus.APPLIED -> "applied"
                        ConfigStatus.DRIFTED -> "drifted: ${it.files.joinToString()}"
                        ConfigStatus.UNKNOWN -> "unknown"
                    }
                    configRows += "observed" to "$status  (${app.layout.state}/${system.machine}.json)"
                }
                val width = configRows.maxOf { it.first.length }
                for ((label, value) in configRows) echo("  " + Style.dim(label.padEnd(width)) + "  $value")
            }
        }
    }
}
