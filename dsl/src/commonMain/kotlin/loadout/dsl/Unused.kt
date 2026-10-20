package loadout.dsl

import loadout.core.manifest.ManifestDraft
import loadout.core.model.MachineConfig
import loadout.core.model.Manifest
import loadout.core.model.scriptEntry

/**
 * What no machine uses, for `loadout compile` to warn about: a program no
 * machine installs (or a way to install it none picks), a script none runs
 * (or a variant none picks), a profile none extends, a repo installer that
 * installs nothing in use. Declaring something and forgetting to use it is
 * otherwise silent. A profile marked spare keeps what it uses from being
 * reported, and a spare mark on something that is used is reported too, so
 * the marks stay true.
 */
fun unusedWarnings(draft: ManifestDraft, manifest: Manifest, spares: Map<String, String>): List<String> {
    val profiles = draft.profiles

    // Profiles some machine reaches, through extends chains.
    val reached = mutableSetOf<String>()
    fun reach(names: List<String>) {
        for (name in names) if (reached.add(name)) profiles[name]?.let { reach(it.extends) }
    }
    reach(draft.manifest.machines.values.flatMap { it.extends })

    // Everything a spare profile (and what it extends) says counts as used.
    fun closure(name: String, seen: MutableSet<String> = mutableSetOf()): List<MachineConfig> {
        if (!seen.add(name)) return emptyList()
        val config = profiles[name] ?: return emptyList()
        return listOf(config) + config.extends.flatMap { closure(it, seen) }
    }
    val spareProfiles = profiles.keys.filter { "profile '$it'" in spares }
    val users: List<Pair<String, MachineConfig>> =
        manifest.machines.map { (name, config) -> "machine '$name'" to config } +
            spareProfiles.flatMap { name -> closure(name).map { "profile '$name'" to it } }

    // Programs in use, with the variant each user picks; dependencies too.
    val picks = mutableMapOf<String, MutableSet<String>>() // program -> variants picked
    val usedPrograms = mutableMapOf<String, String>() // program -> who installs it
    for ((who, config) in users) {
        val seen = mutableSetOf<String>()
        val pending = ArrayDeque(config.pm.keys)
        while (pending.isNotEmpty()) {
            val program = pending.removeFirst()
            if (!seen.add(program)) continue
            usedPrograms.getOrPut(program) { who }
            val key = config.pm[program]
            if (key != null) picks.getOrPut(program) { mutableSetOf() } += key
            pending += manifest.dependenciesOf(program, key)
        }
    }
    val usedScripts = mutableMapOf<String, String>()
    val scriptPicks = mutableMapOf<String, MutableSet<String>>()
    for ((who, config) in users) {
        for (entry in config.scripts) usedScripts.getOrPut(scriptEntry(entry).first) { who }
        for ((script, variant) in config.scriptVariants) scriptPicks.getOrPut(script) { mutableSetOf() } += variant
    }
    val usedInstallers = picks.flatMap { (program, keys) ->
        keys.mapNotNull { key -> manifest.programs[program]?.install?.get(key)?.let { it.installer ?: key } }
    }.toSet()

    val warnings = mutableListOf<String>()
    fun unused(key: String, message: String) {
        if (key !in spares) warnings += "$message — if it's kept on purpose, mark it spare(reason = \"…\")"
    }
    fun staleSpare(key: String, by: String) {
        if (key in spares) warnings += "$key is marked spare, but $by uses it"
    }

    for (name in profiles.keys) {
        if (name in reached) staleSpare("profile '$name'", "a machine")
        else unused("profile '$name'", "profile '$name' isn't extended by any machine")
    }
    for ((name, program) in manifest.programs) {
        val who = usedPrograms[name]
        if (who == null) {
            unused("program '$name'", "program '$name' isn't installed on any machine")
            continue
        }
        staleSpare("program '$name'", who)
        if (program.install.size > 1) {
            for (key in program.install.keys - picks[name].orEmpty()) {
                unused("program '$name' via '$key'", "program '$name': no machine installs it via '$key'")
            }
        }
    }
    for ((name, script) in manifest.scripts) {
        val who = usedScripts[name]
        if (who == null) {
            unused("script '$name'", "script '$name' isn't run on any machine")
            continue
        }
        staleSpare("script '$name'", who)
        for (variant in script.variants.keys - scriptPicks[name].orEmpty()) {
            unused("script '$name' as '$variant'", "script '$name': no machine runs it as '$variant'")
        }
    }
    for (name in manifest.installers.keys - manifest.builtinInstallers) {
        if (name in usedInstallers) staleSpare("installer '$name'", "a program a machine installs")
        else unused("installer '$name'", "installer '$name' installs nothing a machine uses")
    }
    return warnings.sorted()
}
