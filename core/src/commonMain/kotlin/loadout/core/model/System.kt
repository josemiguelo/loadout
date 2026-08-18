package loadout.core.model

enum class OsFamily(val id: String) {
    LINUX("linux"),
    MACOS("macos");

    companion object {
        fun fromId(id: String): OsFamily? = entries.firstOrNull { it.id == id }
    }
}

data class SystemInfo(
    val machine: String,
    val os: OsFamily,
    val distro: String?,
    val arch: String,
)
