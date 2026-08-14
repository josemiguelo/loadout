package io.github.josemiguelo.postinstaller.core.manifest

import com.akuleshov7.ktoml.Toml
import com.akuleshov7.ktoml.TomlInputConfig
import io.github.josemiguelo.postinstaller.core.model.Manifest
import kotlinx.serialization.decodeFromString
import okio.FileSystem
import okio.Path

class ManifestException(message: String) : Exception(message)

object ManifestLoader {
    private val toml = Toml(
        inputConfig = TomlInputConfig(ignoreUnknownNames = true),
    )

    fun load(fs: FileSystem, path: Path): Manifest {
        if (!fs.exists(path)) {
            throw ManifestException("Manifest not found: $path")
        }
        val text = fs.read(path) { readUtf8() }
        return parse(text)
    }

    fun parse(text: String): Manifest {
        val manifest = try {
            toml.decodeFromString<Manifest>(text)
        } catch (e: Exception) {
            throw ManifestException("Failed to parse manifest: ${e.message}")
        }
        validate(manifest)
        return manifest
    }

    private fun validate(manifest: Manifest) {
        val errors = mutableListOf<String>()

        for ((name, program) in manifest.programs) {
            for (dep in program.dependsOn) {
                if (dep !in manifest.programs) {
                    errors += "programs.$name depends-on unknown program '$dep'"
                }
            }
        }

        for ((name, script) in manifest.scripts) {
            for (ref in script.after) {
                val valid = when {
                    ref.startsWith("programs.") -> ref.removePrefix("programs.") in manifest.programs
                    ref.startsWith("scripts.") -> ref.removePrefix("scripts.") in manifest.scripts
                    else -> false
                }
                if (!valid) {
                    errors += "scripts.$name after references unknown step '$ref'"
                }
            }
        }

        findCycle(manifest.programs.mapValues { it.value.dependsOn })?.let { cycle ->
            errors += "dependency cycle among programs: ${cycle.joinToString(" -> ")}"
        }
        findCycle(
            manifest.scripts.mapValues { (_, s) ->
                s.after.filter { it.startsWith("scripts.") }.map { it.removePrefix("scripts.") }
            },
        )?.let { cycle ->
            errors += "ordering cycle among scripts: ${cycle.joinToString(" -> ")}"
        }

        if (errors.isNotEmpty()) {
            throw ManifestException("Invalid manifest:\n" + errors.joinToString("\n") { "  - $it" })
        }
    }

    /** Returns one cycle as a list of node names, or null if the graph is acyclic. */
    private fun findCycle(edges: Map<String, List<String>>): List<String>? {
        val visiting = mutableSetOf<String>()
        val done = mutableSetOf<String>()
        val stack = mutableListOf<String>()

        fun visit(node: String): List<String>? {
            if (node in done) return null
            if (node in visiting) return stack.drop(stack.indexOf(node)) + node
            visiting += node
            stack += node
            for (next in edges[node].orEmpty()) {
                if (next in edges) visit(next)?.let { return it }
            }
            stack.removeLast()
            visiting -= node
            done += node
            return null
        }

        for (node in edges.keys) {
            visit(node)?.let { return it }
        }
        return null
    }

    /**
     * Programs in dependency order (dependencies before dependents).
     * Assumes [validate] passed, i.e. the graph is acyclic.
     */
    fun installOrder(manifest: Manifest, names: Collection<String> = manifest.programs.keys): List<String> {
        val result = mutableListOf<String>()
        val seen = mutableSetOf<String>()

        fun visit(name: String) {
            if (name in seen || name !in manifest.programs) return
            seen += name
            manifest.programs.getValue(name).dependsOn.forEach(::visit)
            result += name
        }

        names.forEach(::visit)
        return result
    }
}
