package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.diff.DiffEngine
import loadout.core.diff.InstallState
import loadout.core.diff.ProgramRow

private fun flagsOf(row: ProgramRow) = buildList {
    if (row.drift) add("drift")
    if (row.incomplete) add("incomplete")
}.joinToString(",")

/** Printed width of the trailing "  !drift" annotation (0 when there is none). */
private fun flagsWidth(flags: String) = if (flags.isEmpty()) 0 else flags.length + 3

private fun Int?.orZero() = this ?: 0

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
        echo(Style.header("  " + "PROGRAM".padEnd(nameWidth + 3)) + report.machines.joinToString("") { Style.machine(it.padEnd(colWidth)) })
        // Rows needing attention are wrapped in a box: consecutive ones share
        // one, so a run reads as a single block. The left border sits in the
        // gutter column, so boxed and plain rows keep the same columns.
        val boxed = report.rows.map { it.drift || it.incomplete }
        val cellsWidth = 3 + nameWidth + colWidth * report.machines.size
        val bodyWidth = cellsWidth + report.rows.filterIndexed { i, _ -> boxed[i] }
            .maxOfOrNull { flagsWidth(flagsOf(it)) }.orZero()
        fun paint(severe: Boolean, text: String) = if (severe) Style.error(text) else Style.warn(text)
        fun edge(severe: Boolean, left: String, right: String) =
            paint(severe, left + "\u2500".repeat(bodyWidth + 2) + right)
        var runSevere = false
        for ((index, row) in report.rows.withIndex()) {
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
            val flags = flagsOf(row)
            val body = "$marker  " + row.program.padEnd(nameWidth) + cells +
                (if (flags.isEmpty()) "" else Style.warn("  !$flags"))
            if (!boxed[index]) {
                echo("  $body")
                continue
            }
            if (index == 0 || !boxed[index - 1]) {
                runSevere = (index..report.rows.lastIndex)
                    .takeWhile { boxed[it] }
                    .any { report.rows[it].incomplete }
                echo(edge(runSevere, "\u256d", "\u256e"))  // rounded top
            }
            val pad = " ".repeat((bodyWidth - cellsWidth - flagsWidth(flags)).coerceAtLeast(0))
            echo(paint(runSevere, "\u2502") + " " + body + pad + " " + paint(runSevere, "\u2502"))
            if (index == report.rows.lastIndex || !boxed[index + 1]) echo(edge(runSevere, "\u2570", "\u256f"))
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
