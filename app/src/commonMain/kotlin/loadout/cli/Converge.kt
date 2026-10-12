package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.ProgramResult
import loadout.core.engine.InstallEngine
import loadout.core.engine.InstallOutcome
import loadout.core.engine.PlanItem
import loadout.core.engine.VersionChecker
import loadout.core.exec.ProcessRunner
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
    val frame = app.frame(system)
    val checker = VersionChecker(app.runner, frame)
    val engine = InstallEngine(app.runner, checker, frame)
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

/**
 * When [needed] (a step of the run needs sudo's password), ask for it once,
 * now, before the first step, instead of in the middle of the run whenever
 * sudo's credentials have run out. Then keep them fresh until loadout exits:
 * a step an hour in finds them as valid as the first. Nothing is asked when
 * they're still valid. Refusing stops the run before anything ran.
 *
 * The refresher is a shell loop in the background, not a thread: `sudo -n
 * -v` every 50s while loadout's process ($PPID of the `sh -c` that starts
 * it) lives. It looks every second, so it ends within one of loadout,
 * however loadout ends. It shares loadout's terminal, the one sudo keys its
 * credentials to.
 */
fun CliktCommand.askForSudoUpfront(runner: ProcessRunner, needed: Boolean) {
    if (!needed) return
    if (!runner.capture("sudo -n true").success) {
        echo("\n" + Style.accent("A step needs your sudo password."))
        if (runner.inherit("sudo -v") != 0) {
            echo("Aborted: the steps that need sudo can't run without it.", err = true)
            throw ProgramResult(1)
        }
    }
    runner.capture(SUDO_KEEPALIVE)
}

internal const val SUDO_KEEPALIVE =
    "( while :; do i=0; while [ \$i -lt 50 ]; do kill -0 \$PPID 2>/dev/null || exit 0; sleep 1; i=\$((i + 1)); done; " +
        "sudo -n -v 2>/dev/null || exit 0; done ) </dev/null >/dev/null 2>&1 &"

/** Run the plan, announcing each install as it starts. */
fun CliktCommand.installPrograms(plan: ProgramPlan, manifest: Manifest): List<InstallOutcome> =
    plan.engine.execute(manifest, plan.items) {
        echo("\n" + Style.accent("==> installing ${it.program}"))
    }
