package loadout.core.manifest

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import loadout.core.model.MachineConfig
import loadout.core.model.Manifest
import loadout.core.model.MachineGroup
import loadout.core.model.Program
import loadout.core.model.ScriptStep
import loadout.core.model.scriptEntry

/**
 * A program file in YAML: the file's name is the program's name, and its
 * top-level keys are the program's fields. A `scripts` mapping defines the
 * repo scripts the program owns, each named by its key.
 */
object YamlProgram {
    private val json = Json { ignoreUnknownKeys = false }

    /** The program in [text] and the scripts its file defines (name -> step); the caller names it by file. */
    fun read(text: String, label: String): Pair<Program, Map<String, ScriptStep>> {
        val root = YamlDocument.parse(text, label)
        val fields = JsonObject(root - "scripts")
        val program = decode(Program.serializer(), fields, label)
        val scripts = (root["scripts"] ?: JsonObject(emptyMap())).let { element ->
            (element as? JsonObject ?: throw ManifestException("$label: scripts must be a mapping of script names to definitions"))
                .mapValues { (scriptName, definition) ->
                    decode(ScriptStep.serializer(), definition, "$label: scripts.$scriptName")
                }
        }
        return program to scripts
    }

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, element: JsonElement, label: String): T =
        try {
            json.decodeFromJsonElement(serializer, element)
        } catch (e: Exception) {
            throw ManifestException("Failed to parse $label: ${e.message}")
        }
}

/**
 * A machine or profile file in YAML. Top-level `extends` is a list of
 * profiles, `data` is the machine-wide data table, and every other key is a
 * program (or a script-only group) with `install_with` (the variant it uses)
 * and `scripts` (the scripts opted into).
 */
object YamlMachine {
    private val entryFields = setOf("install_with", "scripts")

    fun read(text: String, label: String, errors: MutableList<String>): MachineConfig {
        val root = YamlDocument.parse(text, label)
        var extends = emptyList<String>()
        var data = MachineData.EMPTY
        val groups = linkedMapOf<String, MachineGroup>()
        val pm = linkedMapOf<String, String>()
        val scripts = mutableListOf<String>()
        val scriptGroup = mutableMapOf<String, String>()

        for ((key, value) in root) {
            when (key) {
                "extends" -> extends = strings(value, "$label: extends", errors)
                "data" -> {
                    val table = value as? JsonObject
                    if (table == null) errors += "$label: data must be a mapping of keys to values"
                    else data = MachineData.merge(data, YamlDocument.typed(table) as JsonObject)
                }
                else -> {
                    val entry = value as? JsonObject
                    if (entry == null) {
                        errors += "$label: $key must be a mapping (install_with, scripts)"
                        continue
                    }
                    for (field in entry.keys - entryFields) {
                        errors += "$label: $key has unknown key '$field' (install_with, scripts)"
                    }
                    val variant = entry["install_with"]?.let { element ->
                        (element as? JsonPrimitive)?.takeIf { it.isString }?.content
                            ?: run {
                                errors += "$label: $key install_with is a variant name (install_with: omarchy)"
                                null
                            }
                    }
                    val entryScripts = entry["scripts"]?.let { strings(it, "$label: $key scripts", errors) }.orEmpty()
                    if (variant != null) {
                        pm[key] = variant
                    }
                    groups[key] = MachineGroup(
                        install = variant?.let { mapOf(key to it) }.orEmpty(),
                        scripts = entryScripts,
                    )
                    for (entryScript in entryScripts) {
                        val name = scriptEntry(entryScript).first
                        val previous = scriptGroup.put(name, key)
                        if (previous != null) {
                            errors += "$label: script '$name' is opted into twice ([$previous] and [$key])"
                        } else {
                            scripts += entryScript
                        }
                    }
                }
            }
        }
        return MachineConfig(
            extends = extends,
            pm = pm,
            scripts = scripts,
            data = data,
            groups = groups,
            label = label,
        )
    }

    private fun strings(element: JsonElement, what: String, errors: MutableList<String>): List<String> {
        val array = element as? JsonArray
        if (array == null) {
            errors += "$what is a list of strings"
            return emptyList()
        }
        val items = array.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        if (items.size != array.size) errors += "$what is a list of strings"
        return items
    }
}

/**
 * Whole-document YAML manifests: a `*.loadout.yaml` fragment (installers,
 * programs, scripts and outdated sources, in named sections) and the root
 * `loadout.yaml` (meta, layout, data, and the same sections). The sections
 * decode into the [Manifest] model that every reader shares.
 */
object YamlManifest {
    /** The sections a fragment file may hold, and the root file may hold too. */
    val fragmentSections: Set<String> = setOf("installers", "programs", "scripts", "outdated")

    private val json = Json { ignoreUnknownKeys = false }

    /** A `*.loadout.yaml` fragment: only the [fragmentSections] are allowed. */
    fun fragment(text: String, label: String): Manifest {
        val doc = YamlDocument.parse(text, label)
        val unknown = doc.keys - fragmentSections
        if (unknown.isNotEmpty()) {
            throw ManifestException(
                "$label: unknown section '${unknown.sorted().first()}' " +
                    "(a fragment holds installers, programs, scripts and outdated)",
            )
        }
        return decode(doc, label)
    }

    /** The root file: its `meta` and `layout`, its `data` table, and any fragment sections. */
    fun root(text: String, label: String): Manifest {
        val doc = YamlDocument.parse(text, label)
        val data = (doc["data"] as? JsonObject)?.let { YamlDocument.typed(it) as JsonObject } ?: JsonObject(emptyMap())
        return decode(JsonObject(doc - "data"), label).copy(data = data)
    }

    private fun decode(doc: JsonObject, label: String): Manifest = try {
        json.decodeFromJsonElement(Manifest.serializer(), doc)
    } catch (e: Exception) {
        throw ManifestException("Failed to parse $label: ${e.message}")
    }
}
