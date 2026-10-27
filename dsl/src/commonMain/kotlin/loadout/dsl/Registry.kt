package loadout.dsl

import kotlinx.serialization.json.JsonObject
import loadout.core.LoadoutException
import loadout.core.versionAtLeast
import loadout.core.manifest.ManifestDraft
import loadout.core.model.Installer as InstallerModel
import loadout.core.model.MachineConfig
import loadout.core.model.Manifest
import loadout.core.model.Meta
import loadout.core.model.OutdatedSource
import loadout.core.model.Program as ProgramModel
import loadout.core.model.RepoLayout
import loadout.core.model.ScriptStep

/** A mistake the DSL catches while the manifests run; `loadout compile` reports it like any refusal. */
class DslException(message: String) : LoadoutException(message)

/**
 * Everything the manifests declared so far. Top-level declarations in a
 * repo's files land in [current] as their file is first used; tests build
 * one of their own with [buildManifest].
 */
class Registry(
    /** A child's compile's registry for its parent's declarations: their origins are the parent's ([loadout.core.model.Origin]). */
    internal val isParent: Boolean = false,
) {
    internal var meta = Meta()
    internal var layout = RepoLayout()
    internal var data = JsonObject(emptyMap())
    internal val installers = linkedMapOf<String, InstallerModel>()
    internal val requires = linkedMapOf<String, MutableList<String>>()
    internal val programs = linkedMapOf<String, ProgramModel>()
    internal val scripts = linkedMapOf<String, ScriptStep>()
    internal val outdated = linkedMapOf<String, OutdatedSource>()
    internal val machines = linkedMapOf<String, MachineConfig>()
    internal val profiles = linkedMapOf<String, MachineConfig>()
    internal val errors = mutableListOf<String>()

    /** What `spare(reason)` marked, keyed as warnings name it ("program 'x'"), with the reason. */
    internal val spares = linkedMapOf<String, String>()

    /** Scripts marked `transitional()`: `loadout compile` says when every machine has done one. */
    internal val transitional = linkedSetOf<String>()

    internal fun <V> add(kind: String, name: String, map: MutableMap<String, V>, value: V) {
        if (map.put(name, value) != null) errors += "duplicate $kind '$name'"
    }

    /** What was declared, ready for [loadout.core.manifest.ManifestAssembler]. */
    fun draft(): ManifestDraft {
        if (errors.isNotEmpty()) {
            throw DslException("Invalid manifest:\n" + errors.distinct().joinToString("\n") { "  - $it" })
        }
        return ManifestDraft(
            manifest = Manifest(
                meta = meta,
                layout = layout,
                installers = installers,
                programs = programs,
                scripts = scripts,
                machines = machines,
                outdated = outdated,
                data = data,
            ),
            profiles = profiles,
            requires = requires.mapValues { it.value.toList() },
        )
    }

    /**
     * A child repo's draft (contract 18): this registry's declarations over
     * [parent]'s. The parent's installers, programs, scripts, outdated
     * sources, profiles and data schema join the child's; its machines don't,
     * and nor do its meta and layout. A name both repos declare is an error
     * naming the parent, as is a child data schema. The repo floor is the
     * higher of the two.
     */
    fun draftOver(parent: Registry, parentName: String): ManifestDraft {
        val label = "parent $parentName"
        errors += parent.errors.map { "$label: $it" }
        if (data.isNotEmpty()) errors += "a child repo's data schema is its parent's — drop data = … from repo(…)"
        fun clash(kind: String, mine: Map<String, *>, theirs: Map<String, *>) {
            for (name in mine.keys intersect theirs.keys) errors += "$kind '$name' is declared by $label too"
        }
        clash("installer", installers, parent.installers)
        clash("program", programs, parent.programs)
        clash("script", scripts, parent.scripts)
        clash("outdated source", outdated, parent.outdated)
        clash("profile", profiles, parent.profiles)
        for (name in machines.keys intersect parent.machines.keys) {
            errors += "machine '$name' is declared by $label too — a machine belongs to one repo"
        }
        val own = draft()
        val floors = listOfNotNull(meta.minToolVersion, parent.meta.minToolVersion)
        val floor = floors.reduceOrNull { a, b -> if (versionAtLeast(a, b)) a else b }
        return own.copy(
            manifest = own.manifest.copy(
                meta = own.manifest.meta.copy(minToolVersion = floor),
                installers = parent.installers + installers,
                programs = parent.programs + programs,
                scripts = parent.scripts + scripts,
                outdated = parent.outdated + outdated,
                data = parent.data,
            ),
            profiles = parent.profiles + profiles,
            requires = (parent.requires.keys + requires.keys).associateWith { name ->
                (parent.requires[name].orEmpty() + requires[name].orEmpty()).distinct()
            },
        )
    }

    /** What the parent declared, as warnings name it ("program 'x'"): a child's compile doesn't warn about them. */
    fun declaredNames(): Set<String> =
        installers.keys.map { "installer '$it'" }.toSet() + programs.keys.map { "program '$it'" } +
            scripts.keys.map { "script '$it'" } + profiles.keys.map { "profile '$it'" }

    companion object {
        /** Where declarations land. */
        var current: Registry = Registry()
            internal set

        /** Runs [block] with declarations landing in [registry]: how a child's compile keeps its parent's apart. */
        internal fun <T> into(registry: Registry, block: () -> T): T {
            val previous = current
            current = registry
            try {
                return block()
            } finally {
                current = previous
            }
        }
    }
}

/**
 * Declarations made in [block] go to a registry of their own, returned as a
 * draft: how tests (and anything else that isn't a repo's compile) build a
 * manifest without touching the global one.
 */
fun buildManifest(block: () -> Unit): ManifestDraft {
    val previous = Registry.current
    val registry = Registry()
    Registry.current = registry
    try {
        block()
    } finally {
        Registry.current = previous
    }
    return registry.draft()
}

/**
 * The manifest [block] declares, assembled without checking `file:` paths
 * against a repo, with state in `state/` unless the block says otherwise.
 * TEST-ONLY: how engine and screen tests build fixtures.
 */
fun manifestOf(block: () -> Unit): loadout.core.model.Manifest {
    val draft = buildManifest(block)
    val layout = draft.manifest.layout.let { if (it.state.isBlank()) it.copy(state = "state") else it }
    return loadout.core.manifest.ManifestAssembler.assembleWithoutFiles(draft.copy(manifest = draft.manifest.copy(layout = layout)))
}
