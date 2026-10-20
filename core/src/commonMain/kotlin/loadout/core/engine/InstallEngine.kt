package loadout.core.engine

import loadout.core.exec.CommandFrame
import loadout.core.exec.ShellCommand
import loadout.core.LoadoutException
import loadout.core.exec.ProcessRunner
import loadout.core.manifest.ManifestAssembler
import loadout.core.model.Manifest
import loadout.core.model.ProgramState
import loadout.core.model.shellLine
import loadout.core.model.ProgramStatus
import okio.Path

/** A plan could not be built; nothing was executed. */
class ResolutionException(message: String) : LoadoutException(message)

sealed interface PlanItem {
    val program: String

    /** Will run [command] (the [installKey] entry of the program's install table). */
    data class Install(
        override val program: String,
        val installKey: String,
        val command: String,
        /** Where [command] runs: its declaring file's repo-relative directory. */
        val origin: String = "",
        /** [command] needs sudo's password: it runs sudo, or its variant or installer says so. */
        val sudo: Boolean = false,
    ) : PlanItem

    /** Already installed at [version]; nothing to do. */
    data class AlreadyInstalled(override val program: String, val version: String?) : PlanItem
}

data class InstallOutcome(
    val program: String,
    val exitCode: Int,
    val stateAfter: ProgramState,
) {
    val success: Boolean get() = exitCode == 0 && stateAfter.status != ProgramStatus.MISSING
}

class InstallEngine(
    private val runner: ProcessRunner,
    private val checker: VersionChecker,
    private val frame: CommandFrame = CommandFrame(),
) {
    /**
     * Resolve what would happen for [requested] programs (empty = every program
     * this machine's mapping opts into), expanded with their transitive
     * dependencies, in dependency order. A program the machine doesn't map is
     * simply not part of this machine's loadout — converge skips it.
     *
     * Strict resolution — throws [ResolutionException] (before anything runs) when:
     * - the manifest declares no such machine,
     * - an explicitly [requested] program has no mapping for this machine,
     * - a mapped program's dependency has no mapping for this machine,
     * - a program that needs installing resolves to a probe binary (the
     *   variant's `probe`, or its installer's) that is not present on this
     *   machine ([binaryAvailable]).
     */
    fun plan(
        manifest: Manifest,
        machine: String,
        requested: Collection<String>,
        currentStates: Map<String, ProgramState>,
        binaryAvailable: (String) -> Boolean,
    ): List<PlanItem> {
        val mapping = manifest.machines[machine]?.pm
            ?: throw ResolutionException(
                "machine '$machine' is not declared in the repo (add machine(\"$machine\") { … })",
            )
        val where = "install it in machine '$machine' or a profile it extends"

        // Membership: converge covers only mapped programs.
        val targets = requested.ifEmpty { manifest.programs.keys.filter { it in mapping } }
        val ordered = ManifestAssembler.installOrder(manifest, targets, mapping)

        val errors = mutableListOf<String>()
        val items = mutableListOf<PlanItem>()
        for (name in ordered) {
            val installKey = mapping[name]
            if (installKey == null) {
                errors += if (name in requested) {
                    "program '$name' isn't installed on machine '$machine' ($where)"
                } else {
                    "program '$name' is required as a dependency but isn't installed on " +
                        "machine '$machine' ($where)"
                }
                continue
            }
            val state = currentStates[name]
            if (state?.status == ProgramStatus.INSTALLED) {
                items += PlanItem.AlreadyInstalled(name, state.version)
            } else {
                // Key existence and command resolvability are validated at
                // manifest load, as is the existence of any file: script.
                val resolved = manifest.resolveInstall(name, installKey)
                val command = shellLine(resolved.command!!, resolved.path)
                items += PlanItem.Install(name, installKey, command, resolved.commandOrigin, resolved.sudo || commandNeedsSudo(command))
            }
        }

        // Verify that every probe binary the plan actually needs exists here.
        items.filterIsInstance<PlanItem.Install>()
            .mapNotNull { item ->
                manifest.resolveInstall(item.program, item.installKey).probe?.let { it to item.program }
            }
            .groupBy({ it.first }, { it.second })
            .forEach { (binary, programs) ->
                if (!binaryAvailable(binary)) {
                    errors += "required binary '$binary' (needed to install ${programs.joinToString()}) " +
                        "is not installed on machine '$machine'"
                }
            }

        if (errors.isNotEmpty()) {
            throw ResolutionException(
                "cannot build install plan:\n" + errors.joinToString("\n") { "  - $it" },
            )
        }
        return items
    }

    /**
     * Run the [PlanItem.Install] items in order with inherited stdio, re-checking
     * each program's version afterwards. Failures don't abort the run; each
     * outcome is reported so the caller decides what to surface.
     */
    fun execute(
        manifest: Manifest,
        plan: List<PlanItem>,
        onStart: (PlanItem.Install) -> Unit = {},
    ): List<InstallOutcome> =
        plan.filterIsInstance<PlanItem.Install>().map { item ->
            onStart(item)
            // The declaring file's directory as cwd, so file: scripts and
            // relative paths behave the same wherever the tool was invoked.
            val exitCode = runner.inherit(frame.command(item.command, item.origin))
            val after = checker.check(manifest.checkFor(item.program, item.installKey))
            InstallOutcome(item.program, exitCode, after)
        }
}
