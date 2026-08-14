package io.github.josemiguelo.postinstaller.cli

import io.github.josemiguelo.postinstaller.core.detect.Detection
import io.github.josemiguelo.postinstaller.core.exec.KommandProcessRunner
import io.github.josemiguelo.postinstaller.core.exec.ProcessRunner
import io.github.josemiguelo.postinstaller.core.manifest.ManifestLoader
import io.github.josemiguelo.postinstaller.core.model.Manifest
import io.github.josemiguelo.postinstaller.core.model.PackageManager
import io.github.josemiguelo.postinstaller.core.model.SystemInfo
import io.github.josemiguelo.postinstaller.core.state.StateStore
import okio.FileSystem
import okio.Path
import okio.Path.Companion.toPath

/** Shared services and resolved global options, built once by the root command. */
class AppContext(
    val repoRoot: Path,
    val manifestPath: Path,
    val machineOverride: String?,
    val pmOverride: PackageManager?,
    val verbose: Boolean,
) {
    val fs: FileSystem = FileSystem.SYSTEM
    val runner: ProcessRunner = KommandProcessRunner()
    val stateStore: StateStore by lazy { StateStore(fs, repoRoot) }
    val detection: Detection by lazy { Detection(runner, fs) }

    fun loadManifest(): Manifest = ManifestLoader.load(fs, manifestPath)

    fun detectSystem(): SystemInfo = detection.detectSystem(machineOverride, pmOverride)
}
