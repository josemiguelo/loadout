package loadout.core.manifest

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import loadout.core.model.Manifest
import okio.ByteString.Companion.encodeUtf8
import okio.Buffer
import okio.FileSystem
import okio.Path

/**
 * loadout.lock.json: a config repo's manifests, compiled. The DSL writes it
 * (`loadout compile`); the binary reads nothing else. It's generated, like
 * state, but committed: a fresh machine needs only the binary and a clone.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class Lock(
    /** Bumped only when an older binary could misread the file; see [LockFile.FORMAT]. Always written. */
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val format: Int = LockFile.FORMAT,
    /** The loadout version whose DSL wrote it. */
    val toolVersion: String,
    /** sha256 of the sources it was compiled from ([LockFile.sourcesHash]). */
    val sources: String,
    val manifest: Manifest,
)

object LockFile {
    const val NAME: String = "loadout.lock.json"

    /** The lock layout this binary writes and reads. */
    const val FORMAT: Int = 1

    @OptIn(ExperimentalSerializationApi::class)
    private val json = Json {
        prettyPrint = true
        prettyPrintIndent = "  "
        // Defaults are the model's: leaving them out keeps the lock short and
        // its diffs about what changed.
        encodeDefaults = false
        explicitNulls = false
    }

    fun encode(lock: Lock): String = json.encodeToString(Lock.serializer(), lock) + "\n"

    /**
     * The lock in [text]. A newer format is refused by name before anything
     * else is read, so an old binary says "upgrade" instead of failing on a
     * field it doesn't know.
     */
    fun decode(text: String, label: String = NAME): Lock {
        val tree = try {
            json.parseToJsonElement(text).jsonObject
        } catch (e: SerializationException) {
            throw ManifestException("$label is not valid JSON (${e.message}) — run: loadout compile")
        } catch (e: IllegalArgumentException) {
            throw ManifestException("$label is not a lock file — run: loadout compile")
        }
        val format = tree["format"]?.jsonPrimitive?.int ?: FORMAT
        if (format > FORMAT) {
            throw ManifestException("$label was written by a newer loadout (lock format $format) — run: loadout self-upgrade")
        }
        return try {
            json.decodeFromJsonElement(Lock.serializer(), tree)
        } catch (e: SerializationException) {
            throw ManifestException("$label can't be read (${e.message}) — run: loadout compile")
        }
    }

    /**
     * sha256 over every file the [globs] match: each one's repo-relative path
     * and content, in path order. The DSL stamps it into the lock and the
     * binary recomputes it, so an edit the lock hasn't seen is caught.
     */
    fun sourcesHash(fs: FileSystem, repoRoot: Path, globs: List<String>): String {
        val files = globs.flatMap { Glob.expand(fs, repoRoot, it) }.distinct().sortedBy { Glob.relative(repoRoot, it) }
        val buffer = Buffer()
        for (file in files) {
            buffer.write(Glob.relative(repoRoot, file).encodeUtf8())
            buffer.writeByte(0)
            fs.read(file) { buffer.writeAll(this) }
            buffer.writeByte(0)
        }
        return buffer.sha256().hex()
    }
}
