package loadout.core.detect

import loadout.core.exec.ProcessRunner
import loadout.core.model.OsFamily
import loadout.core.model.SystemInfo
import loadout.core.platform.currentHostname
import loadout.core.platform.unameInfo
import okio.FileSystem
import okio.Path.Companion.toPath

class Detection(
    private val runner: ProcessRunner,
    private val fs: FileSystem,
) {
    fun detectSystem(machineOverride: String? = null): SystemInfo {
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

    /** Whether [binary] exists on this machine's PATH. */
    fun isBinaryAvailable(binary: String): Boolean =
        runner.capture("command -v $binary").success
}
