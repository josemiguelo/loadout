package loadout.cli

import loadout.core.LoadoutException
import loadout.core.platform.envVar
import loadout.core.platform.selfExecutable
import okio.FileSystem
import okio.Path
import okio.Path.Companion.toPath

class HomeNotFoundException(message: String) : LoadoutException(message)

/**
 * loadout's share directory: the DSL and Gradle plugin (`maven/`), the
 * Gradle wrapper a new repo gets (`gradle/`) and their `VERSION`, installed
 * beside the binary by install.sh. `LOADOUT_HOME` names another one.
 */
object LoadoutHome {
    fun find(fs: FileSystem): Path {
        val home = envVar("LOADOUT_HOME")?.toPath()
            // <prefix>/bin/loadout -> <prefix>/share/loadout
            ?: selfExecutable()?.toPath()?.parent?.parent?.let { it / "share" / "loadout" }
        if (home == null || !fs.exists(home / "VERSION")) {
            throw HomeNotFoundException(
                "loadout's share directory is missing (${home ?: "LOADOUT_HOME is unset"}); " +
                    "reinstall with: loadout self-upgrade",
            )
        }
        return fs.canonicalize(home)
    }
}
