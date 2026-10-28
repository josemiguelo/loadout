package loadout.cli

import loadout.core.detect.Detection
import loadout.core.exec.CommandFrame
import loadout.core.exec.KommandProcessRunner
import loadout.core.exec.ProcessRunner
import loadout.core.manifest.ManifestLoader
import loadout.core.model.Manifest
import loadout.core.model.RepoLayout
import loadout.core.model.SystemInfo
import loadout.core.engine.ConfigEngine
import loadout.core.engine.StatusEngine
import loadout.core.engine.VersionChecker
import loadout.core.model.MachineState
import loadout.core.model.ScriptState
import loadout.core.state.StateStore
import kotlinx.coroutines.runBlocking
import okio.FileSystem
import okio.Path

/** Shared services and resolved global options, built once by the root command. */
class AppContext(
    val repoRoot: Path,
    val machineOverride: String?,
    val verbose: Boolean,
) {
    val fs: FileSystem = FileSystem.SYSTEM
    val runner: ProcessRunner = KommandProcessRunner()
    /**
     * What the lock's layout decides (folders, the parent, chezmoi's sources),
     * read once. [reloadLayout] reads it again: a pull or a compile can move
     * them (a repo that renames its configs folder), and everything after
     * must use the new names.
     */
    private inner class FromLayout {
        /** The lock's layout, read without the checks a full load makes. */
        val layout: RepoLayout by lazy { ManifestLoader.readLayout(fs, repoRoot) }
        val stateStore: StateStore by lazy { StateStore(fs, repoRoot, layout.state) }
        val parentRoot: Path? by lazy { ManifestLoader.parentRoot(fs, repoRoot, layout) }
        val parentStateStore: StateStore? by lazy {
            layout.parent?.let { parent -> parentRoot?.let { StateStore(fs, it, parent.state, readOnly = true) } }
        }
        val configs: ConfigEngine? by lazy {
            val root = fs.canonicalize(repoRoot)
            val sources = listOfNotNull(
                layout.parent?.configs?.let { parentConfigs ->
                    parentRoot?.let { ConfigEngine.Source("$it/$parentConfigs", "parent ${layout.parent?.name}") }
                },
                layout.configs?.let { ConfigEngine.Source("$root/$it") },
            )
            if (sources.isEmpty()) return@lazy null
            val env = mapOf("LOADOUT_REPO" to root.toString(), "LOADOUT_MACHINE" to detectSystem().machine)
            ConfigEngine(runner, sources, env)
        }
    }

    private var fromLayout = FromLayout()

    /** Forget the layout read so far; the next use reads the lock again (sync, after its pulls and compile). */
    fun reloadLayout() {
        fromLayout = FromLayout()
    }

    /** The lock's layout, read without the checks a full load makes. */
    val layout: RepoLayout get() = fromLayout.layout
    val stateStore: StateStore get() = fromLayout.stateStore

    /** A child repo's parent's state, read for the fleet view only. */
    private val parentStateStore: StateStore? get() = fromLayout.parentStateStore

    /**
     * Every machine's state the fleet view shows: this repo's, and for a child
     * its parent's machines too (a name in both is this repo's).
     */
    fun fleetStates(): Map<String, MachineState> = parentStateStore?.readAll().orEmpty() + stateStore.readAll()

    /** Warnings from the last [fleetStates] (or [stateStore]) read. */
    val fleetWarnings: List<String>
        get() = parentStateStore?.lastWarnings.orEmpty() + stateStore.lastWarnings
    val detection: Detection by lazy { Detection(runner, fs) }

    /** The repo's manifest as this machine sees it (its script variants picked). */
    fun loadManifest(): Manifest = ManifestLoader.loadRepo(fs, repoRoot).forMachine(detectSystem().machine)

    fun detectSystem(): SystemInfo = detection.detectSystem(machineOverride)

    /** A child repo's parent checkout (contract 18), or null. */
    val parentRoot: Path? get() = fromLayout.parentRoot

    /** How manifest commands run on [system]: declaring file's directory (a parent's in the parent), LOADOUT_* env. */
    fun frame(system: SystemInfo): CommandFrame =
        CommandFrame.of(
            fs.canonicalize(repoRoot).toString(),
            system,
            layout.configs,
            parentRoot?.toString(),
            layout.parent?.configs,
        )

    /**
     * chezmoi over the `layout configs` directory, and for a child repo its
     * parent's too (the parent's first); null when neither has one. chezmoi
     * sees the repo and machine loadout runs as, so the templates' partial
     * agrees with `--repo` and `--machine`.
     */
    val configs: ConfigEngine? get() = fromLayout.configs

    /** The observer every refresh uses: programs, scripts and configs. */
    fun statusEngine(system: SystemInfo): StatusEngine {
        val frame = frame(system)
        return StatusEngine(VersionChecker(runner, frame), runner, frame, configs)
    }

    /** Why configs went unchecked during the last refresh, or null. */
    var lastConfigsDown: String? = null
        private set

    /** What each failing script check printed during the last refresh. */
    var lastScriptDetail: Map<String, String> = emptyMap()
        private set

    /** Tools whose checks couldn't run during the last refresh (see StatusEngine.lastToolsDown). */
    var lastToolsDown: List<loadout.core.engine.ToolDown> = emptyList()
        private set

    /**
     * Re-run all version checks, merge in any script results from this run,
     * write the state file, and return the new state.
     */
    suspend fun refreshAndWriteState(
        manifest: Manifest,
        system: SystemInfo,
        scriptResults: Map<String, ScriptState> = emptyMap(),
    ): MachineState {
        val previous = stateStore.read(system.machine)
        val engine = statusEngine(system)
        val state = engine.refresh(manifest, system, previous, scriptResults)
        lastScriptDetail = engine.lastScriptDetail
        lastToolsDown = engine.lastToolsDown
        lastConfigsDown = engine.lastConfigsDown
        // Keep updatedAt (and git history) stable when nothing real changed.
        if (previous != null && state.copy(updatedAt = previous.updatedAt) == previous) {
            return previous
        }
        stateStore.write(state)
        return state
    }
}
