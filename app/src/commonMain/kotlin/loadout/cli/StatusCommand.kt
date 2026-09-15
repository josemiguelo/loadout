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
            SelfVersion.behind(app.runner, app.fs)?.let { latest ->
                echo("")
                echo(" " + Style.warn("↑") + "  loadout $TOOL_VERSION — $latest available " + Style.dim("(run: loadout upgrade)"))
            }
            if (!noWrite) echo(Style.dim("\nState written to ${app.stateStore.pathFor(system.machine)}"))
        }
    }

    // Same visual language as the home screen: ✔/✘/· markers, color as
    // signal only (ok/warn/error/dim), dim detail lines under failing rows.
    private fun printTable(state: MachineState, detail: Map<String, String>) {
        echo(Style.dim("machine ") + Style.machine(state.machine) + Style.dim(" │ ${state.os}${state.distro?.let { "/$it" } ?: ""} │ ${state.arch}"))
        echo("")
        val nameWidth = ((state.programs.keys + state.scripts.keys).map { it.length } + 7).max()
        echo(Style.header("  " + "PROGRAM".padEnd(nameWidth + 4) + "STATUS".padEnd(13) + "VERSION"))
        // Rows that aren't settled get boxed by echoRows, same as diff's
        // drift rows: a missing install is severe, a pending script is not.
        echoRows(
            state.programs.toList().sortedBy { it.first }.map { (name, program) ->
                // An unknown WITH a reason is a check that couldn't run
                // (brew off PATH): unsettled, boxed amber, the reason inside
                // the box — never a quiet "-" that reads as nothing wrong.
                val (mark, status, severity) = when (program.status) {
                    ProgramStatus.INSTALLED ->
                        Triple(Style.ok("\u2714"), Style.ok("installed".padEnd(13)), null)
                    ProgramStatus.MISSING ->
                        Triple(Style.error("\u2718"), Style.error("missing".padEnd(13)), true)
                    ProgramStatus.UNKNOWN -> if (program.reason == null) {
                        Triple(Style.dim("\u00b7"), Style.dim("unknown".padEnd(13)), null)
                    } else {
                        Triple(Style.warn("?"), Style.warn("not checked".padEnd(13)), false)
                    }
                }
                TableRow(
                    listOf("$mark  " + name.padEnd(nameWidth + 1) + status + (program.version ?: "-")) +
                        listOfNotNull(program.reason?.let { Style.dim("     $it") }),
                    severity,
                )
            },
        )
        if (state.scripts.isEmpty()) return
        echo("")
        echo(Style.header("  " + "SCRIPT".padEnd(nameWidth + 4) + "STATUS"))
        echoRows(
            state.scripts.toList().sortedBy { it.first }.map { (name, script) ->
                val (mark, status, severity) = when (script.status) {
                    ScriptStatus.DONE -> Triple(Style.ok("\u2714"), Style.ok("done"), null)
                    ScriptStatus.PENDING -> Triple(Style.warn("\u2718"), Style.warn("pending"), false)
                    ScriptStatus.FAILED -> Triple(Style.error("\u2718"), Style.error("failed"), true)
                }
                // What the failing check reported — the "missing: ..." lines,
                // inside the box with the row they explain.
                val detailLines = detail[name]?.lineSequence()
                    ?.map { Style.dim("".padEnd(nameWidth + 5) + it) }
                    ?.toList()
                    .orEmpty()
                TableRow(listOf("$mark  " + name.padEnd(nameWidth + 1) + status) + detailLines, severity)
            },
        )
    }
}
