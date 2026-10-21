package loadout.dsl

import loadout.core.model.Manifest
import loadout.core.model.scriptEntry

/**
 * The `transitional()` scripts every machine that runs them reports done,
 * for `loadout compile` to say they can be deleted. [done] is each machine's
 * scripts whose state says done; a machine without a state file has done
 * nothing. A script no machine runs is left to [unusedWarnings].
 */
fun transitionalWarnings(manifest: Manifest, transitional: Set<String>, done: Map<String, Set<String>>): List<String> =
    transitional.sorted().mapNotNull { name ->
        val runners = manifest.machines.filterValues { config -> config.scripts.any { scriptEntry(it).first == name } }.keys.sorted()
        if (runners.isEmpty() || runners.any { name !in done[it].orEmpty() }) return@mapNotNull null
        "script '$name' is done on every machine that runs it (${runners.joinToString()}): it's transitional, so delete it"
    }
