package loadout.cli

import loadout.core.TOOL_VERSION
import loadout.core.exec.ProcessRunner
import loadout.core.manifest.ManifestLoader
import loadout.core.platform.envVar

/**
 * Knows whether this binary is behind the latest published release. The one
 * deliberate self-knowledge carve-out: loadout is infrastructure, not repo
 * payload, so "can this machine keep participating?" is part of observing it.
 * Lookups fail soft (offline -> null) and the cached form costs ~0.05s, so
 * `status` can afford it on every refresh.
 */
object SelfVersion {
    private const val API = "https://api.github.com/repos/josemiguelo/loadout/releases/latest"

    /**
     * Latest published release ("0.4.0"), or null when unknown (offline and
     * no cache). [cached] uses a ~6h on-disk cache; `outdated` passes false
     * for a fresh answer.
     */
    fun latest(runner: ProcessRunner, cached: Boolean = true): String? {
        val cacheDir = (envVar("XDG_CACHE_HOME") ?: ((envVar("HOME") ?: return null) + "/.cache")) + "/loadout"
        val cache = "$cacheDir/latest-release"
        if (cached) {
            val fresh = runner.capture("find '$cache' -mmin -360 2>/dev/null").stdout.isNotBlank()
            if (fresh) {
                runner.capture("cat '$cache'").stdout.trim().ifBlank { null }?.let { return it }
            }
        }
        val out = runner.capture("curl -fsSL --max-time 5 '$API'").stdout
        val fetched = Regex("\"tag_name\": *\"v([0-9][0-9.]*)\"").find(out)?.groupValues?.getOrNull(1)
        return if (fetched != null) {
            runner.capture("mkdir -p '$cacheDir' && printf '%s\\n' '$fetched' > '$cache'")
            fetched
        } else {
            // Stale beats nothing when the API is unreachable.
            runner.capture("cat '$cache' 2>/dev/null").stdout.trim().ifBlank { null }
        }
    }

    /** The latest release this binary is behind, or null when current/unknown. */
    fun behind(runner: ProcessRunner, cached: Boolean = true): String? =
        latest(runner, cached)?.takeIf { !ManifestLoader.versionAtLeast(TOOL_VERSION, it) }
}
