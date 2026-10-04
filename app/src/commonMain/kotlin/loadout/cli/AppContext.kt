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
    val manifestName: String,
    val machineOverride: String?,
    val verbose: Boolean,
) {
    val fs: FileSystem = FileSystem.SYSTEM
    val runner: ProcessRunner = KommandProcessRunner()
    /** The root file's validated layout, read alone, without loading the repo. */
    val layout: RepoLayout by lazy { ManifestLoader.readLayout(fs, repoRoot, manifestName) }
    val stateStore: StateStore by lazy { StateStore(fs, repoRoot, layout.state) }
    val detection: Detection by lazy { Detection(runner, fs) }

    fun loadManifest(): Manifest = ManifestLoader.loadRepo(fs, repoRoot, manifestName)

    fun detectSystem(): SystemInfo = detection.detectSystem(machineOverride)

    /** How manifest commands run on [system]: declaring file's directory, LOADOUT_* env. */
    fun frame(system: SystemInfo): CommandFrame =
        CommandFrame.of(fs.canonicalize(repoRoot).toString(), system, layout.configs)

    /** chezmoi over the `layout configs` directory; null when the repo has none. */
    val configs: ConfigEngine? by lazy {
        layout.configs?.let { ConfigEngine(runner, "${fs.canonicalize(repoRoot)}/$it") }
    }

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
