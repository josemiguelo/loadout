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
    private val stateDir: Path = repoRoot / "state"

    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    private val json = Json {
        prettyPrint = true
        prettyPrintIndent = "  "
        encodeDefaults = true
        ignoreUnknownKeys = true
    }

    fun pathFor(machine: String): Path = stateDir / "$machine.json"

    fun read(machine: String): MachineState? {
        val path = pathFor(machine)
        if (!fs.exists(path)) return null
        return json.decodeFromString<MachineState>(fs.read(path) { readUtf8() })
    }

    /** All machine states in the repo, keyed by machine name, sorted by name. */
    fun readAll(): Map<String, MachineState> {
        if (!fs.exists(stateDir)) return emptyMap()
        return fs.list(stateDir)
            .filter { it.name.endsWith(".json") }
            .sortedBy { it.name }
            .mapNotNull { path ->
                runCatching {
                    json.decodeFromString<MachineState>(fs.read(path) { readUtf8() })
                }.getOrNull()
            }
            .associateBy { it.machine }
    }

    fun write(state: MachineState) {
        fs.createDirectories(stateDir)
        val text = json.encodeToString(MachineState.serializer(), state) + "\n"
        fs.write(pathFor(state.machine)) { writeUtf8(text) }
    }
}
