package io.github.josemiguelo.postinstaller.cli

import io.github.josemiguelo.postinstaller.core.detect.Detection
import io.github.josemiguelo.postinstaller.core.exec.KommandProcessRunner
import io.github.josemiguelo.postinstaller.core.exec.ProcessRunner
import io.github.josemiguelo.postinstaller.core.manifest.ManifestLoader
import io.github.josemiguelo.postinstaller.core.model.Manifest
import io.github.josemiguelo.postinstaller.core.model.SystemInfo
import io.github.josemiguelo.postinstaller.core.engine.StatusEngine
import io.github.josemiguelo.postinstaller.core.engine.VersionChecker
import io.github.josemiguelo.postinstaller.core.model.MachineState
import io.github.josemiguelo.postinstaller.core.model.ScriptState
import io.github.josemiguelo.postinstaller.core.state.StateStore
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

    /**
     * Re-run all version checks, merge in any script results from this run,
     * write the state file, and return the new state.
     */
    fun refreshAndWriteState(
        manifest: Manifest,
        system: SystemInfo,
        scriptResults: Map<String, ScriptState> = emptyMap(),
    ): MachineState {
        val previous = stateStore.read(system.machine)
        val engine = StatusEngine(VersionChecker(runner, repoRoot.toString()), runner, repoRoot)
        val state = runBlocking { engine.refresh(manifest, system, previous, scriptResults) }
        // Keep updatedAt (and git history) stable when nothing real changed.
        if (previous != null && state.copy(updatedAt = previous.updatedAt) == previous) {
            return previous
        }
        stateStore.write(state)
        return state
    }
}
