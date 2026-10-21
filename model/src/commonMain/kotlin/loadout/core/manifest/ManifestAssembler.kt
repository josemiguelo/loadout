package loadout.core.manifest

import loadout.core.LoadoutException
import loadout.core.model.INSTALL_FILE_PREFIX
import loadout.core.model.MachineConfig
import loadout.core.model.Manifest
import loadout.core.model.scriptEntry
import okio.FileSystem
import okio.Path
import okio.Path.Companion.toPath

open class ManifestException(message: String) : LoadoutException(message)

/**
 * What a config repo declares, before it becomes a [Manifest]: the repo's
 * own installers (built-ins not merged yet), and machines and profiles
 * unflattened. The DSL builds one; [ManifestAssembler.assemble] turns it
 * into what the lock holds.
 */
data class ManifestDraft(
    val manifest: Manifest,
    val profiles: Map<String, MachineConfig> = emptyMap(),
    /**
     * Programs each installer requires, built-ins included: a repo adds a
     * requirement to `dnf` without redefining it, so these apply after the
     * built-ins are merged.
     */
    val requires: Map<String, List<String>> = emptyMap(),
)

/**
 * Turns a [ManifestDraft] into a validated [Manifest]: the built-in
 * installers merged under the repo's, profiles flattened into machines
 * (contract 2), everything checked, and `file:` paths checked against the
 * repo. Shared by the DSL (which writes the lock) and the binary (which
 * re-checks files when it reads one), so both say the same thing.
 */
object ManifestAssembler {
    fun assemble(draft: ManifestDraft, fs: FileSystem, repoRoot: Path): Manifest = assemble(draft, fs to repoRoot)

    /**
     * [assemble] without the `file:` checks. TEST-ONLY: everything else —
     * built-ins, flattening, validation — behaves exactly as in production.
     */
    fun assembleWithoutFiles(draft: ManifestDraft): Manifest = assemble(draft, null)

    private fun assemble(draft: ManifestDraft, repo: Pair<FileSystem, Path>?): Manifest {
        val errors = mutableListOf<String>()
        val merged = withBuiltinInstallers(draft.manifest)
        val manifest = merged.copy(
            installers = merged.installers.mapValues { (name, installer) ->
                draft.requires[name]?.let { installer.copy(requires = (installer.requires + it).distinct()) } ?: installer
            },
        )
        for (name in draft.requires.keys - manifest.installers.keys) errors += "requires on unknown installer '$name'"
        if (manifest.layout.state.isBlank()) errors += "layout state is missing (a directory)"
        listOfNotNull(manifest.layout.state.ifBlank { null }, manifest.layout.configs).forEach { dir ->
            if (Glob.hasWildcard(dir)) errors += "layout '$dir' is a directory, not a glob"
            Glob.problem(dir)?.let { errors += "layout '$dir' $it" }
        }
        for ((name, config) in draft.profiles + manifest.machines) {
            errors += MachineData.validate(manifest.data, config.data, config.label.ifEmpty { name })
        }
        val machines = mutableMapOf<String, MachineConfig>()
        errors += flatten(manifest.machines, draft.profiles, machines)
        if (errors.isNotEmpty()) throw invalid(errors)

        val flat = manifest.copy(
            machines = machines.mapValues { (_, config) -> config.copy(data = MachineData.merge(manifest.data, config.data)) },
        )
        validate(flat)
        val missing = repo?.let { (fs, repoRoot) -> checkFiles(flat, fs, repoRoot) }.orEmpty()
        if (missing.isNotEmpty()) throw invalid(missing)
        return sorted(withFileValues(flat))
    }

