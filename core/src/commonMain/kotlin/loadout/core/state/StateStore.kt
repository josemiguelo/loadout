package loadout.core.state

import loadout.core.model.MachineState
import kotlinx.serialization.json.Json
import okio.FileSystem
import okio.Path

/**
 * Reads and writes `state/<machine>.json` files inside the config repo.
 * Each machine only ever writes its own file; all files are read for diffing.
 */
class StateStore(
    private val fs: FileSystem,
    repoRoot: Path,
) {
    companion object {
        /** Highest state-file schema this build understands. */
        const val SCHEMA_VERSION: Int = 1
    }

    private val stateDir: Path = repoRoot / "state"

    /** Warnings from the most recent read/readAll (e.g. files written by a newer loadout). */
    var lastWarnings: List<String> = emptyList()
        private set

    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    private val json = Json {
        prettyPrint = true
        prettyPrintIndent = "  "
        encodeDefaults = true
        ignoreUnknownKeys = true
    }

    fun pathFor(machine: String): Path = stateDir / "$machine.json"

    fun read(machine: String): MachineState? {
        lastWarnings = emptyList()
        val path = pathFor(machine)
        if (!fs.exists(path)) return null
        return accept(json.decodeFromString<MachineState>(fs.read(path) { readUtf8() }), path)
    }

    /** All machine states in the repo, keyed by machine name, sorted by name. */
    fun readAll(): Map<String, MachineState> {
        lastWarnings = emptyList()
        if (!fs.exists(stateDir)) return emptyMap()
        return fs.list(stateDir)
            .filter { it.name.endsWith(".json") }
            .sortedBy { it.name }
            .mapNotNull { path ->
                runCatching {
                    json.decodeFromString<MachineState>(fs.read(path) { readUtf8() })
                }.getOrNull()?.let { accept(it, path) }
            }
            .associateBy { it.machine }
    }

    /**
     * A schemaVersion above ours means a newer loadout wrote the file; skip it
     * rather than misinterpret it. Older/equal schemas load via defaults and
     * ignored unknown keys.
     */
    private fun accept(state: MachineState, path: Path): MachineState? {
        if (state.schemaVersion > SCHEMA_VERSION) {
            lastWarnings = lastWarnings +
                "state/${path.name} was written by a newer loadout (schema ${state.schemaVersion} > $SCHEMA_VERSION) — ignoring it; upgrade loadout to see this machine"
            return null
        }
        return state
    }

    fun write(state: MachineState) {
        fs.createDirectories(stateDir)
        val text = json.encodeToString(MachineState.serializer(), state) + "\n"
        fs.write(pathFor(state.machine)) { writeUtf8(text) }
    }
}
