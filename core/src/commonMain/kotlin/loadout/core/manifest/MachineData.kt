package loadout.core.manifest

import com.akuleshov7.ktoml.Toml
import com.akuleshov7.ktoml.tree.nodes.TomlKeyValueArray
import com.akuleshov7.ktoml.tree.nodes.TomlKeyValuePrimitive
import com.akuleshov7.ktoml.tree.nodes.TomlNode
import com.akuleshov7.ktoml.tree.nodes.TomlTable
import com.akuleshov7.ktoml.tree.nodes.pairs.values.TomlValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The free-form `[data]` tables: `loadout.toml` declares every key and its
 * default, machine and base files override them, and chezmoi templates read
 * the same files. Read from ktoml's tree (the serializable model can't hold
 * free-form tables), kept as JSON elements.
 */
object MachineData {
    val EMPTY: JsonObject = JsonObject(emptyMap())

    /** The document's top-level `[data]` table, or null when it has none. */
    fun read(toml: Toml, text: String): JsonObject? =
        toml.tomlParser.parseString(text).children
            .firstOrNull { it is TomlTable && it.name == "data" }
            ?.let(::table)

    /** [over] on top of [base]: tables merge key by key, anything else (lists too) replaces. */
    fun merge(base: JsonObject, over: JsonObject): JsonObject = JsonObject(
        base + over.mapValues { (key, value) ->
            val under = base[key]
            if (under is JsonObject && value is JsonObject) merge(under, value) else value
        },
    )

    /**
     * Every key of [data] must be declared in [defaults] with the same kind
     * (string, boolean, number, list, table); errors name the dotted key.
     */
    fun validate(defaults: JsonObject, data: JsonObject, label: String, prefix: String = ""): List<String> =
        data.flatMap { (key, value) ->
            val path = prefix + key
            val declared = defaults[key]
            when {
                declared == null ->
                    listOf("$label: [data] key '$path' is not declared in loadout.toml [data]")
                kind(declared) != kind(value) ->
                    listOf("$label: [data] key '$path' is a ${kind(value)}, but loadout.toml declares a ${kind(declared)}")
                declared is JsonObject && value is JsonObject -> validate(declared, value, label, "$path.")
                else -> emptyList()
            }
        }

    /**
     * Dotted keys [a] and [b] both set to different values — where two
     * profiles of one `extends` list disagree. Tables are compared key by
     * key; anything else (lists too) must be equal.
     */
    fun conflicts(a: JsonObject, b: JsonObject, prefix: String = ""): List<String> =
        a.keys.intersect(b.keys).sorted().flatMap { key ->
            val left = a.getValue(key)
            val right = b.getValue(key)
            when {
                left is JsonObject && right is JsonObject -> conflicts(left, right, "$prefix$key.")
                left != right -> listOf("$prefix$key")
                else -> emptyList()
            }
        }

    /** [data] as dotted `key = value` lines, sorted, for `explain`. */
    fun lines(data: JsonObject, prefix: String = ""): List<Pair<String, String>> =
        data.entries.sortedBy { it.key }.flatMap { (key, value) ->
            if (value is JsonObject) lines(value, "$prefix$key.") else listOf("$prefix$key" to value.toString())
        }

    private fun kind(element: JsonElement): String = when (element) {
        is JsonObject -> "table"
        is JsonArray -> "list"
        is JsonPrimitive -> when {
            element.isString -> "string"
            element.content == "true" || element.content == "false" -> "boolean"
            else -> "number"
        }
    }

    /** A TOML table node as JSON (nested tables become objects). */
    fun table(node: TomlNode): JsonObject = JsonObject(
        node.children.mapNotNull { child ->
            when (child) {
                is TomlTable -> child.name to table(child)
                is TomlKeyValuePrimitive -> child.name to element(child.value.content)
                is TomlKeyValueArray -> child.name to element(child.value.content)
                else -> null
            }
        }.toMap(),
    )

    fun element(content: Any?): JsonElement = when (content) {
        is TomlValue -> element(content.content)
        is List<*> -> JsonArray(content.map(::element))
        is String -> JsonPrimitive(content)
        is Boolean -> JsonPrimitive(content)
        is Number -> JsonPrimitive(content)
        null -> JsonNull
        else -> JsonPrimitive(content.toString())
    }
}
