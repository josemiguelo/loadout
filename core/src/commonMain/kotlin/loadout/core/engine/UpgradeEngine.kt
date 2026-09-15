package loadout.core.engine

import loadout.core.LoadoutException
import loadout.core.model.Manifest
import loadout.core.model.expandFilePrefix

/**
 * One upgrade command and every mechanism it covers. dnf, dnf-repo and
 * dnf-copr all run `dnf upgrade -y`: that's ONE transaction, not three.
 */
data class UpgradeStep(
    val installers: List<String>,
    val command: String,
    /** The machine's programs these mechanisms install — what you'll see move. */
    val covers: List<String>,
    /** True for a whole-mechanism sweep; false for one custom-source item. */
    val sweep: Boolean = true,
    /** The tool the sweep's mechanisms all drive (their shared probe), when they do. */
    val tool: String? = null,
) {
    /**
     * What to call this step on screen: a sweep is the TOOL it drives when
     * its mechanisms share one — a user knows "dnf", not that the manifest
     * splits it into dnf/dnf-repo/dnf-copr — else the mechanisms; a per-item
     * step is the source AND the item, since "pins" alone doesn't say which
     * pin failed.
     */
    val label: String get() = when {
        !sweep -> "${installers.single()}: ${covers.single()}"
        tool != null -> tool
        else -> installers.joinToString(", ")
    }
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
 *
 * A planner only: it decides WHAT runs and refuses what mustn't. Running
 * the steps belongs to the caller, because that is where the two callers
 * differ — the CLI inherits stdio (sudo may prompt there), the home
 * screen's pane streams (it can't show a prompt). Verification is the same
 * for both and is not here either: re-observe everything the way `status`
 * does (AppContext.refreshAndWriteState) and diff the versions.
 */
object UpgradeEngine {
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

    /**
     * One step per item of a custom `[outdated.<name>]` source. Unlike a
     * package mechanism, these update one at a time: each row is a pin in a
     * file or a clone of its own, so nothing is shared and one failure
     * doesn't take the rest with it.
     */
    fun planSourceItems(
        manifest: Manifest,
        source: String,
        items: Collection<String>,
    ): List<UpgradeStep> {
        val pattern = manifest.outdated[source]?.upgrade
            ?: throw UpgradeException(
                "cannot upgrade:\n  - outdated source '$source' declares no upgrade command",
            )
        return items.map { item ->
            UpgradeStep(
                installers = listOf(source),
                command = expandFilePrefix(pattern).replace("{item}", item),
                covers = listOf(item),
                sweep = false,
            )
        }
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
            val probes = mechanisms.map { manifest.installers[it]?.probe }.distinct()
            UpgradeStep(
                installers = mechanisms,
                command = command,
                covers = mechanisms.flatMap { available[it].orEmpty() }.distinct().sorted(),
                tool = probes.singleOrNull()?.takeIf { it != null },
            )
        }
    }
}
