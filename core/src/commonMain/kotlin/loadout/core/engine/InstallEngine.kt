package loadout.core.engine

import loadout.core.exec.ProcessRunner
import loadout.core.manifest.ManifestLoader
import loadout.core.model.INSTALL_FILE_PREFIX
import loadout.core.model.Manifest
import loadout.core.model.PackageManager
import loadout.core.model.ProgramState
import loadout.core.model.ProgramStatus
import okio.Path

/** A plan could not be built; nothing was executed. */
class ResolutionException(message: String) : Exception(message)

sealed interface PlanItem {
    val program: String

    /** Will run [command] (the [installKey] entry of the program's install table). */
    data class Install(override val program: String, val installKey: String, val command: String) : PlanItem

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
    private val repoRoot: Path,
) {
    /**
     * Resolve what would happen for [requested] programs (empty = every manifest
     * program), expanded with their transitive dependencies, in dependency order.
     *
     * Strict resolution — throws [ResolutionException] (before anything runs) when:
     * - the manifest has no `[machines.<machine>.pm]` section,
     * - a planned program has no mapping for this machine,
     * - a program that needs installing is mapped to a known package manager
     *   whose binary is not present on this machine ([pmAvailable]).
     */
    fun plan(
        manifest: Manifest,
        machine: String,
        requested: Collection<String>,
        currentStates: Map<String, ProgramState>,
        pmAvailable: (PackageManager) -> Boolean,
    ): List<PlanItem> {
        val mapping = manifest.machines[machine]?.pm
            ?: throw ResolutionException(
                "machine '$machine' has no config file (machines/$machine.toml) in the repo",
            )

        val targets = requested.ifEmpty { manifest.programs.keys }
        val ordered = ManifestLoader.installOrder(manifest, targets)

        val errors = mutableListOf<String>()
        val items = mutableListOf<PlanItem>()
        for (name in ordered) {
            val installKey = mapping[name]
            if (installKey == null) {
                errors += "program '$name' has no pm defined for machine '$machine' (add it to machines/$machine.toml)"
                continue
            }
            val state = currentStates[name]
            if (state?.status == ProgramStatus.INSTALLED) {
                items += PlanItem.AlreadyInstalled(name, state.version)
            } else {
                // Key existence in the install table is validated at manifest load,
                // as is the existence of any file: script.
                val raw = manifest.programs.getValue(name).install.getValue(installKey)
                val command = if (raw.startsWith(INSTALL_FILE_PREFIX)) {
                    "sh '${raw.removePrefix(INSTALL_FILE_PREFIX)}'"
                } else {
                    raw
                }
                items += PlanItem.Install(name, installKey, command)
            }
        }

        // Verify that every package manager the plan actually uses exists here.
        items.filterIsInstance<PlanItem.Install>()
            .mapNotNull { item -> PackageManager.fromId(item.installKey)?.let { it to item.program } }
            .groupBy({ it.first }, { it.second })
            .forEach { (pm, programs) ->
                if (!pmAvailable(pm)) {
                    errors += "package manager '${pm.id}' (mapped for ${programs.joinToString()}) " +
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
            // Repo root as cwd, so file: scripts and relative paths behave the
            // same regardless of where the tool was invoked from.
            val exitCode = runner.inherit(item.command, workDir = repoRoot.toString())
            val after = checker.check(manifest.programs.getValue(item.program))
            InstallOutcome(item.program, exitCode, after)
        }

    /**
     * Like [execute], but with captured output delivered to [onOutput] line by
     * line (per finished command — not streamed live). For UIs that own the
     * terminal and can't hand stdio to child processes.
     */
    fun executeCaptured(
        manifest: Manifest,
        plan: List<PlanItem>,
        onOutput: (String) -> Unit,
    ): List<InstallOutcome> =
        plan.filterIsInstance<PlanItem.Install>().map { item ->
            onOutput("==> installing ${item.program}")
            val result = runner.capture(item.command, workDir = repoRoot.toString())
            (result.stdout + result.stderr).lineSequence()
                .filter { it.isNotBlank() }
                .forEach { onOutput("    $it") }
            val after = checker.check(manifest.programs.getValue(item.program))
            InstallOutcome(item.program, result.exitCode, after)
        }
}
