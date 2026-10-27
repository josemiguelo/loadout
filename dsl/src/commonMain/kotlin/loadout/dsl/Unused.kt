package loadout.dsl

import loadout.core.manifest.ManifestDraft
import loadout.core.model.MachineConfig
import loadout.core.model.Manifest
import loadout.core.model.scriptEntry

/**
 * What no machine uses, for `loadout compile` to warn about: a program no
 * machine installs, a script none runs (or a variant none picks), a profile
 * none extends, a repo installer that installs nothing in use. A way to
 * install a program that no machine picks is reported only when some machine
 * uses that installer for other programs (a profile that installs everything
 * via dnf but this one): a true claim about an installer nobody uses (a
 * scaffold's ripgrep via apt, a COPR kept for a future Fedora machine) is
 * what `installVia` is for. Declaring something and forgetting to use it is
 * otherwise silent. A profile marked spare keeps what it uses from being
 * reported, and a spare mark on something that is used is reported too, so
 * the marks stay true.
 */
fun unusedWarnings(
    draft: ManifestDraft,
    manifest: Manifest,
    spares: Map<String, String>,
    /** A child repo's parent's declarations ([Registry.declaredNames]): their use is the parent's compile's business. */
    inherited: Set<String> = emptySet(),
): List<String> {
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
    val installerUsers = mutableMapOf<String, MutableSet<String>>() // installer -> who installs through it
    fun installerOf(program: String, key: String) = manifest.programs[program]?.install?.get(key)?.let { it.installer ?: key }
    for ((who, config) in users) {
        val seen = mutableSetOf<String>()
        val pending = ArrayDeque(config.pm.keys)
        while (pending.isNotEmpty()) {
            val program = pending.removeFirst()
            if (!seen.add(program)) continue
            usedPrograms.getOrPut(program) { who }
            val key = config.pm[program]
            if (key != null) {
                picks.getOrPut(program) { mutableSetOf() } += key
                installerOf(program, key)?.let { installerUsers.getOrPut(it) { mutableSetOf() } += who }
            }
            pending += manifest.dependenciesOf(program, key)
        }
    }
    val usedScripts = mutableMapOf<String, String>()
    val scriptPicks = mutableMapOf<String, MutableSet<String>>()
    for ((who, config) in users) {
        for (entry in config.scripts) usedScripts.getOrPut(scriptEntry(entry).first) { who }
        for ((script, variant) in config.scriptVariants) scriptPicks.getOrPut(script) { mutableSetOf() } += variant
    }
    val usedInstallers = installerUsers.keys

    val warnings = mutableListOf<String>()
    fun isInherited(key: String) = inherited.any { key == it || key.startsWith("$it ") }
    fun unused(key: String, message: String) {
        if (key !in spares && !isInherited(key)) warnings += "$message — if it's kept on purpose, mark it spare(reason = \"…\")"
    }
    fun staleSpare(key: String, by: String) {
        if (key in spares && !isInherited(key)) warnings += "$key is marked spare, but $by uses it"
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
            for (key in program.install.keys) {
                val spareKey = "program '$name' via '$key'"
                if (key in picks[name].orEmpty()) {
                    staleSpare(spareKey, "a machine")
                    continue
                }
                val others = installerOf(name, key)?.let { installerUsers[it] }.orEmpty().sorted()
                if (others.isEmpty()) continue
                val more = if (others.size > 1) " (and ${others.size - 1} more)" else ""
                unused(spareKey, "program '$name': ${others.first()}$more installs other programs via '$key', but not $name")
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
        for (variant in script.variants.keys) {
            val spareKey = "script '$name' as '$variant'"
            if (variant in scriptPicks[name].orEmpty()) staleSpare(spareKey, "a machine")
            else unused(spareKey, "script '$name': no machine runs it as '$variant'")
        }
    }
    for (name in manifest.installers.keys - manifest.builtinInstallers) {
        if (name in usedInstallers) staleSpare("installer '$name'", "a program a machine installs")
        else unused("installer '$name'", "installer '$name' installs nothing a machine uses")
    }
    return warnings.sorted()
}
