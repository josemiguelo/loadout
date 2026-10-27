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

    /**
     * This machine's table, or the defaults on a machine nothing declares. The machine is the one
     * loadout runs as: `LOADOUT_MACHINE` (`--machine`'s variable) when set, else the hostname. A
     * machine this repo's data lacks may be a child repo's (contract 18): its table then comes from
     * the lock of the repo loadout runs on, `LOADOUT_REPO`, so a parent's templates render for it
     * under a plain `chezmoi apply` too. The partial reads loadout's own lock layout, which no user
     * template may: compile writes both, and every load checks the partial is this one.
     */
    const val PARTIAL: String =
        "{{- /* Written by loadout compile; don't edit. This machine's settings (.chezmoidata/loadout.json): " +
            "LOADOUT_MACHINE's, else the hostname's; for a machine this repo doesn't declare, the table in the lock " +
            "of LOADOUT_REPO (a child repo declaring it), else the defaults. " +
            "Use: includeTemplate \"loadout/machine\" . | fromJson */ -}}\n" +
            "{{- \$name := env \"LOADOUT_MACHINE\" | default .chezmoi.hostname -}}\n" +
            "{{- \$table := get .loadout.machines \$name -}}\n" +
            "{{- \$repo := env \"LOADOUT_REPO\" -}}\n" +
            "{{- if and (not \$table) \$repo -}}\n" +
            "{{-   \$lock := joinPath \$repo \"loadout.lock.json\" -}}\n" +
            "{{-   if stat \$lock -}}\n" +
            "{{-     \$table = get (get (include \$lock | fromJson).manifest.machines \$name | default dict) \"data\" -}}\n" +
            "{{-   end -}}\n" +
            "{{- end -}}\n" +
            "{{- \$table | default .loadout.defaults | toJson -}}\n"

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
