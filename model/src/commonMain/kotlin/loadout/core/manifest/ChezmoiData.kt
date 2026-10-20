package loadout.core.manifest

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import loadout.core.model.Manifest

/**
 * What a repo's chezmoi templates get from loadout, both written by
 * `loadout compile` beside the lock and checked against it on every load,
 * so the dotfiles never render from data the manifests don't say:
 *
 * - `<configs>/.chezmoidata/loadout.json`, which chezmoi loads into every
 *   template as `.loadout`: `loadout.defaults` is every declared key with
 *   its default, `loadout.machines.<hostname>` each machine's merged table.
 * - `<configs>/.chezmoitemplates/loadout/machine`, the partial that picks
 *   this host's table: `includeTemplate "loadout/machine" . | fromJson`.
 *
 * The lock's own layout stays loadout's: these two are the contract.
 */
object ChezmoiData {
    /** The data file, relative to the repo root, for a repo with [configs]. */
    fun path(configs: String): String = "$configs/.chezmoidata/loadout.json"

    /** The partial, relative to the repo root, for a repo with [configs]. */
    fun partialPath(configs: String): String = "$configs/.chezmoitemplates/loadout/machine"

    /** This host's table, or the defaults on a host the repo doesn't declare. */
    const val PARTIAL: String =
        "{{- /* Written by loadout compile; don't edit. This host's settings (.chezmoidata/loadout.json), " +
            "or the defaults on a host the repo doesn't declare. Use: includeTemplate \"loadout/machine\" . | fromJson */ -}}\n" +
            "{{- get .loadout.machines .chezmoi.hostname | default .loadout.defaults | toJson -}}\n"

    /** Each file compile writes for a repo with [configs], with its content. */
    fun files(manifest: Manifest, configs: String): Map<String, String> =
        mapOf(path(configs) to render(manifest), partialPath(configs) to PARTIAL)

    private val json = Json {
        prettyPrint = true
        prettyPrintIndent = "  "
    }

    fun render(manifest: Manifest): String {
        val loadout = JsonObject(
            mapOf(
                "defaults" to manifest.data,
                "machines" to JsonObject(manifest.machines.entries.sortedBy { it.key }.associate { it.key to it.value.data }),
            ),
        )
        return json.encodeToString(JsonObject.serializer(), JsonObject(mapOf("loadout" to loadout))) + "\n"
    }
}
