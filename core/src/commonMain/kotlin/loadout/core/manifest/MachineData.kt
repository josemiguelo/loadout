package loadout.core.manifest

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The free-form `data` tables: `loadout.yaml` declares every key and its
 * default, machine and profile files override them, and chezmoi templates read
 * the same files. Kept as JSON elements, because the serializable model can't
 * hold free-form tables.
 */
object MachineData {
    val EMPTY: JsonObject = JsonObject(emptyMap())

    /** [over] on top of [base]: tables merge key by key, anything else (lists too) replaces. */
    fun merge(base: JsonObject, over: JsonObject): JsonObject = JsonObject(
        base + over.mapValues { (key, value) ->
            val under = base[key]
            if (under is JsonObject && value is JsonObject) merge(under, value) else value
        },
    )

    /**
     * Every key of data must be declared in [defaults] with the same kind
     * (string, boolean, number, list, table); errors name the dotted key.
     */
    fun validate(defaults: JsonObject, data: JsonObject, label: String, prefix: String = ""): List<String> =
        data.flatMap { (key, value) ->
            val path = prefix + key
            val declared = defaults[key]
            when {
                declared == null ->
                    listOf("$label: data key '$path' is not declared in loadout.yaml")
                kind(declared) != kind(value) ->
                    listOf("$label: data key '$path' is a ${kind(value)}, but loadout.yaml declares a ${kind(declared)}")
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

    /** data as dotted `key: value` lines, sorted, for `explain`. */
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
}
