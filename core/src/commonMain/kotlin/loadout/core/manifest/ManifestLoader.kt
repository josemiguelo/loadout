package loadout.core.manifest

import com.akuleshov7.ktoml.Toml
import com.akuleshov7.ktoml.TomlInputConfig
import loadout.core.LoadoutException
import loadout.core.TOOL_VERSION
import loadout.core.model.INSTALL_FILE_PREFIX
import loadout.core.model.InstallVariant
import loadout.core.model.Installer
import loadout.core.model.MachineConfig
import loadout.core.model.Manifest
import loadout.core.model.Meta
import loadout.core.model.Program
import loadout.core.model.RepoLayout
import loadout.core.model.VersionCheck
import loadout.core.model.scriptEntry
import kotlinx.serialization.decodeFromString
import okio.FileSystem
import okio.Path
import okio.Path.Companion.toPath

class ManifestException(message: String) : LoadoutException(message)

object ManifestLoader {
    /** The repo's root file: [meta], [layout], and optionally programs/scripts of its own. */
    const val ROOT_FILE: String = "loadout.toml"

    /** The 0.x root file; a repo that has it instead of [ROOT_FILE] is refused. */
    private const val LEGACY_ROOT_FILE: String = "manifest.toml"

    private val toml = Toml(
        inputConfig = TomlInputConfig(ignoreUnknownNames = true),
    )

    /**
     * The repo's validated `[layout]`, read from the root file alone, so the
     * state store can find its directory without loading the whole repo.
     */
    fun readLayout(fs: FileSystem, repoRoot: Path, manifestName: String = ROOT_FILE): RepoLayout =
        layoutOf(readRoot(fs, repoRoot, manifestName), manifestName)

