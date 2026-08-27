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
import loadout.core.engine.InstallEngine
import loadout.core.engine.PlanItem
import loadout.core.engine.VersionChecker
import kotlinx.coroutines.runBlocking

/**
 * The targeted installer: named programs only, dependencies first. Scripts
 * are `run`'s job; the whole loadout is `setup-new-machine`'s.
 */
class InstallCommand : CliktCommand(name = "install") {
    override fun help(context: Context) = commandHelp(
        "Install the named programs on this machine, dependencies first.",
        "<programs...>  programs from the manifest (+ depends-on)",
        "--dry-run      print the plan, execute nothing",
        "--yes          skip the confirmation",
    )

    private val names by argument(name = "programs", help = "Programs to install")
        .multiple(required = true)
    private val dryRun by option("--dry-run", help = "Show what would run without doing it").flag()
    private val yes by option("-y", "--yes", help = "Don't ask for confirmation").flag()

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()
        names.filterNot { it in manifest.programs }.let { unknown ->
            if (unknown.isNotEmpty()) throw UsageError("Unknown programs: ${unknown.joinToString()}")
        }

        val checker = VersionChecker(app.runner, app.repoRoot.toString())
        val engine = InstallEngine(app.runner, checker, app.repoRoot)

        echo("Checking current state...")
        val mapped = manifest.machines[system.machine]?.pm.orEmpty()
        val current = runBlocking {
            checker.checkAll(
                manifest.programs.keys.filter { it in mapped || it in names }
                    .associateWith { n -> manifest.checkFor(n, mapped[n]) },
            )
        }
        val plan = engine.plan(manifest, system.machine, names, current) { app.detection.isBinaryAvailable(it) }
        val installs = plan.filterIsInstance<PlanItem.Install>()

        val nameWidth = (plan.map { it.program.length } + 1).max()
        echo("")
        echo(Style.header("Plan for ") + Style.machine(system.machine) + Style.header(":"))
        for (item in plan) {
            when (item) {
                is PlanItem.Install ->
                    echo("  " + Style.warn("+") + " ${item.program.padEnd(nameWidth)}  " + Style.dim("[${item.installKey}]") + " ${item.command}")
                is PlanItem.AlreadyInstalled ->
                    echo("  " + Style.ok("=") + " ${item.program.padEnd(nameWidth)}  " + Style.dim(item.version ?: "installed"))
            }
        }

        if (installs.isEmpty()) {
            echo("\nNothing to do.")
            return
        }
        if (dryRun) return

        if (!yes) {
            echo("\nProceed? [y/N] ", trailingNewline = false)
            val answer = readlnOrNull()?.trim()?.lowercase()
            if (answer != "y" && answer != "yes") {
                echo("Aborted.")
                throw ProgramResult(1)
            }
        }

        val outcomes = engine.execute(manifest, plan) { echo("\n" + Style.accent("==> installing ${it.program}")) }

        echo("\nUpdating state...")
        runBlocking { app.refreshAndWriteState(manifest, system) }

        val failed = outcomes.filterNot { it.success }
        echo(" " + Style.ok("\u2714") + "  ${outcomes.count { it.success }}/${outcomes.size} programs installed")
        if (failed.isNotEmpty()) {
            echo(" " + Style.error("\u2718") + "  failed installs: ${failed.joinToString { it.program }}")
            throw ProgramResult(1)
        }
    }
}