    /**
     * Every `file:` path the manifest names, against the repo: each is
     * relative to its declaring file's directory and must exist without
     * leaving the repo. Returns the problems.
     */
    fun checkFiles(manifest: Manifest, fs: FileSystem, repoRoot: Path): List<String> {
        val problems = mutableListOf<String>()
        fun requirePath(file: String, origin: String, label: String) {
            val where = if (origin.isEmpty()) "the repo root" else "$origin/"
            val relative = (if (origin.isEmpty()) file else "$origin/$file").toPath().normalized()
            when {
                relative.isAbsolute || relative.segments.firstOrNull() == ".." ->
                    problems += "$label: file '$file' leaves the repo (paths are relative to $where)"
                !fs.exists(repoRoot / relative) ->
                    problems += "$label: file '$file' not found (relative to $where)"
            }
        }
        fun requireFile(command: String?, origin: String, label: String) {
            if (command == null || !command.startsWith(INSTALL_FILE_PREFIX)) return
            // Anything after the first space is arguments, not path.
            requirePath(command.removePrefix(INSTALL_FILE_PREFIX).substringBefore(' '), origin, label)
        }
        for ((name, script) in manifest.scripts) {
            for ((label, step) in listOf("" to script) + script.variants.map { (key, v) -> ".$key" to v }) {
                step.file?.let { requirePath(it, step.origin, "scripts.$name$label") }
                requireFile(step.check, step.origin, "scripts.$name$label.check")
            }
        }
        for ((name, source) in manifest.outdated) {
            requireFile(source.command, source.origin, "outdated.$name")
            requireFile(source.upgrade, source.origin, "outdated.$name.upgrade")
        }
        for ((name, program) in manifest.programs) {
            program.version?.let { requireFile(it.command, it.origin, "programs.$name.version") }
            program.outdated?.let { own ->
                requireFile(own.command, program.origin, "programs.$name.outdated")
                own.upgrade?.let { requireFile(it, program.origin, "programs.$name.outdated upgrade") }
            }
            for (key in program.install.keys) {
                val resolved = manifest.resolveInstall(name, key)
                requireFile(resolved.command, resolved.commandOrigin, "programs.$name.install.$key")
                // The version fallback is already checked once above.
                if (resolved.check != program.version) {
                    resolved.check?.let { requireFile(it.command, it.origin, "programs.$name.install.$key check") }
                }
                resolved.outdated?.let { requireFile(it.command, it.origin, "programs.$name.install.$key outdated") }
                resolved.outdatedAll?.let { requireFile(it.command, it.origin, "programs.$name.install.$key outdated-all") }
                resolved.upgradeWith?.let { requireFile(it.command, it.origin, "programs.$name.install.$key upgrade") }
            }
            for ((key, variant) in program.install) {
                for ((param, value) in variant.with) {
                    val label = "programs.$name.install.$key.with.$param"
                    when {
                        value.startsWith(INSTALL_FILE_PREFIX) ->
                            requirePath(value.removePrefix(INSTALL_FILE_PREFIX), program.origin, label)
                        // In a lock it's already a repo path (see withFileValues).
                        value.startsWith(REPO_PATH) -> requirePath(value.removePrefix(REPO_PATH), "", label)
                    }
                }
            }
        }
        return problems
    }

    /**
     * Programs in dependency order (dependencies before dependents), each
     * program's edges being those of the variant [mapping] picks for it
     * ([Manifest.dependenciesOf]). Ties break by name. Assumes [validate]
     * passed, i.e. the graph is acyclic.
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
            manifest.dependenciesOf(name, mapping[name]).sorted().forEach(::visit)
            result += name
        }

        names.sorted().forEach(::visit)
        return result
    }

    /**
     * Scripts ordered so that a script listed in another's `after` runs first,
     * ties by name. Only script-to-script edges affect this order;
     * `programs.*` references are satisfied by installs always running before
     * scripts.
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
                .sorted()
                .forEach(::visit)
            result += name
        }

        names.sorted().forEach(::visit)
        return result
    }

    /** How a `file:` `with` value reads once assembled: a path under the repo. */
    private const val REPO_PATH = "\$LOADOUT_REPO/"

    private fun invalid(errors: List<String>) =
        ManifestException("Invalid manifest:\n" + errors.joinToString("\n") { "  - $it" })

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
     * A `with` value marked `file:` is a path relative to the program's
     * file, like every other path; it's substituted into an installer pattern
     * that runs elsewhere, so it becomes "$LOADOUT_REPO/<path>".
     */
    private fun withFileValues(manifest: Manifest): Manifest = manifest.copy(
        programs = manifest.programs.mapValues { (_, program) ->
            program.copy(
                install = program.install.mapValues { (_, variant) ->
                    variant.copy(
                        with = variant.with.mapValues { (_, value) ->
                            if (!value.startsWith(INSTALL_FILE_PREFIX)) return@mapValues value
                            val file = value.removePrefix(INSTALL_FILE_PREFIX)
                            val relative = (if (program.origin.isEmpty()) file else "${program.origin}/$file")
                                .toPath().normalized()
                            "$REPO_PATH$relative"
                        },
                    )
                },
            )
        },
    )

