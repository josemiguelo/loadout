package loadout.core.manifest

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
import okio.FileSystem
import okio.Path
import okio.Path.Companion.toPath

class ManifestException(message: String) : LoadoutException(message)

object ManifestLoader {
    /** The repo's root file: `meta`, `layout`, `data`, and optionally programs/scripts of its own. */
    const val ROOT_FILE: String = "loadout.yaml"

    /**
     * The repo's validated `layout`, read from the root file alone, so the
     * state store can find its directory without loading the whole repo.
     */
    fun readLayout(fs: FileSystem, repoRoot: Path, manifestName: String = ROOT_FILE): RepoLayout =
        layoutOf(readRoot(fs, repoRoot, manifestName), manifestName)

    /**
     * Load the repo's full manifest: the root file, plus the fragment files
     * its `layout fragments` globs match (programs/scripts/installers/
     * outdated sources), plus per-machine `<machines>/<name>.yaml` configs —
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
            errors += "$manifestName: machines sections are not allowed; " +
                "machine configs live in $machinesDir/<name>.yaml"
        }

        val outdatedSources = root.outdated.toMutableMap()
        val machinePaths = machineFiles(fs, repoRoot / machinesDir)
        val profilePaths = layout.profiles?.let { machineFiles(fs, repoRoot / it) }.orEmpty()

        // Folder structure inside a glob's matches is cosmetic. Deterministic
        // order: the globs' order, path-sorted within one.
        for (path in fragmentFiles(fs, repoRoot, layout, manifestName, machinePaths, profilePaths, errors)) {
            val label = Glob.relative(repoRoot, path)
            val fragmentText = fs.read(path) { readUtf8() }
            val origin = Glob.relative(repoRoot, path.parent!!)
            // A `*.loadout.yaml` fragment holds named sections; any other YAML
            // fragment is one program, named by its file.
            val fragment = withOrigin(
                when {
                    path.name.endsWith(".loadout.yaml") -> YamlManifest.fragment(fragmentText, label)
                    path.name.endsWith(".yaml") -> {
                        val (program, fileScripts) = YamlProgram.read(fragmentText, label)
                        Manifest(programs = mapOf(path.name.removeSuffix(".yaml") to program), scripts = fileScripts)
                    }
                    else -> throw ManifestException("$label: a fragment must be a YAML file (.yaml)")
                },
                origin,
            )
            if (fragment.meta != Meta()) {
                errors += "$label: meta is only allowed in $manifestName"
            }
            if (fragment.layout != null) {
                errors += "$label: layout is only allowed in $manifestName"
            }
            if (fragment.machines.isNotEmpty()) {
                errors += "$label: machines sections are not allowed; " +
                    "machine configs live in $machinesDir/<name>.yaml"
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

        // Machine files sit directly in their directory, so chezmoi templates
        // find one by hostname (the machine name is the file name); profile
        // files likewise in theirs.
        fun readConfigs(dir: String, paths: List<Path>, kind: String, profile: Boolean): Map<String, MachineConfig> {
            val configs = linkedMapOf<String, MachineConfig>()
            for (path in paths) {
                val label = Glob.relative(repoRoot, path)
                if (path.parent != repoRoot / dir) {
                    errors += "$label: $kind files live directly in $dir/ (no subfolders)"
                    continue
                }
                val text = fs.read(path) { readUtf8() }
                val config = YamlMachine.read(text, label, errors).copy(base = profile)
                errors += MachineData.validate(root.data, config.data, label)
                val name = path.name.substringBeforeLast('.')
                if (configs.put(name, config) != null) {
                    errors += "duplicate $kind '$name' (redefined in $label)"
                }
            }
            return configs
        }
        val profileConfigs = layout.profiles?.let { readConfigs(it, profilePaths, "profile", profile = true) }.orEmpty()
        errors += flattenMachines(readConfigs(machinesDir, machinePaths, "machine", profile = false), profileConfigs, layout.profiles, machines)
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
            program.outdated?.let { own ->
                requireFile(own.command, program.origin, "programs.$name.outdated")
                own.upgrade?.let { requireFile(it, program.origin, "programs.$name.outdated upgrade") }
            }
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
        // A `with` value marked `file:` is a path relative to the program's
        // file, like every other path; it's substituted into an installer
        // pattern that runs elsewhere, so it becomes "$LOADOUT_REPO/<path>".
        val withResolved = merged.copy(
            programs = merged.programs.mapValues { (name, program) ->
                program.copy(
                    install = program.install.mapValues { (key, variant) ->
                        variant.copy(
                            with = variant.with.mapValues { (param, value) ->
                                if (!value.startsWith(INSTALL_FILE_PREFIX)) return@mapValues value
                                val file = value.removePrefix(INSTALL_FILE_PREFIX)
                                requirePath(file, program.origin, "programs.$name.install.$key.with.$param")
                                val relative = (if (program.origin.isEmpty()) file else "${program.origin}/$file")
                                    .toPath().normalized()
                                "\$LOADOUT_REPO/$relative"
                            },
                        )
                    },
                )
            },
        )
        if (missingFiles.isNotEmpty()) {
            throw ManifestException("Invalid manifest:\n" + missingFiles.joinToString("\n"))
        }
        // Profiles are config inheritance, not machines: validated above, but
        // never observed, diffed, or converged.
        return withResolved.copy(machines = withResolved.machines.filterValues { !it.base })
    }

    /**
     * Parse and validate a single manifest document. TEST-ONLY (contract 10):
     * it skips fragment/machine-file merging and, unlike [loadRepo], tolerates
     * inline `machines` and cannot check that `file:` paths exist. It does
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

    /** The installers in a standalone YAML document — used for the built-in library. */
    fun parseInstallers(text: String): Map<String, Installer> = parseRaw(text, "built-in installers").installers

