package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.ProgramResult
import loadout.core.engine.InstallEngine
import loadout.core.engine.InstallOutcome
import loadout.core.engine.PlanItem
import loadout.core.engine.VersionChecker
import loadout.core.model.Manifest
import loadout.core.model.SystemInfo

/**
 * The program half of converging, shared by `install` and
 * `setup-new-machine` — observe, plan, show, confirm, execute. The two
 * commands differ in what they target and in what ELSE they do (scripts are
 * setup's alone), never in this sequence; keeping it in one place is what
 * stops one of them quietly growing a behavior the other lacks.
 */
class ProgramPlan(
    val engine: InstallEngine,
    val items: List<PlanItem>,
) {
    val installs: List<PlanItem.Install> get() = items.filterIsInstance<PlanItem.Install>()
}

/**
 * Re-ask every check this machine's mapping covers (plus any explicitly
 * [requested] program), then resolve what would happen. Empty [requested] =
 * the machine's whole mapped membership.
 */
fun CliktCommand.planPrograms(
    app: AppContext,
    manifest: Manifest,
    system: SystemInfo,
    requested: List<String> = emptyList(),
): ProgramPlan {
    val checker = VersionChecker(app.runner, app.repoRoot.toString())
    val engine = InstallEngine(app.runner, checker, app.repoRoot)
    val mapped = manifest.machines[system.machine]?.pm.orEmpty()
    val current = spinning("checking current state…") {
        checker.checkAll(
            manifest.programs.keys.filter { it in mapped || it in requested }
                .associateWith { name -> manifest.checkFor(name, mapped[name]) },
        )
    }
    return ProgramPlan(
        engine,
        engine.plan(manifest, system.machine, requested, current) { app.detection.isBinaryAvailable(it) },
    )
}

/**
 * Print the plan. [extraRows] are steps this command adds beyond programs
 * (setup's scripts) — passed in so their names count toward the column
 * width and the table stays one table.
 */
fun CliktCommand.echoPlan(
    plan: ProgramPlan,
    machine: String,
    extraRows: List<Pair<String, String>> = emptyList(),
) {
    val nameWidth = (plan.items.map { it.program.length } + extraRows.map { it.first.length } + 1).max()
    echo("")
    echo(Style.header("Plan for ") + Style.machine(machine) + Style.header(":"))
    for (item in plan.items) {
        when (item) {
            is PlanItem.Install ->
                echo("  " + Style.warn("+") + " ${item.program.padEnd(nameWidth)}  " + Style.dim("[${item.installKey}]") + " ${item.command}")
            is PlanItem.AlreadyInstalled ->
                echo("  " + Style.ok("=") + " ${item.program.padEnd(nameWidth)}  " + Style.dim(item.version ?: "installed"))
        }
    }
    for ((name, label) in extraRows) {
        echo("  " + Style.accent("~") + " ${name.padEnd(nameWidth)}  " + Style.dim(label))
    }
}

/** The [y/N] gate. `--yes` skips it; anything but y/yes aborts with exit 1. */
fun CliktCommand.confirmOrAbort(yes: Boolean) {
    if (yes) return
    echo("\nProceed? [y/N] ", trailingNewline = false)
    val answer = readlnOrNull()?.trim()?.lowercase()
    if (answer != "y" && answer != "yes") {
        echo("Aborted.")
        throw ProgramResult(1)
    }
}

/** Run the plan, announcing each install as it starts. */
fun CliktCommand.installPrograms(plan: ProgramPlan, manifest: Manifest): List<InstallOutcome> =
    plan.engine.execute(manifest, plan.items) {
        echo("\n" + Style.accent("==> installing ${it.program}"))
    }
