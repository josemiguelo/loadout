package loadout.cli

import loadout.core.detect.Detection
import loadout.core.exec.KommandProcessRunner
import loadout.core.exec.ProcessRunner
import loadout.core.manifest.ManifestLoader
import loadout.core.model.Manifest
import loadout.core.model.SystemInfo
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
    val stateStore: StateStore by lazy { StateStore(fs, repoRoot) }
    val detection: Detection by lazy { Detection(runner, fs) }

    fun loadManifest(): Manifest = ManifestLoader.loadRepo(fs, repoRoot, manifestName)

    fun detectSystem(): SystemInfo = detection.detectSystem(machineOverride)

    /** What each failing script check printed during the last refresh. */
    var lastScriptDetail: Map<String, String> = emptyMap()
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
        val engine = StatusEngine(VersionChecker(runner, repoRoot.toString()), runner, repoRoot)
        val state = engine.refresh(manifest, system, previous, scriptResults)
        lastScriptDetail = engine.lastScriptDetail
        // Keep updatedAt (and git history) stable when nothing real changed.
        if (previous != null && state.copy(updatedAt = previous.updatedAt) == previous) {
            return previous
        }
        stateStore.write(state)
        return state
    }
}
