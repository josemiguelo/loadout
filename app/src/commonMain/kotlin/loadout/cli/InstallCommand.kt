package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.UsageError
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.multiple
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option

/**
 * The targeted installer: named programs (or --all, this machine's whole
 * mapped membership), dependencies first. Scripts are `run`'s job; programs
 * *and* scripts together are `setup-new-machine`'s.
 */
class InstallCommand : CliktCommand(name = "install") {
    override fun help(context: Context) = commandHelp(
        "Install the named programs on this machine, dependencies first.",
        "<programs...>  programs from the manifest (+ depends-on)",
        "--all          every program this machine maps, instead of names",
        "--dry-run      print the plan, execute nothing",
        "--yes          skip the confirmation",
    )

    private val names by argument(name = "programs", help = "Programs to install")
        .multiple()
    private val all by option(
        "--all",
        help = "Install every program mapped for this machine (same membership as setup-new-machine)",
    ).flag()
    private val dryRun by option("--dry-run", help = "Show what would run without doing it").flag()
    private val yes by option("-y", "--yes", help = "Don't ask for confirmation").flag()

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()
        if (all && names.isNotEmpty()) throw UsageError("Give program names or --all, not both")
        if (!all && names.isEmpty()) throw UsageError("Give at least one program, or --all")
        names.filterNot { it in manifest.programs }.let { unknown ->
            if (unknown.isNotEmpty()) throw UsageError("Unknown programs: ${unknown.joinToString()}")
        }

        val plan = planPrograms(app, manifest, system, names)
        echoPlan(plan, system.machine)

        if (plan.installs.isEmpty()) {
            echo("\nNothing to do.")
            return
        }
        if (dryRun) return
        confirmOrAbort(yes)

        val outcomes = installPrograms(plan, manifest)

        echo("")
        spinning("updating state…") { app.refreshAndWriteState(manifest, system) }

        val failed = outcomes.filterNot { it.success }
        echo(" " + Style.ok("\u2714") + "  ${outcomes.count { it.success }}/${outcomes.size} programs installed")
        if (failed.isNotEmpty()) {
            echo(" " + Style.error("\u2718") + "  failed installs: ${failed.joinToString { it.program }}")
            throw ProgramResult(1)
        }
    }
}
