package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
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

class SetupCommand : CliktCommand(name = "setup-new-machine") {
    override fun help(context: Context) =
        "Set up this machine: install every missing program, then run its setup scripts. " +
            "For specific programs use `install`; for specific scripts use `run`."

    private val dryRun by option("--dry-run", help = "Show what would run without doing it").flag()
    private val yes by option("-y", "--yes", help = "Don't ask for confirmation").flag()
    private val skipScripts by option("--skip-scripts", help = "Don't run setup scripts").flag()

    private val app by requireObject<AppContext>()

    override fun run() {
        val manifest = app.loadManifest()
        val system = app.detectSystem()

        val checker = VersionChecker(app.runner, app.repoRoot.toString())
        val engine = InstallEngine(app.runner, checker, app.repoRoot)

        echo("Checking current state...")
        val mapped = manifest.machines[system.machine]?.pm.orEmpty()
        val current = runBlocking {
            checker.checkAll(
                manifest.programs.keys.filter { it in mapped }
                    .associateWith { n -> manifest.checkFor(n, mapped[n]) },
            )
        }
        val plan = engine.plan(manifest, system.machine, emptyList(), current) { app.detection.isBinaryAvailable(it) }

        val scriptRunner = ScriptRunner(app.runner, app.repoRoot)
        val enabledScripts = manifest.machines[system.machine]?.scriptArgs().orEmpty()
        val scriptNames = if (!skipScripts) {
            ManifestLoader.scriptOrder(manifest, enabledScripts.keys)
                .filter {
                    it in enabledScripts &&
                        manifest.scripts.getValue(it).appliesTo(system.os) &&
                        manifest.scripts.getValue(it).runsIn("setup")
                }
        } else {
            emptyList()
        }

        val installs = plan.filterIsInstance<PlanItem.Install>()
        val nameWidth = (plan.map { it.program.length } + scriptNames.map { it.length } + 1).max()
        echo("")
        echo("Plan for ${system.machine}:")
        for (item in plan) {
            when (item) {
                is PlanItem.Install ->
                    echo("  + ${item.program.padEnd(nameWidth)}  [${item.installKey}] ${item.command}")
                is PlanItem.AlreadyInstalled ->
                    echo("  = ${item.program.padEnd(nameWidth)}  ${item.version ?: "installed"}")
            }
        }
        for (name in scriptNames) echo("  ~ ${name.padEnd(nameWidth)}  script")

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
            when (val outcome = scriptRunner.run(step, system.os, args = enabledScripts.getValue(name))) {
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
