package loadout.dsl

import kotlinx.serialization.json.JsonObject
import loadout.core.LoadoutException
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
class Registry {
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

    companion object {
        /** Where declarations land. */
        var current: Registry = Registry()
            internal set
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
