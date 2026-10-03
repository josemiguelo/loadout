package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.TOOL_VERSION
import loadout.core.engine.ToolDown
import loadout.core.model.ConfigStatus
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

        val subjects = if (app.configs != null) "programs, scripts and configs" else "programs and scripts"
        val observed = spinning("checking $subjects…") {
            if (noWrite) {
                val engine = app.statusEngine(system)
                val s = engine.refresh(manifest, system, app.stateStore.read(system.machine))
                Observed(s, engine.lastScriptDetail, engine.lastToolsDown, engine.lastConfigsDown)
            } else {
                val s = app.refreshAndWriteState(manifest, system)
                Observed(s, app.lastScriptDetail, app.lastToolsDown, app.lastConfigsDown)
            }
        }
        val (state, detail, toolsDown, configsDown) = observed
        app.stateStore.lastWarnings.forEach { echo("warning: $it", err = true) }

        if (json) {
            echo(stateJson.encodeToString(MachineState.serializer(), state))
        } else {
            printTable(state, detail)
            // The per-row boxes say WHICH programs; this says what happened,
            // once, in words: the tool the checks go through wasn't there.
            for (down in toolsDown) {
                echo("")
                echo(" " + Style.warn("⚠") + "  " + Style.warn(down.message) + Style.dim("  (${down.programs.joinToString()})"))
            }
            configsDown?.let {
                echo("")
                echo(" " + Style.warn("⚠") + "  " + Style.warn("configs not checked: $it"))
            }
            // The one self-knowledge carve-out: is this binary itself behind?
            SelfVersion.behind(app.runner, app.fs)?.let { latest ->
                echo("")
                echo(" " + Style.warn("↑") + "  loadout $TOOL_VERSION — $latest available " + Style.dim("(run: loadout self-upgrade)"))
            }
            if (!noWrite) echo(Style.dim("\nState written to ${app.stateStore.pathFor(system.machine)}"))
        }
    }

    // Same visual language as the home screen: ✔/✘/· markers, color as
    // signal only (ok/warn/error/dim), dim detail lines under failing rows.
    private fun printTable(state: MachineState, detail: Map<String, String>) {
        echo(Style.dim("machine ") + Style.machine(state.machine) + Style.dim(" │ ${state.os}${state.distro?.let { "/$it" } ?: ""} │ ${state.arch}"))
        echo("")
        val nameWidth = ((state.programs.keys + state.scripts.keys + state.configs.keys).map { it.length } + 7).max()
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
        printScripts(state, detail, nameWidth)
        printConfigs(state, nameWidth)
    }

    private fun printScripts(state: MachineState, detail: Map<String, String>, nameWidth: Int) {
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

    // A drifted unit lists the files apply would change, inside its box.
    private fun printConfigs(state: MachineState, nameWidth: Int) {
        if (state.configs.isEmpty()) return
        echo("")
        echo(Style.header("  " + "CONFIG".padEnd(nameWidth + 4) + "STATUS"))
        echoRows(
            state.configs.toList().sortedBy { it.first }.map { (name, config) ->
                val (mark, status, severity) = when (config.status) {
                    ConfigStatus.APPLIED -> Triple(Style.ok("✔"), Style.ok("applied"), null)
                    ConfigStatus.DRIFTED -> Triple(Style.warn("✘"), Style.warn("drifted"), false)
                    ConfigStatus.UNKNOWN -> Triple(Style.warn("?"), Style.warn("not checked"), false)
                }
                val lines = (config.files + listOfNotNull(config.reason))
                    .map { Style.dim("".padEnd(nameWidth + 5) + it) }
                TableRow(listOf("$mark  " + name.padEnd(nameWidth + 1) + status) + lines, severity)
            },
        )
    }
}

private data class Observed(
    val state: MachineState,
    val detail: Map<String, String>,
    val toolsDown: List<ToolDown>,
    val configsDown: String?,
)
