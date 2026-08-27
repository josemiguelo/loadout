package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.diff.DiffEngine
import loadout.core.diff.InstallState

class DiffCommand : CliktCommand(name = "diff") {
    override fun help(context: Context) = commandHelp(
        "Compare all machines' state files: missing installs and version drift. Exits 1 when something is off.",
        "--machines a,b  narrow the comparison to those machines",
    )

    private val machines by option(
        "--machines",
        help = "Comma-separated machine names to compare (default: all with a state file)",
    )

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val filter = machines?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }
        val states = app.stateStore.readAll()
            .filterKeys { filter == null || it in filter }
            .values
        app.stateStore.lastWarnings.forEach { echo("warning: $it", err = true) }

        if (states.isEmpty()) {
            echo("No machine state files found in ${app.repoRoot / "state"}. Run `status` or `sync` on your machines first.")
            throw ProgramResult(1)
        }

        val report = DiffEngine.diff(manifest, states)

        val nameWidth = (report.rows.map { it.program.length } + 7).max() + 2
        val colWidth = (report.machines.map { it.length } + 8).max() + 2
        echo(Style.header(" " + "PROGRAM".padEnd(nameWidth + 3)) + report.machines.joinToString("") { Style.machine(it.padEnd(colWidth)) })
        for (row in report.rows) {
            // Same marker language as status: ok / drift / missing-somewhere;
            // a program no compared machine has is a dim non-event.
            val everywhereUnknown = row.perMachine.values.all { it == InstallState.Unknown }
            val marker = when {
                row.incomplete -> Style.error("\u2718")
                row.drift -> Style.warn("!")
                everywhereUnknown -> Style.dim("\u00b7")
                else -> Style.ok("\u2714")
            }
            val cells = report.machines.joinToString("") { machine ->
                when (val cell = row.perMachine.getValue(machine)) {
                    // On a drifting row every version is a suspect — highlight them all.
                    is InstallState.Installed -> (cell.version ?: "ok").padEnd(colWidth)
                        .let { if (row.drift) Style.warn(it) else it }
                    InstallState.Missing -> Style.error("missing".padEnd(colWidth))
                    InstallState.Unknown -> Style.dim("-".padEnd(colWidth))
                }
            }
            val flags = buildList {
                if (row.drift) add("drift")
                if (row.incomplete) add("incomplete")
            }.joinToString(",")
            echo(" $marker  " + row.program.padEnd(nameWidth) + cells + (if (flags.isEmpty()) "" else Style.warn("  !$flags")))
        }

        val driftCount = report.rows.count { it.drift }
        val missingCount = report.rows.count { it.incomplete }
        if (driftCount > 0 || missingCount > 0) {
            echo("")
            echo(" " + Style.warn("!") + "  $driftCount program(s) with version drift, $missingCount with missing installs.")
            throw ProgramResult(1)
        }
        echo("")
        echo(" " + Style.ok("\u2714") + "  all ${report.machines.size} machine(s) in sync")
    }
}
