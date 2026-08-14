package io.github.josemiguelo.postinstaller.core.model

enum class OsFamily(val id: String) {
    LINUX("linux"),
    MACOS("macos");

    companion object {
        fun fromId(id: String): OsFamily? = entries.firstOrNull { it.id == id }
    }
}

/**
 * Package managers the tool knows how to probe for. The manifest's `install`
 * table is an open string map, so users can key commands by managers not
 * listed here; those are only usable via an explicit `--pm` override.
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

/** Key in a program's `install` map for a package-manager-independent command. */
const val INSTALL_SCRIPT_KEY: String = "script"

data class SystemInfo(
    val machine: String,
    val os: OsFamily,
    val distro: String?,
    val arch: String,
    val packageManager: PackageManager?,
)