    /**
     * Every map in name order, so the lock reads (and diffs) the same however
     * it was declared; and exactly what a read of the lock gives back (labels
     * are for messages, and don't travel).
     */
    private fun sorted(manifest: Manifest): Manifest = manifest.copy(
        installers = manifest.installers.toSortedMap(),
        programs = manifest.programs.toSortedMap(),
        scripts = manifest.scripts.toSortedMap(),
        machines = manifest.machines.toSortedMap().mapValues { (_, machine) ->
            machine.copy(pm = machine.pm.toSortedMap(), scriptVariants = machine.scriptVariants.toSortedMap(), label = "")
        },
        outdated = manifest.outdated.toSortedMap(),
        builtinInstallers = manifest.builtinInstallers.sorted().toSet(),
    )

    private fun <V> Map<String, V>.toSortedMap(): Map<String, V> = entries.sortedBy { it.key }.associate { it.key to it.value }

    /**
     * Resolve `extends` lists into [out]: every machine becomes its flattened
     * self, downstream nothing knows profiles existed. A machine's profiles
     * are combined first — two of them setting a program's variant, a
     * script's arguments or variant, or a data key differently is an error,
     * so their order never changes the result — then the machine itself
     * overrides them ([MachineConfig.pm] per key, scripts by name, data table
     * by table, lists replace). Profiles are validated through the machines
     * extending them, and each one alone too. Returns errors.
     */
    private fun flatten(
        machineConfigs: Map<String, MachineConfig>,
        profiles: Map<String, MachineConfig>,
        out: MutableMap<String, MachineConfig>,
    ): List<String> {
        val errors = mutableListOf<String>()
        val flatProfiles = mutableMapOf<String, MachineConfig>()

        fun flatten(config: MachineConfig, seen: List<String>): MachineConfig {
            val parents = config.extends.mapNotNull { name ->
                val profile = profiles[name]
                when {
                    profile == null -> {
                        errors += "${config.label}: extends unknown profile '$name'"
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
            val variants = linkedMapOf<String, Pair<String, String>>() // script -> (variant, profile)
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
                            "'${previous.second}' and '$name' run '$script' with different arguments"
                    }
                }
                for ((script, variant) in parent.scriptVariants) {
                    val previous = variants[script]
                    when {
                        previous == null -> variants[script] = variant to name
                        previous.first != variant -> errors += "${config.label}: profiles '${previous.second}' and " +
                            "'$name' run '$script' as different variants ('${previous.first}' vs '$variant')"
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
                scriptVariants = variants.mapValues { it.value.first }.filterKeys { it !in own } + config.scriptVariants,
                data = MachineData.merge(data, config.data),
            )
        }

        for ((name, profile) in profiles) {
            if (name !in flatProfiles) flatProfiles[name] = flatten(profile, listOf(name))
        }
        for ((name, machine) in machineConfigs) out[name] = flatten(machine, emptyList())
        return errors
    }

    private fun validate(manifest: Manifest) {
        val errors = mutableListOf<String>()

        manifest.meta.minToolVersion?.let {
            if (!Regex("""\d+(\.\d+)*""").matches(it)) {
                errors += "meta min-tool-version '$it' is not a dotted version number (e.g. \"0.2.0\")"
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
            for (required in installer.requires) {
                if (required !in manifest.programs) {
                    errors += "installers.$name requires unknown program '$required'"
                }
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
                        "(set a command, or use an installer with an install pattern)"
                }
                if (variant.present && variant.regex != null) {
                    errors += "programs.$name.install.$key is a yes/no check and also sets a regex"
                }
                if (variant.present && (variant.check ?: installer?.check) == null) {
                    errors += "programs.$name.install.$key is a yes/no check with no check command"
                }
                if (!variant.present && variant.check != null && (variant.regex ?: installer?.regex) == null) {
                    errors += "programs.$name.install.$key has a check but no regex " +
                        "(give it one, or make it a yes/no check)"
                }
                if (variant.outdated != null && (variant.regex ?: installer?.regex) == null) {
                    errors += "programs.$name.install.$key has an outdated command but no regex"
                }
                // Params are a contract between installer and variant: every
                // declared one must be supplied, and nothing else may be.
                val params = installer?.params.orEmpty()
                for (missing in params - variant.with.keys) {
                    errors += "programs.$name.install.$key needs a value for '$missing'"
                }
                for (extra in variant.with.keys - params.toSet()) {
                    errors += if (installer == null) {
                        "programs.$name.install.$key sets '$extra' but resolves to no installer"
                    } else {
                        "programs.$name.install.$key sets '$extra', which installer " +
                            "'${variant.installer ?: key}' does not declare in params"
                    }
                }
            }
        }

        for ((name, script) in manifest.scripts) {
            val ways = if (script.variants.isEmpty()) {
                listOf("scripts.$name" to script)
            } else {
                if (script.file != null || script.run != null) {
                    errors += "scripts.$name has variants, so its file or command belongs in each variant"
                }
                script.variants.map { (key, variant) -> "scripts.$name.$key" to variant }
            }
            for ((label, step) in ways) {
                if ((step.file == null) == (step.run == null)) {
                    errors += "$label must define exactly one of a file or an inline command"
                }
                for (ref in step.after) {
                    val valid = when {
                        ref.startsWith("programs.") -> ref.removePrefix("programs.") in manifest.programs
                        ref.startsWith("scripts.") -> ref.removePrefix("scripts.") in manifest.scripts
                        else -> false
                    }
                    if (!valid) errors += "$label after references unknown step '$ref'"
                }
            }
            if (script.modes.isEmpty()) {
                errors += "scripts.$name has an empty modes list (it could never run; omit modes for both surfaces)"
            }
            script.modes.filterNot { it == "setup" || it == "maintain" }.forEach {
                errors += "scripts.$name has unknown mode '$it' (valid: setup, maintain)"
            }
        }

        for ((machine, config) in manifest.machines) {
            val label = config.label.ifEmpty { "machine '$machine'" }
            val scriptNames = config.scripts.map { scriptEntry(it).first }
            scriptNames.groupBy { it }.filterValues { it.size > 1 }.keys.forEach { dup ->
                errors += "$label runs script '$dup' more than once"
            }
            for ((scriptName, args) in config.scriptArgs()) {
                val script = manifest.scripts[scriptName]
                val variant = config.scriptVariants[scriptName]
                when {
                    script == null -> errors += "$label runs unknown script '$scriptName'"
                    script.variants.isNotEmpty() && variant == null -> errors += "$label runs '$scriptName' " +
                        "without saying which variant (has: ${script.variants.keys.sorted().joinToString()})"
                    variant != null && variant !in script.variants -> errors += "$label runs '$scriptName' as " +
                        "'$variant', which it doesn't have (has: ${script.variants.keys.sorted().joinToString().ifEmpty { "none" }})"
                    args.isNotEmpty() && (variant?.let(script::variant) ?: script).file == null ->
                        errors += "$label passes arguments to script '$scriptName', " +
                            "which is an inline command — arguments require a file script"
                }
            }
            for ((programName, installKey) in config.pm) {
                val program = manifest.programs[programName]
                if (program == null) {
                    errors += "$label installs unknown program '$programName'"
                } else if (installKey !in program.install) {
                    errors += "$label installs '$programName' via '$installKey', but it can't be installed " +
                        "that way (it can via: ${program.install.keys.sorted().joinToString()})"
                }
            }
        }

        // Every variant's edges count, its installer's requirements too: a
        // cycle that only one machine's mapping would walk is still a cycle.
        findCycle(
            manifest.programs.mapValues { (name, _) ->
                manifest.programs.getValue(name).install.keys.flatMap { manifest.dependenciesOf(name, it) }
                    .plus(manifest.dependenciesOf(name, null))
                    .distinct()
            },
        )?.let { cycle ->
            errors += "dependency cycle among programs: ${cycle.joinToString(" -> ")}"
        }
        findCycle(
            manifest.scripts.mapValues { (_, s) ->
                (s.after + s.variants.values.flatMap { it.after })
                    .filter { it.startsWith("scripts.") }.map { it.removePrefix("scripts.") }.distinct()
            },
        )?.let { cycle ->
            errors += "ordering cycle among scripts: ${cycle.joinToString(" -> ")}"
        }

        if (errors.isNotEmpty()) throw invalid(errors)
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

        for (node in edges.keys.sorted()) {
            visit(node)?.let { return it }
        }
        return null
    }
}
