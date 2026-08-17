package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.engine.StatusEngine
import loadout.core.engine.VersionChecker
import loadout.core.model.MachineState
import loadout.core.model.ProgramStatus
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
private val stateJson = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
    encodeDefaults = true
}

class StatusCommand : CliktCommand(name = "status") {
    override fun help(context: Context) =
        "Check installed versions of every manifest program and update this machine's state file"

    private val json by option("--json", help = "Print the machine state as JSON").flag()
    private val noWrite by option("--no-write", help = "Don't update the state file").flag()

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()

        val state = runBlocking {
            if (noWrite) {
                StatusEngine(VersionChecker(app.runner, app.repoRoot.toString()), app.runner, app.repoRoot)
                    .refresh(manifest, system, app.stateStore.read(system.machine))
            } else {
                app.refreshAndWriteState(manifest, system)
            }
        }

        if (json) {
            echo(stateJson.encodeToString(MachineState.serializer(), state))
        } else {
            printTable(state)
            if (!noWrite) echo("\nState written to ${app.stateStore.pathFor(system.machine)}")
        }
    }

    private fun printTable(state: MachineState) {
        echo("Machine: ${state.machine} (${state.os}${state.distro?.let { "/$it" } ?: ""}, ${state.arch})")
        echo("")
        val nameWidth = (state.programs.keys.map { it.length } + 7).max()
        echo("PROGRAM".padEnd(nameWidth + 2) + "STATUS".padEnd(11) + "VERSION")
        for ((name, program) in state.programs.toList().sortedBy { it.first }) {
            val status = when (program.status) {
                ProgramStatus.INSTALLED -> "installed"
                ProgramStatus.MISSING -> "missing"
                ProgramStatus.UNKNOWN -> "unknown"
            }
            echo(name.padEnd(nameWidth + 2) + status.padEnd(11) + (program.version ?: "-"))
        }
    }
}
