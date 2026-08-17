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
import loadout.core.engine.ScriptOutcome
import loadout.core.engine.ScriptRunner
import loadout.core.engine.VersionChecker
import loadout.core.manifest.ManifestLoader
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus
import kotlinx.coroutines.runBlocking

class InstallCommand : CliktCommand(name = "install") {
    override fun help(context: Context) =
        "Install missing manifest programs (all of them, or just NAMES and their dependencies). " +
            "With no NAMES, applicable setup scripts run too."

    private val names by argument(name = "names", help = "Programs to install (default: everything missing)")
        .multiple()
    private val dryRun by option("--dry-run", help = "Show what would run without doing it").flag()
    private val yes by option("-y", "--yes", help = "Don't ask for confirmation").flag()
    private val skipScripts by option("--skip-scripts", help = "Don't run setup scripts").flag()

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
        val current = runBlocking { checker.checkAll(manifest.programs) }
        val plan = engine.plan(manifest, system.machine, names, current) { app.detection.isPmAvailable(it) }

        val scriptRunner = ScriptRunner(app.runner, app.repoRoot)
        val scriptNames = if (names.isEmpty() && !skipScripts) {
            ManifestLoader.scriptOrder(manifest)
                .filter { manifest.scripts.getValue(it).appliesTo(system.os) }
        } else {
            emptyList()
        }

        val installs = plan.filterIsInstance<PlanItem.Install>()
        echo("")
        echo("Plan for ${system.machine}:")
        for (item in plan) {
            when (item) {
                is PlanItem.Install -> echo("  + ${item.program}  [${item.installKey}]  ->  ${item.command}")
                is PlanItem.AlreadyInstalled -> echo("  = ${item.program}  (installed${item.version?.let { " $it" } ?: ""})")
            }
        }
        for (name in scriptNames) echo("  ~ script ${name}")

        if (installs.isEmpty() && scriptNames.isEmpty()) {
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

        val outcomes = engine.execute(manifest, plan) { echo("\n==> installing ${it.program}") }

        val scriptResults = mutableMapOf<String, ScriptState>()
        for (name in scriptNames) {
            val step = manifest.scripts.getValue(name)
            when (val outcome = scriptRunner.run(step, system.os)) {
                is ScriptOutcome.AlreadyDone -> echo("\n==> script $name: already done (check passed)")
                is ScriptOutcome.NotApplicable -> {}
                is ScriptOutcome.Ran -> {
                    echo("\n==> ran script $name (exit ${outcome.state.exitCode})")
                    scriptResults[name] = outcome.state
                }
            }
        }

        echo("\nUpdating state...")
        runBlocking { app.refreshAndWriteState(manifest, system, scriptResults) }

        val failedInstalls = outcomes.filterNot { it.success }
        val failedScripts = scriptResults.filterValues { it.status == ScriptStatus.FAILED }
        echo("Done: ${outcomes.count { it.success }}/${outcomes.size} programs installed, ${scriptResults.size} scripts run.")
        if (failedInstalls.isNotEmpty()) echo("Failed installs: ${failedInstalls.joinToString { it.program }}")
        if (failedScripts.isNotEmpty()) echo("Failed scripts: ${failedScripts.keys.joinToString()}")
        if (failedInstalls.isNotEmpty() || failedScripts.isNotEmpty()) throw ProgramResult(1)
    }
}