    /**
     * Load the repo's full manifest: the root file, plus the fragment files
     * its `[layout] fragments` globs match (programs/scripts/installers/
     * outdated sources), plus per-machine `<machines>/<name>.toml` configs —
     * the only place machine configs may live. Everything is merged, then
     * validated as one manifest.
     */
    fun loadRepo(fs: FileSystem, repoRoot: Path, manifestName: String = ROOT_FILE): Manifest {
        val root = readRoot(fs, repoRoot, manifestName)
        val layout = layoutOf(root, manifestName)
        val machinesDir = layout.machines

        val errors = mutableListOf<String>()
        // Repo installers are collected on their own so duplicate detection
        // stays repo-vs-repo; the built-in library is merged under them at
        // the end (a repo definition of the same name replaces it).
        val installers = root.installers.toMutableMap()
        val programs = root.programs.toMutableMap()
        val scripts = root.scripts.toMutableMap()
        val machines = mutableMapOf<String, MachineConfig>()

        if (root.machines.isNotEmpty()) {
            errors += "$manifestName: [machines.*] sections are not allowed; " +
                "machine configs live in $machinesDir/<name>.toml"
        }

        val outdatedSources = root.outdated.toMutableMap()
        val machinePaths = machineFiles(fs, repoRoot / machinesDir)

        // Folder structure inside a glob's matches is cosmetic. Deterministic
        // order: the globs' order, path-sorted within one.
        for (path in fragmentFiles(fs, repoRoot, layout, manifestName, machinePaths, errors)) {
            val label = Glob.relative(repoRoot, path)
            val fragmentText = fs.read(path) { readUtf8() }
            val fragment = withOrigin(parseRaw(fragmentText, label), Glob.relative(repoRoot, path.parent!!))
            if (MachineData.read(toml, fragmentText) != null) {
                errors += "$label: [data] is only allowed in $manifestName and machine files"
            }
            if (fragment.meta != Meta()) {
                errors += "$label: [meta] is only allowed in $manifestName"
            }
            if (fragment.layout != null) {
                errors += "$label: [layout] is only allowed in $manifestName"
            }
            if (fragment.machines.isNotEmpty()) {
                errors += "$label: [machines.*] sections are not allowed; " +
                    "machine configs live in $machinesDir/<name>.toml"
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
            for ((name, source) in fragment.outdated) {
                if (outdatedSources.put(name, source) != null) {
                    errors += "duplicate outdated source '$name' (redefined in $label)"
                }
            }
        }

        // Machine files sit directly in the machines directory, so chezmoi
        // templates find one by hostname; the machine name is the file name.
        for (path in machinePaths) {
            val name = path.name.removeSuffix(".toml")
            val label = Glob.relative(repoRoot, path)
            if (path.parent != repoRoot / machinesDir) {
                errors += "$label: machine files live directly in $machinesDir/ (no subfolders)"
                continue
            }
            val machineText = fs.read(path) { readUtf8() }
            val parsed = try {
                val data = MachineData.read(toml, machineText) ?: MachineData.EMPTY
                errors += MachineData.validate(root.data, data, label)
                toml.decodeFromString<MachineConfig>(machineText).copy(data = data)
            } catch (e: Exception) {
                val hint = if (e.message?.contains("Cannot decode the key [scripts]") == true) {
                    "\nhint: the top-level `scripts = [...]` array must appear ABOVE any table " +
                        "header like [pm] — TOML assigns later top-level keys to the preceding table"
                } else {
                    ""
                }
                throw ManifestException("Failed to parse $label: ${e.message}$hint")
            }
            machines[name] = parsed
        }
        errors += flattenMachines(machines)
        // Every machine sees every declared key: defaults under its own.
        for ((name, config) in machines.toList()) machines[name] = config.copy(data = MachineData.merge(root.data, config.data))

        if (errors.isNotEmpty()) {
            throw ManifestException("Invalid manifest:\n" + errors.joinToString("\n") { "  - $it" })
        }

        val merged = expandVia(
            withBuiltinInstallers(
                root.copy(
                    installers = installers,
                    programs = programs,
                    scripts = scripts,
                    machines = machines,
                    outdated = outdatedSources,
                ),
            ),
        )
        validate(merged, machinesDir)

        // Referenced files can only be checked against the actual repo, not in
        // parse(). Each path is relative to its declaring file's directory
        // (origin) and must stay inside the repo.
        val missingFiles = mutableListOf<String>()
        fun requirePath(file: String, origin: String, label: String) {
            val where = if (origin.isEmpty()) "the repo root" else "$origin/"
            val relative = (if (origin.isEmpty()) file else "$origin/$file").toPath().normalized()
            when {
                relative.isAbsolute || relative.segments.firstOrNull() == ".." ->
                    missingFiles += "  - $label: file '$file' leaves the repo (paths are relative to $where)"
                !fs.exists(repoRoot / relative) ->
                    missingFiles += "  - $label: file '$file' not found (relative to $where)"
            }
        }
        fun requireFile(command: String?, origin: String, label: String) {
            if (command == null || !command.startsWith(INSTALL_FILE_PREFIX)) return
            // Anything after the first space is arguments, not path.
            requirePath(command.removePrefix(INSTALL_FILE_PREFIX).substringBefore(' '), origin, label)
        }
        for ((name, script) in merged.scripts) {
            script.file?.let { requirePath(it, script.origin, "scripts.$name") }
            requireFile(script.check, script.origin, "scripts.$name.check")
        }
        for ((name, source) in merged.outdated) {
            requireFile(source.command, source.origin, "outdated.$name")
            requireFile(source.upgrade, source.origin, "outdated.$name.upgrade")
        }
        for ((name, program) in merged.programs) {
            program.version?.let { requireFile(it.command, it.origin, "programs.$name.version") }
            for (key in program.install.keys) {
                val resolved = merged.resolveInstall(name, key)
                requireFile(resolved.command, resolved.commandOrigin, "programs.$name.install.$key")
                // The version fallback is already validated once above.
                if (resolved.check != program.version) {
                    resolved.check?.let { requireFile(it.command, it.origin, "programs.$name.install.$key check") }
                }
                resolved.outdated?.let { requireFile(it.command, it.origin, "programs.$name.install.$key outdated") }
                resolved.outdatedAll?.let { requireFile(it.command, it.origin, "programs.$name.install.$key outdated-all") }
                resolved.upgradeWith?.let { requireFile(it.command, it.origin, "programs.$name.install.$key upgrade") }
            }
        }
        if (missingFiles.isNotEmpty()) {
            throw ManifestException("Invalid manifest:\n" + missingFiles.joinToString("\n"))
        }
        // Bases are config inheritance, not machines: validated above, but
        // never observed, diffed, or converged.
        return merged.copy(machines = merged.machines.filterValues { !it.base })
    }

    /**
     * Parse and validate a single manifest document. TEST-ONLY (contract 10):
     * it skips fragment/machine-file merging and, unlike [loadRepo], tolerates
     * inline `[machines.*]` and cannot check that `file:` paths exist. It does
     * go through [withBuiltinInstallers], so install resolution — the thing
     * most tests are actually about — behaves exactly as in production.
     */
    fun parse(text: String): Manifest {
        val manifest = expandVia(withBuiltinInstallers(parseRaw(text, "manifest")))
        validate(manifest)
        return manifest
    }

    /**
     * Merge loadout's shipped installers UNDER the manifest's own: a repo
     * definition of the same name replaces the built-in, and what survived
     * is recorded for `explain`/`installers`. The one place this happens.
     */
    private fun withBuiltinInstallers(manifest: Manifest): Manifest {
        val builtins = InstallerLibrary.installers
        return manifest.copy(
            installers = builtins + manifest.installers,
            builtinInstallers = builtins.keys - manifest.installers.keys,
        )
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

    /** The installers in a standalone TOML document — used for the built-in library. */
    fun parseInstallers(text: String): Map<String, Installer> = parseRaw(text, "built-in installers").installers

    // Removed in 0.9.0. ktoml drops unknown keys, so without this a templated
    // manifest would load as an EMPTY program list — a machine's whole loadout
    // silently vanishing. Loud beats convenient.
    private val REMOVED_TEMPLATES = Regex("^\\s*\\[templates\\.|^\\s*template\\s*=", RegexOption.MULTILINE)

    private fun parseRaw(text: String, label: String): Manifest {
        if (REMOVED_TEMPLATES.containsMatchIn(text)) {
            throw ManifestException(
                "$label uses templates, removed in loadout 0.9.0 — declare each program " +
                    "explicitly (see the wiki), or pin an older loadout",
            )
        }
        return parseDocument(text, label)
    }

    /** Stamp every declared item with its file's repo-relative directory (contracts 4, 5). */
    private fun withOrigin(manifest: Manifest, origin: String): Manifest = manifest.copy(
        installers = manifest.installers.mapValues { it.value.copy(origin = origin) },
        programs = manifest.programs.mapValues { (_, p) ->
            p.copy(origin = origin, version = p.version?.copy(origin = origin))
        },
        scripts = manifest.scripts.mapValues { it.value.copy(origin = origin) },
        outdated = manifest.outdated.mapValues { it.value.copy(origin = origin) },
    )

    private fun parseDocument(text: String, label: String): Manifest = try {
        toml.decodeFromString<Manifest>(text)
    } catch (e: Exception) {
        throw ManifestException("Failed to parse $label: ${e.message}")
    }

    /** Numeric dotted-version comparison: is [current] >= [required]? */
    fun versionAtLeast(current: String, required: String): Boolean {
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

    /** All `.toml` files under [dir], path-sorted; loadRepo refuses any in a subfolder. */
    private fun machineFiles(fs: FileSystem, dir: Path): List<Path> {
        if (!fs.exists(dir)) return emptyList()
        return fs.listRecursively(dir)
            .filter { it.name.endsWith(".toml") && fs.metadataOrNull(it)?.isRegularFile == true }
            .sortedBy { it.toString() }
            .toList()
    }

    /**
     * Resolve `extends` chains in place: every config becomes its flattened
     * self ([pm] merged per key, child wins; `[data]` merged table by table,
     * child wins, lists replace; `scripts` union, a same-named child entry
     * replaces the base's), then base configs are removed —
     * downstream nothing knows inheritance existed. Returns errors.
     */
    private fun flattenMachines(machines: MutableMap<String, MachineConfig>): List<String> {
        val errors = mutableListOf<String>()
        for ((name, config) in machines) {
            val parent = config.extends ?: continue
            val target = machines[parent]
            when {
                target == null ->
                    errors += "machine '$name' extends unknown base '$parent'"
                !target.base ->
                    errors += "machine '$name' extends '$parent', which is not a base " +
                        "(shared config must live in a `base = true` file)"
            }
        }
        if (errors.isNotEmpty()) return errors

        val flattened = mutableMapOf<String, MachineConfig>()
        fun flatten(name: String, seen: List<String>): MachineConfig {
            flattened[name]?.let { return it }
            if (name in seen) {
                errors += "machine base cycle: ${(seen + name).joinToString(" -> ")}"
                return machines.getValue(name)
            }
            val config = machines.getValue(name)
            val parent = config.extends?.let { flatten(it, seen + name) } ?: run {
                flattened[name] = config
                return config
            }
            val childScripts = config.scriptArgs().keys
            val result = config.copy(
                pm = parent.pm + config.pm,
                data = MachineData.merge(parent.data, config.data),
                scripts = parent.scripts.filterNot { scriptEntry(it).first in childScripts } + config.scripts,
            )
            flattened[name] = result
            return result
        }
        for (name in machines.keys.toList()) {
            flatten(name, emptyList())
        }
        if (errors.isNotEmpty()) return errors
        machines.clear()
        // Bases stay (flattened) so validation covers them too; loadRepo
        // drops them from the returned manifest after validating.
        machines += flattened
        return errors
    }

    /**
     * The files the layout's fragment globs match: glob order, path-sorted
     * within one glob, each file once. A glob reaching the root file or a
     * machine file is an error (it would be read twice, as something else).
     */
    private fun fragmentFiles(
        fs: FileSystem,
        repoRoot: Path,
        layout: RepoLayout,
        manifestName: String,
        machinePaths: List<Path>,
        errors: MutableList<String>,
    ): List<Path> {
        val rootPath = repoRoot / manifestName
        val files = LinkedHashSet<Path>()
        for (pattern in layout.fragments) {
            for (path in Glob.expand(fs, repoRoot, pattern)) {
                when (path) {
                    rootPath -> errors += "[layout] fragments '$pattern' matches $manifestName itself"
                    in machinePaths ->
                        errors += "[layout] fragments '$pattern' matches machine file ${Glob.relative(repoRoot, path)}"
                    else -> files += path
                }
            }
        }
        return files.toList()
    }

    private fun readRoot(fs: FileSystem, repoRoot: Path, manifestName: String): Manifest {
        val rootPath = repoRoot / manifestName
        if (!fs.exists(rootPath)) {
            if (manifestName == ROOT_FILE && fs.exists(repoRoot / LEGACY_ROOT_FILE)) {
                throw ManifestException(
                    "$repoRoot is a loadout 0.x repo ($LEGACY_ROOT_FILE); this loadout reads " +
                        "$ROOT_FILE with a [layout] table — see the wiki's Repo layout page",
                )
            }
            throw ManifestException("Manifest not found: $rootPath")
        }
        val rootText = fs.read(rootPath) { readUtf8() }
        val root = parseRaw(rootText, manifestName)
        // Fail before interpreting anything else: an older binary silently
        // ignores manifest keys it doesn't know, so the repo's declared floor
        // is the only guard against misreading a newer config.
        root.meta.minToolVersion?.let { required ->
            if (!versionAtLeast(TOOL_VERSION, required)) {
                throw ManifestException(
                    "this config repo requires loadout >= $required (you have $TOOL_VERSION) — " +
                        "run: loadout self-upgrade",
                )
            }
        }
        return root.copy(data = MachineData.read(toml, rootText) ?: MachineData.EMPTY)
    }

    /** The root's `[layout]`, every required key present and every path inside the repo. */
    private fun layoutOf(root: Manifest, manifestName: String): RepoLayout {
        val layout = root.layout
            ?: throw ManifestException(
                "$manifestName has no [layout] table (fragments, machines and state are required)",
            )
        val errors = mutableListOf<String>()
        val fragments = layout.fragments
        when {
            fragments == null -> errors += "[layout] fragments is missing (a list of globs)"
            fragments.isEmpty() -> errors += "[layout] fragments is empty"
            else -> fragments.forEach { pattern ->
                Glob.problem(pattern)?.let { errors += "[layout] fragments '$pattern' $it" }
            }
        }
        fun dir(key: String, value: String?, required: Boolean) {
            when {
                value == null -> if (required) errors += "[layout] $key is missing (a directory)"
                Glob.hasWildcard(value) -> errors += "[layout] $key '$value' is a directory, not a glob"
                else -> Glob.problem(value)?.let { errors += "[layout] $key '$value' $it" }
            }
        }
        dir("machines", layout.machines, required = true)
        dir("state", layout.state, required = true)
        dir("configs", layout.configs, required = false)
        if (errors.isNotEmpty()) {
            throw ManifestException("Invalid $manifestName:\n" + errors.joinToString("\n") { "  - $it" })
        }
        return RepoLayout(fragments!!, layout.machines!!, layout.state!!, layout.configs)
    }

    private fun validate(manifest: Manifest, machinesDir: String = "machines") {
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
            if (installer.outdatedAll != null && installer.regex == null) {
                errors += "installers.$name has an outdated-all command but no regex"
            }
            if ("pkg" in installer.params) {
                errors += "installers.$name declares param 'pkg', which is always available"
            }
        }

        for ((name, source) in manifest.outdated) {
            if (source.command.isNullOrBlank()) {
                errors += "outdated.$name needs a command (prints '<item> <current> <candidate>' lines)"
            }
        }

        for ((name, program) in manifest.programs) {
            for (dep in program.dependsOn) {
                if (dep !in manifest.programs) {
                    errors += "programs.$name depends-on unknown program '$dep'"
                }
            }
            for ((key, variant) in program.install) {
                for (dep in variant.dependsOn) {
                    if (dep !in manifest.programs) {
                        errors += "programs.$name.install.$key depends-on unknown program '$dep'"
                    }
                }
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
                // Params are a contract between installer and variant: every
                // declared one must be supplied, and nothing else may be.
                val params = installer?.params.orEmpty()
                for (missing in params - variant.with.keys) {
                    errors += "programs.$name.install.$key needs a value for '$missing' " +
                        "(add it under [programs.$name.install.$key.with])"
                }
                for (extra in variant.with.keys - params.toSet()) {
                    errors += if (installer == null) {
                        "programs.$name.install.$key sets with.$extra but resolves to no installer"
                    } else {
                        "programs.$name.install.$key sets with.$extra, which installer " +
                            "'${variant.installer ?: key}' does not declare in params"
                    }
                }
            }
        }

        for ((name, script) in manifest.scripts) {
            if ((script.file == null) == (script.run == null)) {
                errors += "scripts.$name must define exactly one of 'file' (repo path) or 'run' (inline command)"
            }
            if (script.modes.isEmpty()) {
                errors += "scripts.$name has an empty modes list (it could never run; omit modes for both surfaces)"
            }
            script.modes.filterNot { it == "setup" || it == "maintain" }.forEach {
                errors += "scripts.$name has unknown mode '$it' (valid: setup, maintain)"
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
            val scriptNames = config.scripts.map { scriptEntry(it).first }
            scriptNames.groupBy { it }.filterValues { it.size > 1 }.keys.forEach { dup ->
                errors += "$machinesDir/$machine.toml lists script '$dup' more than once"
            }
            for ((scriptName, args) in config.scriptArgs()) {
                val script = manifest.scripts[scriptName]
                if (script == null) {
                    errors += "$machinesDir/$machine.toml scripts references unknown script '$scriptName'"
                } else if (args.isNotEmpty() && script.file == null) {
                    errors += "$machinesDir/$machine.toml passes arguments to script '$scriptName', " +
                        "which is an inline `run` script — arguments require a `file` script"
                }
            }
            for ((programName, installKey) in config.pm) {
                val program = manifest.programs[programName]
                if (program == null) {
                    errors += "$machinesDir/$machine.toml references unknown program '$programName'"
                } else if (installKey !in program.install) {
                    errors += "$machinesDir/$machine.toml maps '$programName' to '$installKey', but " +
                        "programs.$programName.install has no '$installKey' entry " +
                        "(has: ${program.install.keys.sorted().joinToString()})"
                }
            }
        }

        // Every variant's edges count: a cycle that only one machine's mapping
        // would walk is still a cycle in the manifest.
        findCycle(
            manifest.programs.mapValues { (_, p) -> (p.dependsOn + p.install.values.flatMap { it.dependsOn }).distinct() },
        )?.let { cycle ->
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
     * Programs in dependency order (dependencies before dependents), each
     * program's edges being those of the variant [mapping] picks for it
     * ([Manifest.dependenciesOf]). Assumes [validate] passed, i.e. the graph
     * is acyclic.
     */
    fun installOrder(
        manifest: Manifest,
        names: Collection<String> = manifest.programs.keys,
        mapping: Map<String, String> = emptyMap(),
    ): List<String> {
        val result = mutableListOf<String>()
        val seen = mutableSetOf<String>()

        fun visit(name: String) {
            if (name in seen || name !in manifest.programs) return
            seen += name
            manifest.dependenciesOf(name, mapping[name]).forEach(::visit)
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
