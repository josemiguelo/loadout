package loadout.core.manifest

import com.akuleshov7.ktoml.Toml
import com.akuleshov7.ktoml.TomlInputConfig
import loadout.core.TOOL_VERSION
import loadout.core.model.INSTALL_FILE_PREFIX
import loadout.core.model.MachineConfig
import loadout.core.model.Manifest
import loadout.core.model.Meta
import kotlinx.serialization.decodeFromString
import okio.FileSystem
import okio.Path

class ManifestException(message: String) : Exception(message)

object ManifestLoader {
    /** Directory of extra manifest fragments merged into the root manifest. */
    const val FRAGMENTS_DIR: String = "manifest.d"

    /** Directory of per-machine config files; `<name>.toml` configures machine `<name>`. */
    const val MACHINES_DIR: String = "machines"

    private val toml = Toml(
        inputConfig = TomlInputConfig(ignoreUnknownNames = true),
    )

    /**
     * Load the repo's full manifest: the root file, plus `.toml` fragments in
     * `manifest.d` (programs/scripts, no `[meta]`), plus per-machine
     * `machines/<name>.toml` configs — the only place machine configs may live.
     * Everything is merged, then validated as one manifest.
     */
    fun loadRepo(fs: FileSystem, repoRoot: Path, manifestName: String = "manifest.toml"): Manifest {
        val rootPath = repoRoot / manifestName
        if (!fs.exists(rootPath)) {
            throw ManifestException("Manifest not found: $rootPath")
        }
        val root = parseRaw(fs.read(rootPath) { readUtf8() }, manifestName)

        // Fail before interpreting anything else: an older binary silently
        // ignores manifest keys it doesn't know, so the repo's declared floor
        // is the only guard against misreading a newer config.
        root.meta.minToolVersion?.let { required ->
            if (!versionAtLeast(TOOL_VERSION, required)) {
                throw ManifestException(
                    "this config repo requires loadout >= $required (you have $TOOL_VERSION) — " +
                        "upgrade loadout on this machine",
                )
            }
        }

        val errors = mutableListOf<String>()
        val programs = root.programs.toMutableMap()
        val scripts = root.scripts.toMutableMap()
        val machines = mutableMapOf<String, MachineConfig>()

        if (root.machines.isNotEmpty()) {
            errors += "$manifestName: [machines.*] sections are not allowed; " +
                "machine configs live in $MACHINES_DIR/<name>.toml"
        }

        for (path in tomlFiles(fs, repoRoot / FRAGMENTS_DIR)) {
            val fragment = parseRaw(fs.read(path) { readUtf8() }, "$FRAGMENTS_DIR/${path.name}")
            if (fragment.meta != Meta()) {
                errors += "$FRAGMENTS_DIR/${path.name}: [meta] is only allowed in $manifestName"
            }
            if (fragment.machines.isNotEmpty()) {
                errors += "$FRAGMENTS_DIR/${path.name}: [machines.*] sections are not allowed; " +
                    "machine configs live in $MACHINES_DIR/<name>.toml"
            }
            for ((name, program) in fragment.programs) {
                if (programs.put(name, program) != null) {
                    errors += "duplicate program '$name' (redefined in $FRAGMENTS_DIR/${path.name})"
                }
            }
            for ((name, script) in fragment.scripts) {
                if (scripts.put(name, script) != null) {
                    errors += "duplicate script '$name' (redefined in $FRAGMENTS_DIR/${path.name})"
                }
            }
        }

        for (path in tomlFiles(fs, repoRoot / MACHINES_DIR)) {
            val name = path.name.removeSuffix(".toml")
            machines[name] = try {
                toml.decodeFromString<MachineConfig>(fs.read(path) { readUtf8() })
            } catch (e: Exception) {
                throw ManifestException("Failed to parse $MACHINES_DIR/${path.name}: ${e.message}")
            }
        }

        if (errors.isNotEmpty()) {
            throw ManifestException("Invalid manifest:\n" + errors.joinToString("\n") { "  - $it" })
        }

        val merged = root.copy(programs = programs, scripts = scripts, machines = machines)
        validate(merged)

        // Referenced files can only be checked against the actual repo, not in parse().
        val missingFiles = mutableListOf<String>()
        for ((name, script) in merged.scripts) {
            if (script.file != null && !fs.exists(repoRoot / script.file!!)) {
                missingFiles += "  - scripts.$name: file '${script.file}' not found in the repo"
            }
        }
        for ((name, program) in merged.programs) {
            for ((key, value) in program.install) {
                if (value.startsWith(INSTALL_FILE_PREFIX)) {
                    // Anything after the first space is arguments, not path.
                    val file = value.removePrefix(INSTALL_FILE_PREFIX).substringBefore(' ')
                    if (!fs.exists(repoRoot / file)) {
                        missingFiles += "  - programs.$name.install.$key: file '$file' not found in the repo"
                    }
                }
            }
        }
        if (missingFiles.isNotEmpty()) {
            throw ManifestException("Invalid manifest:\n" + missingFiles.joinToString("\n"))
        }
        return merged
    }

