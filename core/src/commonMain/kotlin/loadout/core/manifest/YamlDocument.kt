package loadout.core.manifest

import com.charleskorn.kaml.Yaml
import com.charleskorn.kaml.YamlList
import com.charleskorn.kaml.YamlMap
import com.charleskorn.kaml.YamlNode
import com.charleskorn.kaml.YamlNull
import com.charleskorn.kaml.YamlScalar
import com.charleskorn.kaml.YamlTaggedNode
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A YAML document as the JSON tree the manifest readers share. Mappings become
 * objects and sequences arrays. Every scalar stays text, as written, so
 * commands and regexes can't change type; [typed] gives the `data` table the
 * booleans and numbers [MachineData] declares.
 */
object YamlDocument {
    private val DECIMAL = Regex("-?[0-9]+\\.[0-9]+")

    /** [text] as a JSON object; a document that is not a mapping is an error. */
    fun parse(text: String, label: String): JsonObject {
        // kaml rejects a document with no content; an empty file is a mapping with nothing in it.
        if (text.lineSequence().all { it.isBlank() || it.trimStart().startsWith("#") }) return JsonObject(emptyMap())
        val node = try {
            Yaml.default.parseToYamlNode(text)
        } catch (e: Exception) {
            throw ManifestException("Failed to parse $label: ${e.message}")
        }
        if (node is YamlNull) return JsonObject(emptyMap())
        return node.toJson() as? JsonObject
            ?: throw ManifestException("Failed to parse $label: the document must be a mapping of keys to values")
    }

    /**
     * A `data` table with its scalars typed: `true`/`false` booleans, numbers
     * (whole or decimal), and text for the rest, as `data` declares them.
     */
    fun typed(element: JsonElement): JsonElement = when (element) {
        is JsonObject -> JsonObject(element.mapValues { (_, value) -> typed(value) })
        is JsonArray -> JsonArray(element.map(::typed))
        is JsonPrimitive -> when {
            element.isString && element.content == "true" -> JsonPrimitive(true)
            element.isString && element.content == "false" -> JsonPrimitive(false)
            element.isString && element.content.toLongOrNull() != null -> JsonPrimitive(element.content.toLong())
            element.isString && DECIMAL.matches(element.content) -> JsonPrimitive(element.content.toDouble())
            else -> element
        }
        else -> element
    }

    private fun YamlNode.toJson(): JsonElement = when (this) {
        is YamlMap -> JsonObject(entries.entries.associate { (key, value) -> key.content to value.toJson() })
        is YamlList -> JsonArray(items.map { it.toJson() })
        is YamlScalar -> JsonPrimitive(content)
        is YamlNull -> JsonNull
        is YamlTaggedNode -> innerNode.toJson()
        else -> throw ManifestException("unsupported YAML construct at ${path.toHumanReadableString()}")
    }
}
