package loadout.core.engine

import loadout.core.LoadoutException
import loadout.core.exec.ProcessRunner
import loadout.core.model.Manifest
import loadout.core.model.ProgramState
import loadout.core.model.expandFilePrefix
import okio.Path

/**
 * One upgrade command and every mechanism it covers. dnf, dnf-repo and
 * dnf-copr all run `dnf upgrade -y`: that's ONE transaction, not three.
 */
data class UpgradeStep(
    val installers: List<String>,
    val command: String,
    /** The machine's programs these mechanisms install — what you'll see move. */
    val covers: List<String>,
) {
    val label: String get() = installers.joinToString(", ")
}

data class UpgradeOutcome(val step: UpgradeStep, val exitCode: Int) {
    val success: Boolean get() = exitCode == 0
}

/** A mechanism can't be upgraded, and why — refusals are explicit, never silent. */
class UpgradeException(message: String) : LoadoutException(message)

/**
 * Moves installed programs to newer versions — the one verb that does that.
 * Converging installs what's MISSING and never touches a version that's
 * already there (contract 15); this is the separate, explicit ask.
 *
 * Upgrades are always WHOLE-MECHANISM: `dnf upgrade -y`, not
 * `dnf upgrade -y code`. Partial upgrades are unsupported on Arch,
 * discouraged on Fedora, and pointless everywhere else — the package manager
 * resolves its own transaction, so asking for one package moves whatever
 * that implies anyway. Picking a program in the UI means "upgrade the
 * mechanism it came from".
 */
class UpgradeEngine(
    private val runner: ProcessRunner,
    private val checker: VersionChecker,
    private val repoRoot: Path,
) {
    /** The installers this machine's mapping uses that can upgrade themselves. */
    fun upgradableInstallers(manifest: Manifest, machine: String): Map<String, List<String>> {
        val mapping = manifest.machines[machine]?.pm.orEmpty()
        val byInstaller = linkedMapOf<String, MutableList<String>>()
        for ((program, key) in mapping) {
            val mechanism = manifest.resolveInstall(program, key).upgradeWith ?: continue
            byInstaller.getOrPut(mechanism.installer) { mutableListOf() }.add(program)
        }
        return byInstaller.mapValues { it.value.sorted() }
    }

    /** One step per named installer; unknown or non-upgrading ones are errors. */
    fun plan(manifest: Manifest, machine: String, installers: Collection<String>): List<UpgradeStep> {
        val available = upgradableInstallers(manifest, machine)
        val errors = mutableListOf<String>()
        val steps = installers.distinct().mapNotNull { name ->
            val command = available[name]?.let { manifest.installers[name]?.upgrade }
            when {
                command == null -> {
                    errors += if (name in manifest.installers && manifest.installers[name]?.upgrade != null) {
                        // Refusing this is the safety property: loadout only
                        // upgrades mechanisms THIS machine's loadout uses, so
                        // a repo that maps nothing to brew can never run it.
                        "installer '$name' is not used by machine '$machine' — nothing here installs through it"
                    } else if (name in manifest.installers) {
                        "installer '$name' declares no upgrade command"
                    } else if (name in manifest.programs) {
                        "'$name' is a program — upgrades are whole-mechanism, so name its " +
                            "installer instead (see `loadout explain $name`)"
                    } else {
                        "unknown installer '$name'"
                    }
                    null
                }
                else -> name to expandFilePrefix(command)
            }
        }
        if (errors.isNotEmpty()) {
            throw UpgradeException("cannot upgrade:\n" + errors.joinToString("\n") { "  - $it" })
        }
        // Same command = same transaction: run it once, name every mechanism
        // it covers.
        return steps.groupBy({ it.second }, { it.first }).map { (command, mechanisms) ->
            UpgradeStep(
                installers = mechanisms,
                command = command,
                covers = mechanisms.flatMap { available[it].orEmpty() }.distinct().sorted(),
            )
        }
    }

    /** The upgrade command each of this machine's mechanisms runs. */
    fun commandsFor(manifest: Manifest, machine: String): Map<String, String> =
        upgradableInstallers(manifest, machine).keys
            .mapNotNull { name -> manifest.installers[name]?.upgrade?.let { name to it } }
            .toMap()

    /**
     * Run each step with inherited stdio (they need sudo and show progress).
     * A failing mechanism doesn't stop the rest: they're independent.
     */
    fun execute(plan: List<UpgradeStep>, onStart: (UpgradeStep) -> Unit = {}): List<UpgradeOutcome> =
        plan.map { step ->
            onStart(step)
            UpgradeOutcome(step, runner.inherit(step.command, workDir = repoRoot.toString()))
        }

    /**
     * Re-check EVERY mapped program afterwards: a whole-mechanism upgrade
     * moves whatever it moves, and state has to match the machine rather
     * than the subset someone had in mind.
     */
    suspend fun verify(manifest: Manifest, machine: String): Map<String, ProgramState> {
        val mapping = manifest.machines[machine]?.pm.orEmpty()
        return checker.checkAll(
            manifest.programs.keys.filter { it in mapping }
                .associateWith { name -> manifest.checkFor(name, mapping[name]) },
        )
    }
}
