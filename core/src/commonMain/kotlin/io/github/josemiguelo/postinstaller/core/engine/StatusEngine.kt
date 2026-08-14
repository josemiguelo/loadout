package io.github.josemiguelo.postinstaller.core.engine

import io.github.josemiguelo.postinstaller.core.TOOL_VERSION
import io.github.josemiguelo.postinstaller.core.model.MachineState
import io.github.josemiguelo.postinstaller.core.model.Manifest
import io.github.josemiguelo.postinstaller.core.model.SystemInfo
import io.github.josemiguelo.postinstaller.core.platform.nowIso

/** Builds this machine's [MachineState] by running every version check. */
class StatusEngine(private val checker: VersionChecker) {
    suspend fun refresh(
        manifest: Manifest,
        system: SystemInfo,
        previous: MachineState?,
    ): MachineState = MachineState(
        machine = system.machine,
        os = system.os.id,
        distro = system.distro,
        arch = system.arch,
        packageManager = system.packageManager?.id,
        toolVersion = TOOL_VERSION,
        updatedAt = nowIso(),
        programs = checker.checkAll(manifest.programs),
        // Script run history is owned by the install/run flow; keep what we had.
        scripts = previous?.scripts.orEmpty(),
    )
}
