package loadout.core.manifest

import com.akuleshov7.ktoml.Toml
import com.akuleshov7.ktoml.TomlInputConfig
import loadout.core.TOOL_VERSION
import loadout.core.model.INSTALL_FILE_PREFIX
import loadout.core.model.InstallVariant
import loadout.core.model.MachineConfig
import loadout.core.model.Manifest
import loadout.core.model.Meta
import loadout.core.model.Program
import loadout.core.model.Template
import loadout.core.model.VersionCheck
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
        val installers = root.installers.toMutableMap()
        val programs = root.programs.toMutableMap()
        val scripts = root.scripts.toMutableMap()
        val machines = mutableMapOf<String, MachineConfig>()

        if (root.machines.isNotEmpty()) {
            errors += "$manifestName: [machines.*] sections are not allowed; " +
                "machine configs live in $MACHINES_DIR/<name>.toml"
        }

        val templates = root.templates.toMutableMap()

        // Fragments may be organized into arbitrary subfolders; the folder
        // structure is purely cosmetic. Deterministic order: sorted by path.
        for (path in fragmentFiles(fs, repoRoot)) {
            val label = path.toString().removePrefix(repoRoot.toString()).trimStart('/')
            val fragment = parseRaw(fs.read(path) { readUtf8() }, label)
            if (fragment.meta != Meta()) {
                errors += "$label: [meta] is only allowed in $manifestName"
            }
            if (fragment.machines.isNotEmpty()) {
                errors += "$label: [machines.*] sections are not allowed; " +
                    "machine configs live in $MACHINES_DIR/<name>.toml"
            }
            for ((name, installer) in fragment.installers) {
                if (installers.put(name, installer) != null) {
                    errors += "duplicate installer '$name' (redefined in $label)"
                }
            }
            for ((name, program) in fragment.programs) {
                if (programs.put(name, program) != null) {
                    errors += "duplicate program '$name' (redefined in $label)"
                }
            }
            for ((name, script) in fragment.scripts) {
                if (scripts.put(name, script) != null) {
                    errors += "duplicate script '$name' (redefined in $label)"
                }
            }
            for ((name, template) in fragment.templates) {
                if (templates.put(name, template) != null) {
                    errors += "duplicate template '$name' (redefined in $label)"
                }
            }
        }

        for (path in tomlFiles(fs, repoRoot / MACHINES_DIR)) {
            val name = path.name.removeSuffix(".toml")
            machines[name] = try {
                toml.decodeFromString<MachineConfig>(fs.read(path) { readUtf8() })
            } catch (e: Exception) {
                val hint = if (e.message?.contains("Cannot decode the key [scripts]") == true) {
                    "\nhint: the top-level `scripts = [...]` array must appear ABOVE any table " +
                        "header like [pm] — TOML assigns later top-level keys to the preceding table"
                } else {
                    ""
                }
                throw ManifestException("Failed to parse $MACHINES_DIR/${path.name}: ${e.message}$hint")
            }
        }

        if (errors.isNotEmpty()) {
            throw ManifestException("Invalid manifest:\n" + errors.joinToString("\n") { "  - $it" })
        }

        val merged = expandVia(
            expandTemplates(
                root.copy(
                    installers = installers,
                    programs = programs,
                    scripts = scripts,
                    machines = machines,
                    templates = templates,
                ),
            ),
        )
        validate(merged)

        // Referenced files can only be checked against the actual repo, not in parse().
        val missingFiles = mutableListOf<String>()
        fun requireFile(command: String?, label: String) {
            if (command == null || !command.startsWith(INSTALL_FILE_PREFIX)) return
            // Anything after the first space is arguments, not path.
            val file = command.removePrefix(INSTALL_FILE_PREFIX).substringBefore(' ')
            if (!fs.exists(repoRoot / file)) {
                missingFiles += "  - $label: file '$file' not found in the repo"
            }
        }
        for ((name, script) in merged.scripts) {
            if (script.file != null && !fs.exists(repoRoot / script.file!!)) {
                missingFiles += "  - scripts.$name: file '${script.file}' not found in the repo"
            }
            requireFile(script.check, "scripts.$name.check")
        }
        for ((name, program) in merged.programs) {
            requireFile(program.version?.command, "programs.$name.version")
            for (key in program.install.keys) {
                val resolved = merged.resolveInstall(name, key)
                requireFile(resolved.command, "programs.$name.install.$key")
                // The version fallback is already validated once above.
                if (resolved.check != program.version) {
                    requireFile(resolved.check?.command, "programs.$name.install.$key check")
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
        val manifest = expandVia(expandTemplates(parseRaw(text, "manifest")))
        validate(manifest)
        return manifest
    }

    /**
     * Expand each program's `via` shorthand into install variants: every entry
     * becomes an install key of the same name using that installer with all
     * defaults. An explicit `install.<key>` table for the same key wins — it
     * still resolves through the installer its key names, so it refines rather
     * than replaces the mechanics.
     */
    private fun expandVia(manifest: Manifest): Manifest {
        if (manifest.programs.values.all { it.via.isEmpty() }) return manifest
        val errors = mutableListOf<String>()
        val programs = manifest.programs.mapValues { (name, program) ->
            if (program.via.isEmpty()) return@mapValues program
            val expanded = mutableMapOf<String, InstallVariant>()
            for (entry in program.via) {
                if (entry !in manifest.installers) {
                    errors += "programs.$name via references unknown installer '$entry'"
                } else if (entry !in program.install && expanded.put(entry, InstallVariant(installer = entry)) != null) {
                    errors += "programs.$name via lists '$entry' twice"
                }
            }
            program.copy(via = emptyList(), install = expanded + program.install)
        }
        if (errors.isNotEmpty()) {
            throw ManifestException("Invalid manifest:\n" + errors.joinToString("\n") { "  - $it" })
        }
        return manifest.copy(programs = programs)
    }

    /**
     * Resolve templates into full programs: each template's `packages` entry
     * becomes a program, and every program declaring `template = "<name>"` has
     * the template's fields merged in. `{name}` is substituted with the
     * program name in all string fields; explicit/override fields win, with
     * install tables merged per key.
     */
    private fun expandTemplates(manifest: Manifest): Manifest {
        if (manifest.templates.isEmpty() && manifest.programs.values.none { it.template != null }) {
            return manifest
        }
        val errors = mutableListOf<String>()
        val programs = mutableMapOf<String, Program>()

        // Programs, expanding `template = ...` references in place.
        for ((name, program) in manifest.programs) {
            val templateName = program.template
            if (templateName == null) {
                programs[name] = program
                continue
            }
            val template = manifest.templates[templateName]
            if (template == null) {
                errors += "programs.$name references unknown template '$templateName'"
                continue
            }
            programs[name] = expandProgram(name, template, program)
        }

        // Templates' own package lists.
        for ((templateName, template) in manifest.templates) {
            for (override in template.overrides.keys) {
                if (override !in template.packages) {
                    errors += "templates.$templateName.overrides.$override is not in its packages list"
                }
                if (template.overrides.getValue(override).template != null) {
                    errors += "templates.$templateName.overrides.$override may not set 'template'"
                }
            }
            for (pkg in template.packages) {
                val expanded = expandProgram(pkg, template, template.overrides[pkg])
                if (programs.put(pkg, expanded) != null) {
                    errors += "duplicate program '$pkg' (expanded from template '$templateName')"
                }
            }
        }

        if (errors.isNotEmpty()) {
            throw ManifestException("Invalid manifest:\n" + errors.joinToString("\n") { "  - $it" })
        }
        return manifest.copy(programs = programs)
    }

    private fun expandProgram(name: String, template: Template, override: Program?): Program {
        fun sub(s: String) = s.replace("{name}", name)
        fun sub(c: VersionCheck) = VersionCheck(sub(c.command), sub(c.regex))
        fun sub(v: InstallVariant) = v.copy(
            pkg = v.pkg?.let(::sub),
            command = v.command?.let(::sub),
            check = v.check?.let(::sub),
            outdated = v.outdated?.let(::sub),
        )
        return Program(
            description = override?.description.orEmpty(),
            template = null,
            tags = override?.tags.orEmpty(),
            dependsOn = override?.dependsOn.orEmpty(),
            version = override?.version?.let(::sub) ?: template.version?.let(::sub),
            via = (template.via + override?.via.orEmpty()).distinct(),
            install = template.install.mapValues { sub(it.value) } +
                (override?.install.orEmpty()).mapValues { sub(it.value) },
        )
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

    /** All fragment files under manifest.d, any folder depth, path-sorted. */
    private fun fragmentFiles(fs: FileSystem, repoRoot: Path): List<Path> {
        val dir = repoRoot / FRAGMENTS_DIR
        if (!fs.exists(dir)) return emptyList()
        return fs.listRecursively(dir)
            .filter { it.name.endsWith(".toml") && fs.metadataOrNull(it)?.isRegularFile == true }
            .sortedBy { it.toString() }
            .toList()
    }

    private fun validate(manifest: Manifest) {
        val errors = mutableListOf<String>()

        manifest.meta.minToolVersion?.let {
            if (!Regex("""\d+(\.\d+)*""").matches(it)) {
                errors += "meta.min-tool-version '$it' is not a dotted version number (e.g. \"0.2.0\")"
            }
        }

        for ((name, installer) in manifest.installers) {
            if (installer.check != null && installer.regex == null) {
                errors += "installers.$name has a check but no regex"
            }
            if (installer.outdated != null && installer.regex == null) {
                errors += "installers.$name has an outdated command but no regex"
            }
        }

        for ((name, program) in manifest.programs) {
            for (dep in program.dependsOn) {
                if (dep !in manifest.programs) {
                    errors += "programs.$name depends-on unknown program '$dep'"
                }
            }
            for ((key, variant) in program.install) {
                if (variant.installer != null && variant.installer !in manifest.installers) {
                    errors += "programs.$name.install.$key references unknown installer '${variant.installer}'"
                    continue
                }
                val installer = manifest.installers[variant.installer ?: key]
                if (variant.command == null && installer?.install == null) {
                    errors += "programs.$name.install.$key resolves to no install command " +
                        "(set 'command', or reference an installer with an install pattern)"
                }
                if (variant.check != null && (variant.regex ?: installer?.regex) == null) {
                    errors += "programs.$name.install.$key has a check but no regex " +
                        "(set 'regex', or reference an installer that has one)"
                }
                if (variant.outdated != null && (variant.regex ?: installer?.regex) == null) {
                    errors += "programs.$name.install.$key has an outdated command but no regex " +
                        "(set 'regex', or reference an installer that has one)"
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
            val scriptNames = config.scripts.map { it.substringBefore(' ') }
            scriptNames.groupBy { it }.filterValues { it.size > 1 }.keys.forEach { dup ->
                errors += "$MACHINES_DIR/$machine.toml lists script '$dup' more than once"
            }
            for ((scriptName, args) in config.scriptArgs()) {
                val script = manifest.scripts[scriptName]
                if (script == null) {
                    errors += "$MACHINES_DIR/$machine.toml scripts references unknown script '$scriptName'"
                } else if (args.isNotEmpty() && script.file == null) {
                    errors += "$MACHINES_DIR/$machine.toml passes arguments to script '$scriptName', " +
                        "which is an inline `run` script — arguments require a `file` script"
                }
            }
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
