package io.github.josemiguelo.postinstaller.core.detect

import io.github.josemiguelo.postinstaller.core.exec.ProcessRunner
import io.github.josemiguelo.postinstaller.core.model.OsFamily
import io.github.josemiguelo.postinstaller.core.model.PackageManager
import io.github.josemiguelo.postinstaller.core.model.SystemInfo
import io.github.josemiguelo.postinstaller.core.platform.currentHostname
import io.github.josemiguelo.postinstaller.core.platform.unameInfo
import okio.FileSystem
import okio.Path.Companion.toPath

class Detection(
    private val runner: ProcessRunner,
    private val fs: FileSystem,
) {
    fun detectSystem(
        machineOverride: String? = null,
        pmOverride: PackageManager? = null,
    ): SystemInfo {
        val uname = unameInfo()
        val os = when (uname.sysname) {
            "Darwin" -> OsFamily.MACOS
            else -> OsFamily.LINUX
        }
        return SystemInfo(
            machine = machineOverride ?: currentHostname(),
            os = os,
            distro = if (os == OsFamily.LINUX) detectDistro() else null,
            arch = uname.machine,
            packageManager = pmOverride ?: detectPackageManager(),
        )
    }

    /** Distro id from /etc/os-release (e.g. "fedora", "ubuntu", "arch"). */
    fun detectDistro(): String? {
        val path = "/etc/os-release".toPath()
        if (!fs.exists(path)) return null
        return fs.read(path) { readUtf8() }
            .lineSequence()
            .firstOrNull { it.startsWith("ID=") }
            ?.removePrefix("ID=")
            ?.trim('"', '\'')
            ?.ifBlank { null }
    }

    /** First available package manager in priority order, or null if none found. */
    fun detectPackageManager(): PackageManager? =
        PackageManager.entries.firstOrNull { pm ->
            runner.capture("command -v ${pm.probeCommand}").success
        }
}