    /** Parse and validate a single manifest document (no fragment/machine-file merging). */
    fun parse(text: String): Manifest {
        val manifest = parseRaw(text, "manifest")
        validate(manifest)
        return manifest
    }

    private fun parseRaw(text: String, label: String): Manifest = try {
        toml.decodeFromString<Manifest>(text)
    } catch (e: Exception) {
        throw ManifestException("Failed to parse $label: ${e.message}")
    }

    /** Numeric dotted-version comparison: is [current] >= [required]? */
    internal fun versionAtLeast(current: String, required: String): Boolean {
        val c = current.split('.').map { it.toIntOrNull() ?: 0 }
        val r = required.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(c.size, r.size)) {
            val a = c.getOrElse(i) { 0 }
            val b = r.getOrElse(i) { 0 }
            if (a != b) return a > b
        }
        return true
    }

    private fun tomlFiles(fs: FileSystem, dir: Path): List<Path> =
        if (fs.exists(dir)) {
            fs.list(dir).filter { it.name.endsWith(".toml") }.sortedBy { it.name }
        } else {
            emptyList()
        }

    private fun validate(manifest: Manifest) {
        val errors = mutableListOf<String>()

        manifest.meta.minToolVersion?.let {
            if (!Regex("""\d+(\.\d+)*""").matches(it)) {
                errors += "meta.min-tool-version '$it' is not a dotted version number (e.g. \"0.2.0\")"
            }
        }

        for ((name, program) in manifest.programs) {
            for (dep in program.dependsOn) {
                if (dep !in manifest.programs) {
                    errors += "programs.$name depends-on unknown program '$dep'"
                }
            }
        }

        for ((name, script) in manifest.scripts) {
            if ((script.file == null) == (script.run == null)) {
                errors += "scripts.$name must define exactly one of 'file' (repo path) or 'run' (inline command)"
            }
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

        for ((machine, config) in manifest.machines) {
            for ((programName, installKey) in config.pm) {
                val program = manifest.programs[programName]
                if (program == null) {
                    errors += "$MACHINES_DIR/$machine.toml references unknown program '$programName'"
                } else if (installKey !in program.install) {
                    errors += "$MACHINES_DIR/$machine.toml maps '$programName' to '$installKey', but " +
                        "programs.$programName.install has no '$installKey' entry " +
                        "(has: ${program.install.keys.sorted().joinToString()})"
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

    /**
     * Scripts ordered so that a script listed in another's `after` runs first.
     * Only script-to-script edges affect this order; `programs.*` references are
     * satisfied by installs always running before scripts.
     */
    fun scriptOrder(manifest: Manifest, names: Collection<String> = manifest.scripts.keys): List<String> {
        val result = mutableListOf<String>()
        val seen = mutableSetOf<String>()

        fun visit(name: String) {
            if (name in seen || name !in manifest.scripts) return
            seen += name
            manifest.scripts.getValue(name).after
                .filter { it.startsWith("scripts.") }
                .map { it.removePrefix("scripts.") }
                .forEach(::visit)
            result += name
        }

        names.forEach(::visit)
        return result
    }
}
