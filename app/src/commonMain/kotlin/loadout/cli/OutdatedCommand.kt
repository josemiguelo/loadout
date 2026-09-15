package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import loadout.core.platform.terminalColumns

class OutdatedCommand : CliktCommand(name = "outdated") {
    override fun help(context: Context) = commandHelp(
        "Ask each program's remote source (dnf/brew/flathub/...) for newer versions — the loadout binary included.",
    )

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()
        val state = app.stateStore.read(system.machine)
        if (state == null) {
            echo("error: no state for ${system.machine} yet — run `loadout status` first")
            throw ProgramResult(1)
        }

        val sources = manifest.outdated.size
        val extra = if (sources == 0) "" else " and $sources extra source(s)"
        val report = spinning("asking the remotes$extra…") {
            outdatedReport(app, manifest, system, state, freshSelfCheck = true)
        }
        val updates = report.updates

        // The doctor's line per tool first: what upgrading it would mean,
        // declared or not — the program rows below are the part loadout
        // knows by name.
        if (report.tools.isNotEmpty()) {
            val toolWidth = report.tools.maxOf { it.tool.length } + 2
            for (t in report.tools) {
                val total = t.total ?: 0
                val mark = if (total == 0) Style.ok("✔") else Style.warn("↑")
                val updates = if (total == 1) "1 update" else "$total updates"
                val what = when {
                    total == 0 -> Style.dim("up to date")
                    t.declared.isEmpty() -> updates + Style.dim(" · none in your loadout")
                    else -> updates + Style.dim(" · ${t.declared.size} in your loadout")
                }
                val how = t.command?.let { Style.dim("  loadout upgrade ${t.installers.first()}  →  $it") } ?: ""
                echo(" $mark  ${t.tool.padEnd(toolWidth)}$what$how")
            }
            echo("")
        }

        // Same visual language as status: markers + color as signal only.
        if (updates.isEmpty() && report.errors.isEmpty()) {
            echo(" " + Style.ok("✔") + "  everything is up to date")
        } else if (updates.isNotEmpty()) {
            val nameWidth = updates.maxOf { it.name.length } + 2
            val currentWidth = updates.maxOf { it.current.length } + 2
            val candidateWidth = updates.maxOf { it.candidate.length } + 2
            echo(Style.header(" " + "PROGRAM".padEnd(nameWidth + 3) + "CURRENT".padEnd(currentWidth + 3) + "CANDIDATE".padEnd(candidateWidth) + "SOURCE"))
            val sourceWidth = updates.maxOf { it.source.length } + 2
            for ((name, current, candidate, source, note) in updates) {
                val annotation = if (note.isEmpty()) "" else Style.dim("  $note")
                echo(
                    " ${Style.warn("\u2191")}  ${name.padEnd(nameWidth)}${current.padEnd(currentWidth)}" +
                        "${Style.dim("-> ")}${Style.warn(candidate.padEnd(candidateWidth))}${Style.dim("[$source]".padEnd(sourceWidth))}$annotation",
                )
            }
            echo("")
            echo(
                " " + Style.warn("↑") + "  ${updates.size} update(s) available" +
                    // Converge adds what's MISSING; a newer version of something
                    // already installed is the package manager's business.
                    Style.dim(" — neither `setup-new-machine` nor `install --all` upgrades them; both only install what's MISSING. Upgrade with the package manager, then `loadout status`"),
            )
        }
        // A broken oracle is a different severity sitting under a long list of
        // ordinary updates — box it, the one place in this screen where a row
        // contrasts with its neighbours. The message carries a stderr tail, so
        // clamp it to the terminal: a box that wraps is worse than a plain line.
        if (report.errors.isNotEmpty()) {
            val tail = " — its results are missing this run"
            val budget = (terminalColumns() ?: 100) - 6 - tail.length
            echoRows(
                report.errors.map { (label, err) ->
                    val head = "  outdated source [$label] failed: $err"
                    val clamped = if (head.length <= budget) head else head.take(budget - 1) + "…"
                    TableRow(listOf(Style.error("✖") + clamped + Style.dim(tail)), severity = true)
                },
            )
        }
        if (report.unchecked.isNotEmpty()) {
            echo(Style.dim(" ·  ${report.unchecked.size} installed programs have no outdated oracle: ${report.unchecked.sorted().joinToString()}"))
        }
    }
}
