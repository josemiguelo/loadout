package loadout.core.manifest

import loadout.core.TOOL_VERSION
import loadout.core.model.Manifest
import loadout.core.model.RepoLayout
import loadout.core.versionAtLeast
import okio.FileSystem
import okio.Path

/**
 * Reads a config repo's lock: the only manifest the binary knows. The
 * manifests themselves are Kotlin, compiled by `loadout compile`; the lock
 * is refused when it's missing, written by a newer loadout, below the repo's
 * version floor, or older than the sources it was compiled from, and so is
 * a repo whose chezmoi data or partial ([ChezmoiData]) doesn't match it.
 */
object ManifestLoader {
    /** The repo's layout, from the lock alone (no staleness or file checks). */
    fun readLayout(fs: FileSystem, repoRoot: Path): RepoLayout = readLock(fs, repoRoot).manifest.layout

    /**
     * The repo's manifest, checked: the lock is current with its sources and
     * every `file:` path it names exists. Machines see their own script
     * variants through [Manifest.forMachine].
     */
    fun loadRepo(fs: FileSystem, repoRoot: Path): Manifest {
        val lock = readLock(fs, repoRoot)
        val manifest = lock.manifest
        val hash = LockFile.sourcesHash(fs, repoRoot, manifest.layout.sources)
        if (hash != lock.sources) {
            throw ManifestException("the manifests changed since ${LockFile.NAME} was written — run: loadout compile")
        }
        manifest.layout.configs?.let { configs ->
            for ((path, expected) in ChezmoiData.files(manifest, configs)) {
                val current = (repoRoot / path).takeIf(fs::exists)?.let { file -> fs.read(file) { readUtf8() } }
                if (current != expected) {
                    val what = if (current == null) "is missing" else "doesn't match ${LockFile.NAME}"
                    throw ManifestException("$path $what — run: loadout compile")
                }
            }
        }
        val missing = ManifestAssembler.checkFiles(manifest, fs, repoRoot)
        if (missing.isNotEmpty()) {
            throw ManifestException("Invalid manifest:\n" + missing.joinToString("\n") { "  - $it" })
        }
        return manifest
    }

    private fun readLock(fs: FileSystem, repoRoot: Path): Lock {
        val path = repoRoot / LockFile.NAME
        if (!fs.exists(path)) {
            throw ManifestException("no ${LockFile.NAME} in $repoRoot — run: loadout compile")
        }
        val lock = LockFile.decode(fs.read(path) { readUtf8() })
        // A newer minor's DSL may write what this binary would misread; a
        // patch release never changes what a lock means.
        if (!versionAtLeast(minor(TOOL_VERSION), minor(lock.toolVersion))) {
            throw ToolTooOldException(
                "${LockFile.NAME} was compiled by loadout ${lock.toolVersion} (you have $TOOL_VERSION) — " +
                    "run: loadout self-upgrade",
                required = minor(lock.toolVersion) + ".0",
            )
        }
        lock.manifest.meta.minToolVersion?.let { required ->
            if (!versionAtLeast(TOOL_VERSION, required)) {
                throw ToolTooOldException(
                    "this config repo requires loadout >= $required (you have $TOOL_VERSION) — " +
                        "run: loadout self-upgrade",
                    required = required,
                )
            }
        }
        return lock
    }

    /** Whether this binary is too old for the repo's lock; read alone, like [readLayout]. */
    fun toolTooOld(fs: FileSystem, repoRoot: Path): Boolean =
        runCatching { readLock(fs, repoRoot) }.exceptionOrNull() is ToolTooOldException

    private fun minor(version: String): String = version.split('.').take(2).joinToString(".")
}

/** The lock needs a newer loadout: at least [required]. `sync` upgrades on it. */
class ToolTooOldException(message: String, val required: String) : ManifestException(message)