    // Removed in 0.9.0. A templated manifest must fail by name, never load as
    // an EMPTY program list: a machine's whole loadout would silently vanish.
    private val REMOVED_TEMPLATES = Regex("^(templates|template):", RegexOption.MULTILINE)

    private fun parseRaw(text: String, label: String): Manifest {
        refuseTemplates(text, label)
        return YamlManifest.root(text, label)
    }

    private fun refuseTemplates(text: String, label: String) {
        if (REMOVED_TEMPLATES.containsMatchIn(text)) {
            throw ManifestException(
                "$label uses templates, removed in loadout 0.9.0 — declare each program " +
                    "explicitly (see the wiki), or pin an older loadout",
            )
        }
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

    /** All `.yaml` files under [dir], path-sorted; loadRepo refuses any in a subfolder. */
    private fun machineFiles(fs: FileSystem, dir: Path): List<Path> {
        if (!fs.exists(dir)) return emptyList()
        return fs.listRecursively(dir)
            .filter { it.name.endsWith(".yaml") && fs.metadataOrNull(it)?.isRegularFile == true }
            .sortedBy { it.toString() }
            .toList()
    }

    /**
     * Resolve `extends` lists into [out]: every machine becomes its flattened
     * self, downstream nothing knows profiles existed. A file's profiles are
     * combined first — two of them setting a program's variant, a script's
     * arguments or a data key differently is an error, so their order never
     * changes the result — then the file itself overrides them ([pm] per
     * key, `scripts` by name, `data` table by table, lists replace).
     * Profiles land in [out] too, flattened and marked `base`, so validation
     * covers them; loadRepo drops them after validating. Returns errors.
     */
    private fun flattenMachines(
        machineConfigs: Map<String, MachineConfig>,
        profiles: Map<String, MachineConfig>,
        profilesDir: String?,
        out: MutableMap<String, MachineConfig>,
    ): List<String> {
        val errors = mutableListOf<String>()
        val flatProfiles = mutableMapOf<String, MachineConfig>()

        fun flatten(config: MachineConfig, seen: List<String>): MachineConfig {
            val parents = config.extends.mapNotNull { name ->
                val profile = profiles[name]
                when {
                    profilesDir == null -> {
                        errors += "${config.label}: extends '$name', but loadout.yaml's layout has no profiles directory"
                        null
                    }
                    profile == null -> {
                        errors += "${config.label}: extends unknown profile '$name' (no $profilesDir/$name.yaml)"
                        null
                    }
                    name in seen -> {
                        errors += "profile cycle: ${(seen + name).joinToString(" -> ")}"
                        null
                    }
                    else -> name to (flatProfiles[name] ?: flatten(profile, seen + name).also { flatProfiles[name] = it })
                }
            }
            val pm = linkedMapOf<String, Pair<String, String>>() // program -> (variant, profile)
            val scripts = linkedMapOf<String, Pair<String, String>>() // script -> (entry, profile)
            var data = MachineData.EMPTY
            parents.forEachIndexed { index, (name, parent) ->
                for ((program, variant) in parent.pm) {
                    val previous = pm[program]
                    when {
                        previous == null -> pm[program] = variant to name
                        previous.first != variant -> errors += "${config.label}: profiles '${previous.second}' and " +
                            "'$name' map '$program' differently ('${previous.first}' vs '$variant')"
                    }
                }
                for (entry in parent.scripts) {
                    val (script, args) = scriptEntry(entry)
                    val previous = scripts[script]
                    when {
                        previous == null -> scripts[script] = entry to name
                        scriptEntry(previous.first).second != args -> errors += "${config.label}: profiles " +
                            "'${previous.second}' and '$name' opt into '$script' with different arguments"
                    }
                }
                for ((earlier, earlierConfig) in parents.take(index)) {
                    MachineData.conflicts(earlierConfig.data, parent.data).forEach {
                        errors += "${config.label}: profiles '$earlier' and '$name' set data key '$it' differently"
                    }
                }
                data = MachineData.merge(data, parent.data)
            }
            val own = config.scriptArgs().keys
            return config.copy(
                pm = pm.mapValues { it.value.first } + config.pm,
                scripts = scripts.values.map { it.first }.filterNot { scriptEntry(it).first in own } + config.scripts,
                data = MachineData.merge(data, config.data),
            )
        }

        for ((name, profile) in profiles) {
            if (name !in flatProfiles) flatProfiles[name] = flatten(profile, listOf(name))
        }
        for ((name, machine) in machineConfigs) out[name] = flatten(machine, emptyList())
        // Profile names may repeat machine names; the prefix keeps them apart
        // until loadRepo drops them.
        for ((name, profile) in flatProfiles) out["profile:$name"] = profile
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
        profilePaths: List<Path>,
        errors: MutableList<String>,
    ): List<Path> {
        val rootPath = repoRoot / manifestName
        val files = LinkedHashSet<Path>()
        for (pattern in layout.fragments) {
            for (path in Glob.expand(fs, repoRoot, pattern)) {
                when (path) {
                    rootPath -> errors += "layout fragments '$pattern' matches $manifestName itself"
                    in machinePaths ->
                        errors += "layout fragments '$pattern' matches machine file ${Glob.relative(repoRoot, path)}"
                    in profilePaths ->
                        errors += "layout fragments '$pattern' matches profile file ${Glob.relative(repoRoot, path)}"
                    else -> files += path
                }
            }
        }
        return files.toList()
    }

    private fun readRoot(fs: FileSystem, repoRoot: Path, manifestName: String): Manifest {
        val rootPath = repoRoot / manifestName
        if (!fs.exists(rootPath)) {
            throw ManifestException("Manifest not found: $rootPath")
        }
        val text = fs.read(rootPath) { readUtf8() }
        refuseTemplates(text, manifestName)
        val root = YamlManifest.root(text, manifestName)
        // Fail before interpreting anything else: an older binary must refuse
        // by version, not by a parse error on a key it doesn't know.
        root.meta.minToolVersion?.let { required ->
            if (!versionAtLeast(TOOL_VERSION, required)) {
                throw ManifestException(
                    "this config repo requires loadout >= $required (you have $TOOL_VERSION) — " +
                        "run: loadout self-upgrade",
                )
            }
        }
        return root
    }

    /** The root's `layout`, every required key present and every path inside the repo. */
    private fun layoutOf(root: Manifest, manifestName: String): RepoLayout {
        val layout = root.layout
            ?: throw ManifestException(
                "$manifestName has no layout table (fragments, machines and state are required)",
            )
        val errors = mutableListOf<String>()
        val fragments = layout.fragments
        when {
            fragments == null -> errors += "layout fragments is missing (a list of globs)"
            fragments.isEmpty() -> errors += "layout fragments is empty"
            else -> fragments.forEach { pattern ->
                Glob.problem(pattern)?.let { errors += "layout fragments '$pattern' $it" }
            }
        }
        fun dir(key: String, value: String?, required: Boolean) {
            when {
                value == null -> if (required) errors += "layout $key is missing (a directory)"
                Glob.hasWildcard(value) -> errors += "layout $key '$value' is a directory, not a glob"
                else -> Glob.problem(value)?.let { errors += "layout $key '$value' $it" }
            }
        }
        dir("machines", layout.machines, required = true)
        dir("state", layout.state, required = true)
        dir("profiles", layout.profiles, required = false)
        dir("configs", layout.configs, required = false)
        if (errors.isNotEmpty()) {
            throw ManifestException("Invalid $manifestName:\n" + errors.joinToString("\n") { "  - $it" })
        }
        return RepoLayout(
            fragments = fragments!!,
            machines = layout.machines!!,
            profiles = layout.profiles,
            state = layout.state!!,
            configs = layout.configs,
        )
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
            program.outdated?.let { own ->
                if (own.command.isBlank()) {
                    errors += "programs.$name.outdated needs a command (prints the newest version)"
                }
                if (program.version?.regex == null) {
                    errors += "programs.$name.outdated needs a version with a regex: the newest version is " +
                        "read with the program's version regex"
                }
            }
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
                        "(add it under programs.$name.install.$key.with)"
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
            val file = config.label.ifEmpty { "$machinesDir/$machine.yaml" }
            val scriptNames = config.scripts.map { scriptEntry(it).first }
            scriptNames.groupBy { it }.filterValues { it.size > 1 }.keys.forEach { dup ->
                errors += "$file lists script '$dup' more than once"
            }
            for ((scriptName, args) in config.scriptArgs()) {
                val script = manifest.scripts[scriptName]
                if (script == null) {
                    errors += "$file scripts references unknown script '$scriptName'"
                } else if (args.isNotEmpty() && script.file == null) {
                    errors += "$file passes arguments to script '$scriptName', " +
                        "which is an inline `run` script — arguments require a `file` script"
                }
            }
            for ((programName, installKey) in config.pm) {
                val program = manifest.programs[programName]
                if (program == null) {
                    errors += "$file references unknown program '$programName'"
                } else if (installKey !in program.install) {
                    errors += "$file maps '$programName' to '$installKey', but " +
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
