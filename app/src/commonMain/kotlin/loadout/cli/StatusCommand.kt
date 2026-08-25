package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.TOOL_VERSION
import loadout.core.engine.StatusEngine
import loadout.core.engine.VersionChecker
import loadout.core.model.MachineState
import loadout.core.model.ProgramStatus
import loadout.core.model.ScriptStatus
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
private val stateJson = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
    encodeDefaults = true
}

class StatusCommand : CliktCommand(name = "status") {
    override fun help(context: Context) = commandHelp(
        "Observe this machine: every program version and script check re-asked, drift explained, state file updated.",
        "--json      print the full state as JSON",
        "--no-write  observe without touching the state file",
    )

    private val json by option("--json", help = "Print the machine state as JSON").flag()
    private val noWrite by option("--no-write", help = "Don't update the state file").flag()

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()

        val (state, detail) = spinning("checking programs and scripts…") {
            if (noWrite) {
                val engine =
                    StatusEngine(VersionChecker(app.runner, app.repoRoot.toString()), app.runner, app.repoRoot)
                val s = engine.refresh(manifest, system, app.stateStore.read(system.machine))
                s to engine.lastScriptDetail
            } else {
                app.refreshAndWriteState(manifest, system) to app.lastScriptDetail
            }
        }
        app.stateStore.lastWarnings.forEach { echo("warning: $it", err = true) }

        if (json) {
            echo(stateJson.encodeToString(MachineState.serializer(), state))
        } else {
            printTable(state, detail)
            // The one self-knowledge carve-out: is this binary itself behind?
            SelfVersion.behind(app.runner)?.let { latest ->
                echo("")
                echo(" " + Style.warn("↑") + "  loadout $TOOL_VERSION — $latest available " + Style.dim("(run: loadout upgrade)"))
            }
            if (!noWrite) echo(Style.dim("\nState written to ${app.stateStore.pathFor(system.machine)}"))
        }
    }

    // Same visual language as the maintain screen: ✔/✘/· markers, color as
    // signal only (ok/warn/error/dim), dim detail lines under failing rows.
    private fun printTable(state: MachineState, detail: Map<String, String>) {
        echo(Style.dim("machine ") + Style.bold(state.machine) + Style.dim(" │ ${state.os}${state.distro?.let { "/$it" } ?: ""} │ ${state.arch}"))
        echo("")
        val nameWidth = ((state.programs.keys + state.scripts.keys).map { it.length } + 7).max()
        echo(Style.bold(" " + "PROGRAM".padEnd(nameWidth + 4) + "STATUS".padEnd(11) + "VERSION"))
        for ((name, program) in state.programs.toList().sortedBy { it.first }) {
            val (mark, status) = when (program.status) {
                ProgramStatus.INSTALLED -> Style.ok("✔") to Style.ok("installed".padEnd(11))
                ProgramStatus.MISSING -> Style.error("✘") to Style.error("missing".padEnd(11))
                ProgramStatus.UNKNOWN -> Style.dim("·") to Style.dim("unknown".padEnd(11))
            }
            echo(" $mark  " + name.padEnd(nameWidth + 1) + status + (program.version ?: "-"))
        }
        if (state.scripts.isEmpty()) return
        echo("")
        echo(Style.bold(" " + "SCRIPT".padEnd(nameWidth + 4) + "STATUS"))
        for ((name, script) in state.scripts.toList().sortedBy { it.first }) {
            val (mark, status) = when (script.status) {
                ScriptStatus.DONE -> Style.ok("✔") to Style.ok("done")
                ScriptStatus.PENDING -> Style.error("✘") to Style.warn("pending")
                ScriptStatus.FAILED -> Style.error("✘") to Style.error("failed")
            }
            echo(" $mark  " + name.padEnd(nameWidth + 1) + status)
            // What the failing check reported — the "missing: ..." lines.
            detail[name]?.lineSequence()?.forEach { echo(Style.dim("".padEnd(nameWidth + 6) + it)) }
        }
    }
}
