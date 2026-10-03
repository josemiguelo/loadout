package loadout.cli

import loadout.core.exec.ShellCommand
import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.UsageError
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.multiple
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.multiple
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.engine.UpgradeEngine
import loadout.core.model.ProgramStatus

/**
 * The one verb that moves installed programs to newer versions, and it moves
 * them a whole mechanism at a time: `dnf upgrade -y`, not a package list.
 * Converge installs what's MISSING and never upgrades (contract 15).
 */
class UpgradeCommand : CliktCommand(name = "upgrade") {
    override fun help(context: Context) = commandHelp(
        "Upgrade everything a package manager on this machine manages — the whole mechanism, never single packages (the binary itself is `self-upgrade`).",
        "<installers...>  which mechanisms to upgrade (dnf, brew, flatpak, ...)",
        "--all            every mechanism this machine's mapping uses",
        "--item <source>/<name>  one item of an [outdated.<source>] (a tmux plugin, a pinned tool); repeatable",
        "--dry-run        print the commands, run nothing",
        "--yes            skip the confirmation",
    )

    private val names by argument(name = "installers", help = "Installers to upgrade").multiple()
    private val all by option("--all", help = "Every mechanism this machine uses").flag()
    private val items by option("--item", help = "One item of a custom outdated source, as <source>/<name>").multiple()
    private val dryRun by option("--dry-run", help = "Show the commands without running them").flag()
    private val yes by option("-y", "--yes", help = "Don't ask for confirmation").flag()

    private val app by requireObject<AppContext>()

    override fun run() {
        if (all && names.isNotEmpty()) throw UsageError("Give installer names or --all, not both")
        if (!all && names.isEmpty() && items.isEmpty()) {
            throw UsageError("Give at least one installer, --all, or --item <source>/<name>")
        }
        // Items run one at a time, grouped by source, in the order given.
        val bySource = items.map { given ->
            val source = given.substringBefore('/', missingDelimiterValue = "")
            val item = given.substringAfter('/', missingDelimiterValue = "")
            if (source.isEmpty() || item.isEmpty()) throw UsageError("--item takes <source>/<name>, not '$given'")
            source to item
        }.groupBy({ it.first }, { it.second })

        val manifest = app.loadManifest()
        val system = app.detectSystem()
        val before = app.stateStore.read(system.machine)?.programs.orEmpty()
        app.stateStore.lastWarnings.forEach { echo("warning: $it", err = true) }

        bySource.keys.firstOrNull { it !in manifest.outdated }?.let {
            throw UsageError("Unknown outdated source '$it' (sources are the manifest's [outdated.*] tables)")
        }
        val engine = UpgradeEngine
        val targets = if (all) engine.upgradableInstallers(manifest, system.machine).keys else names
        if (targets.isEmpty() && bySource.isEmpty()) {
            echo(Style.dim("No mechanism on ${system.machine} declares an upgrade command."))
            return
        }
        val plan = engine.plan(manifest, system.machine, targets) +
            bySource.flatMap { (source, names) -> engine.planSourceItems(manifest, source, names) }

        echo("")
        echo(Style.header("Upgrade on ") + Style.machine(system.machine) + Style.header(":"))
        for (step in plan) {
            echo("  " + Style.warn("↑") + " " + Style.dim("[${step.label}]") + " " + step.command)
            if (step.covers.isNotEmpty()) {
                echo("      " + Style.dim("covers ${step.covers.size} mapped program(s): ${step.covers.joinToString()}"))
            }
        }
        echo("")
        // A whole-mechanism upgrade touches everything that mechanism has,
        // not only what this repo declares. Say so before it runs.
        echo(Style.dim("  This upgrades everything each mechanism manages — including packages loadout doesn't declare."))
        if (dryRun) return
        confirmOrAbort(yes)

        // Inherited stdio: sudo may prompt, dnf shows progress. A failing
        // mechanism doesn't stop the rest — they're independent.
        val failed = plan.filter { step ->
            echo("\n" + Style.accent("==> upgrading ${step.label}"))
            app.runner.inherit(ShellCommand(step.command, app.repoRoot.toString())) != 0
        }

        echo("")
        // The transaction moved what it moved: re-observe everything, the
        // same way `status` does, and say what changed.
        val after = spinning("re-checking every program…") { app.refreshAndWriteState(manifest, system) }
        val changed = after.programs.filter { (name, now) ->
            now.status == ProgramStatus.INSTALLED && now.version != null && now.version != before[name]?.version
        }
        echo(" " + Style.ok("✔") + "  ${changed.size} declared program(s) changed version")
        for ((name, now) in changed.entries.sortedBy { it.key }) {
            echo("      " + name + Style.dim("  ${before[name]?.version ?: "?"} -> ") + Style.warn(now.version ?: "?"))
        }
        if (failed.isNotEmpty()) {
            echo(" " + Style.error("✘") + "  failed: ${failed.joinToString { it.label }}")
            throw ProgramResult(1)
        }
    }
}
