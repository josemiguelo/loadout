package loadout.core.manifest

import okio.FileSystem
import okio.Path

/**
 * The `layout fragments` globs, on `/`-separated paths relative to the
 * repo root. `*` matches within one segment, `?` one character, `**` any
 * number of segments. Wildcards never match a segment starting with `.`:
 * a dot entry (`.loadout.yaml`, `.chezmoitemplates`) matches only when the
 * pattern spells the dot. `.git` is never entered.
 */
object Glob {
    private val WILDCARD = Regex("[*?]")

    /** Why [pattern] can't be a layout path or glob, or null when it can. */
    fun problem(pattern: String): String? = when {
        pattern.isBlank() -> "is empty"
        pattern.startsWith("/") -> "is absolute; layout paths are relative to the repo root"
        pattern.split('/').any { it == ".." } -> "leaves the repo (..)"
        pattern.split('/').any { it.isEmpty() } -> "has an empty path segment"
        else -> null
    }

    fun hasWildcard(pattern: String): Boolean = WILDCARD.containsMatchIn(pattern)

    fun matches(pattern: String, path: String): Boolean =
        matchSegments(pattern.split('/'), path.split('/'))

    /** Repo files [pattern] matches, path-sorted. */
    fun expand(fs: FileSystem, repoRoot: Path, pattern: String): List<Path> {
        val segments = pattern.split('/')
        val literal = segments.takeWhile { !hasWildcard(it) }
        val base = literal.fold(repoRoot) { dir, segment -> dir / segment }
        if (literal.size == segments.size) {
            return if (fs.metadataOrNull(base)?.isRegularFile == true) listOf(base) else emptyList()
        }
        if (fs.metadataOrNull(base)?.isDirectory != true) return emptyList()
        val files = mutableListOf<Path>()
        walk(fs, base, files)
        return files
            .filter { matches(pattern, relative(repoRoot, it)) }
            .sortedBy { it.toString() }
    }

    fun relative(repoRoot: Path, path: Path): String =
        path.toString().removePrefix(repoRoot.toString()).trimStart('/')

    private fun walk(fs: FileSystem, dir: Path, out: MutableList<Path>) {
        for (child in fs.list(dir)) {
            val metadata = fs.metadataOrNull(child) ?: continue
            when {
                metadata.isDirectory -> if (child.name != ".git") walk(fs, child, out)
                metadata.isRegularFile -> out += child
            }
        }
    }

    private fun matchSegments(pattern: List<String>, path: List<String>): Boolean {
        if (pattern.isEmpty()) return path.isEmpty()
        val head = pattern.first()
        if (head == "**") {
            // Zero segments, or one more (never a dot entry) and try again.
            return matchSegments(pattern.drop(1), path) ||
                (path.isNotEmpty() && !path.first().startsWith(".") && matchSegments(pattern, path.drop(1)))
        }
        if (path.isEmpty()) return false
        return matchSegment(head, path.first()) && matchSegments(pattern.drop(1), path.drop(1))
    }

    private fun matchSegment(pattern: String, segment: String): Boolean {
        if (segment.startsWith(".") && !pattern.startsWith(".")) return false
        val regex = buildString {
            for (c in pattern) {
                when (c) {
                    '*' -> append("[^/]*")
                    '?' -> append("[^/]")
                    else -> append(Regex.escape(c.toString()))
                }
            }
        }
        return Regex(regex).matches(segment)
    }
}
