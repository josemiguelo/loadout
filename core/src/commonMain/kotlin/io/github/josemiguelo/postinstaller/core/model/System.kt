package io.github.josemiguelo.postinstaller.core.model

enum class OsFamily(val id: String) {
    LINUX("linux"),
    MACOS("macos");

    companion object {
        fun fromId(id: String): OsFamily? = entries.firstOrNull { it.id == id }
    }
}

/**
 * Package managers the tool can verify the presence of. When a machine's
 * mapping uses one of these ids, install-time validation probes that the
 * binary actually exists on the machine. Custom install keys (script
 * variants) are not probed.
 */
enum class PackageManager(val id: String, val probeCommand: String) {
    BREW("brew", "brew"),
    DNF("dnf", "dnf"),
    APT("apt", "apt-get"),
    PACMAN("pacman", "pacman");

    companion object {
        fun fromId(id: String): PackageManager? = entries.firstOrNull { it.id == id }
    }
}

data class SystemInfo(
    val machine: String,
    val os: OsFamily,
    val distro: String?,
    val arch: String,
)
