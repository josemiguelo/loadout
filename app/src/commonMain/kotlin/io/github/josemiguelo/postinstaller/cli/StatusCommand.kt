package io.github.josemiguelo.postinstaller.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import io.github.josemiguelo.postinstaller.core.engine.StatusEngine
import io.github.josemiguelo.postinstaller.core.engine.VersionChecker
import io.github.josemiguelo.postinstaller.core.model.MachineState
import io.github.josemiguelo.postinstaller.core.model.ProgramStatus
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json

class StatusCommand : CliktCommand(name = "status") {
    override fun help(context: Context) =
        "Check installed versions of every manifest program and update this machine's state file"

    private val json by option("--json", help = "Print the machine state as JSON").flag()
    private val noWrite by option("--no-write", help = "Don't update the state file").flag()

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()
        val engine = StatusEngine(VersionChecker(app.runner))

        val state = runBlocking {
            engine.refresh(manifest, system, app.stateStore.read(system.machine))
        }
        if (!noWrite) app.stateStore.write(state)

        if (json) {
            echo(Json.encodeToString(MachineState.serializer(), state))
        } else {
            printTable(state)
            if (!noWrite) echo("\nState written to ${app.stateStore.pathFor(system.machine)}")
        }
    }

    private fun printTable(state: MachineState) {
        echo("Machine: ${state.machine} (${state.os}${state.distro?.let { "/$it" } ?: ""}, ${state.arch}, pm=${state.packageManager ?: "none"})")
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
