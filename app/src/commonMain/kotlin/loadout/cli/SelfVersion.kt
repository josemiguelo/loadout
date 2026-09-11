package loadout.cli

import loadout.core.TOOL_VERSION
import loadout.core.exec.ProcessRunner
import loadout.core.manifest.ManifestLoader
import loadout.core.platform.envVar
import kotlin.time.Clock
import kotlin.time.ExperimentalTime
import okio.FileSystem
import okio.Path.Companion.toPath

/**
 * Knows whether this binary is behind the latest published release. The one
 * deliberate self-knowledge carve-out: loadout is infrastructure, not repo
 * payload, so "can this machine keep participating?" is part of observing it.
 * Lookups fail soft (offline -> null) and the cached form costs ~0.05s, so
 * `status` can afford it on every refresh.
 */
object SelfVersion {
    private const val API = "https://api.github.com/repos/josemiguelo/loadout/releases/latest"
    private const val CACHE_MILLIS = 6L * 60 * 60 * 1000

    @OptIn(ExperimentalTime::class)
    private fun now() = Clock.System.now().toEpochMilliseconds()

    /**
     * Latest published release ("0.4.0"), or null when unknown (offline and
     * no cache). [cached] uses a ~6h on-disk cache; `outdated` passes false
     * for a fresh answer.
     */
    fun latest(runner: ProcessRunner, fs: FileSystem, cached: Boolean = true): String? {
        val cacheDir = ((envVar("XDG_CACHE_HOME") ?: ((envVar("HOME") ?: return null) + "/.cache")) + "/loadout")
            .toPath()
        val cache = cacheDir / "latest-release"
        // The cache is a file, so read it as one: shelling out to find/cat/
        // mkdir cost three processes per status and pasted $HOME into a shell.
        fun cached(): String? =
            runCatching { fs.read(cache) { readUtf8() } }.getOrNull()?.trim()?.ifBlank { null }

        if (cached) {
            val writtenAt = fs.metadataOrNull(cache)?.lastModifiedAtMillis
            val fresh = writtenAt != null && now() - writtenAt < CACHE_MILLIS
            if (fresh) cached()?.let { return it }
        }
        val out = runner.capture("curl -fsSL --max-time 5 '$API'").stdout
        val fetched = Regex("\"tag_name\": *\"v([0-9][0-9.]*)\"").find(out)?.groupValues?.getOrNull(1)
        if (fetched == null) return cached() // stale beats nothing when the API is unreachable
        runCatching {
            fs.createDirectories(cacheDir)
            fs.write(cache) { writeUtf8(fetched + "\n") }
        }
        return fetched
    }

    /** The latest release this binary is behind, or null when current/unknown. */
    fun behind(runner: ProcessRunner, fs: FileSystem, cached: Boolean = true): String? =
        latest(runner, fs, cached)?.takeIf { !ManifestLoader.versionAtLeast(TOOL_VERSION, it) }
}
