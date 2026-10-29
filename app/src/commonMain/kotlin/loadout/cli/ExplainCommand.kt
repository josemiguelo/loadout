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
import loadout.core.model.Origin
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
        // extends, what it installs and runs (its profiles' included), and
        // its merged data (what its chezmoi templates see).
        if (names.isEmpty()) {
            val machine = manifest.machines[system.machine]
            echo(Style.header("machine ") + Style.bold(system.machine))
            if (machine == null) echo("  " + Style.warn("! not declared in the repo — showing the data defaults"))
            val rows = mutableListOf<Pair<String, String>>()
            app.layout.parent?.let { rows += "parent" to "${it.name} (${it.path})" }
            if (machine != null && machine.extends.isNotEmpty()) rows += "extends" to machine.extends.joinToString()
            // What it installs, grouped by the variant each program uses.
            val byVariant = machine?.pm.orEmpty().entries.groupBy({ it.value }, { it.key })
            for (variant in byVariant.keys.sorted()) {
                val programs = byVariant.getValue(variant)
                rows += "install $variant" to programs.sorted().joinToString()
            }
            machine?.scripts?.takeIf { it.isNotEmpty() }?.let { entries ->
                rows += "run" to entries.joinToString { entry ->
                    val name = scriptEntry(entry).first
                    machine.scriptVariants[name]?.let { "$name ($it)" } ?: name
                }
            }
            rows += MachineData.lines(machine?.data ?: manifest.data).map { (key, value) -> "data.$key" to value }
            if (rows.none { it.first.startsWith("data.") }) echo("  " + Style.dim("no data declared"))
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
                    fromParent(program.origin)?.let { rows += "from" to it }
                    rows += "version" to (
                        program.version?.let(::describe)
                            ?: "(none — status will always be 'unknown')"
                        )
                    if (program.dependsOn.isNotEmpty()) rows += "depends-on" to program.dependsOn.joinToString()
                    if (program.path.isNotEmpty()) rows += "path" to program.path.joinToString(":") + "  (first on PATH for its commands)"
                    if (program.tags.isNotEmpty()) rows += "tags" to program.tags.joinToString()
                    if (program.install.isEmpty()) rows += "install" to "(none — not installable anywhere)"
                    for ((key, variant) in program.install) {
                        val resolved = manifest.resolveInstall(name, key)
                        val installerName = variant.installer
                            ?: key.takeIf { it in manifest.installers && variant.installer == null }
                        // Where the mechanics came from: loadout's library or this repo.
                        val via = installerName?.let {
                            val origin = when {
                                it in manifest.builtinInstallers -> "built-in"
                                Origin.isParent(manifest.installers[it]?.origin.orEmpty()) -> "parent ${app.layout.parent?.name}"
                                else -> "repo"
                            }
                            "  [installer: $it ($origin)]"
                        }.orEmpty()
                        val marker = if (key == mapping[name]) Style.machine("   <- ${system.machine}") else ""
                        rows += "install.$key" to "${resolved.command}$via$marker"
                        resolved.check?.takeIf { it != program.version }?.let {
                            rows += "check.$key" to describe(it)
                        }
                        resolved.probe?.let { rows += "probe.$key" to it }
                        if (resolved.sudo) rows += "sudo.$key" to "yes — a run that installs it asks for the password first"
                        if (variant.dependsOn.isNotEmpty()) rows += "depends-on.$key" to variant.dependsOn.joinToString()
                        if (variant.provides.isNotEmpty()) {
                            rows += "provides.$key" to variant.provides.joinToString { p -> p.at?.let { "${p.binary} (in $it)" } ?: p.binary }
                        }
                    }
                    if (name !in mapping) {
                        notes += "! not installed on ${system.machine} (install it in machine '${system.machine}' or a profile it extends)"
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
                    fromParent(script.origin)?.let { rows += "from" to it }
                    script.file?.let { rows += "file" to it }
                    script.run?.let { rows += "run" to it }
                    script.check?.let { rows += "check" to it }
                    if (script.variants.isNotEmpty()) rows += "variants" to script.variants.keys.joinToString()
                    if (script.after.isNotEmpty()) rows += "after" to script.after.joinToString()
                    if (script.modes != listOf("setup", "maintain")) rows += "modes" to script.modes.joinToString()
                    if (script.sudo) rows += "sudo" to "yes — a run that runs it asks for the password first"
                    val enabled = manifest.machines[system.machine]?.scriptArgs()?.get(name)
                    rows += "enabled" to when {
                        enabled == null -> "no — run it in machine '${system.machine}' or a profile it extends"
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

    /** "parent <name> (<folder>)" for a child repo's parent's declaration (contract 18), else null. */
    private fun fromParent(origin: String): String? =
        if (Origin.isParent(origin)) "parent ${app.layout.parent?.name} (${Origin.folder(origin).ifEmpty { "its root" }})" else null
}

/** A check as explain shows it: its command and what reads the version, or that it only says yes or no. */
private fun describe(check: loadout.core.model.VersionCheck): String =
    check.regex?.let { "${check.command}  =~ /$it/" } ?: "${check.command}  (yes/no)"
