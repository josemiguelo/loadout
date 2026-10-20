package loadout.dsl

import loadout.core.manifest.InstallerLibrary
import loadout.core.model.InstallVariant
import loadout.core.model.Installer as InstallerModel
import loadout.core.model.MachineConfig
import loadout.core.model.Meta
import loadout.core.model.OutdatedSource
import loadout.core.model.Program as ProgramModel
import loadout.core.model.ProgramOutdated
import loadout.core.model.RepoLayout
import loadout.core.model.ScriptStep
import loadout.core.model.VersionCheck

/** The default version regex: the first dotted number in the output. */
const val VERSION: String = """([0-9]+\.[0-9][0-9.]*)"""

private val registry get() = Registry.current

// ─── Repo ──────────────────────────────────────────────────────────────

/** The repo itself, as declared by [repo]. */
class Repo internal constructor(val name: String)

/**
 * The repo in one declaration: its name, where state goes (one file per
 * machine), chezmoi's source when it holds dotfiles, the oldest loadout
 * that may read its lock, and its machine-data schema.
 *
 * ```
 * val repo = repo(name = "my machines", state = "state", data = ::Data)
 * ```
 */
fun repo(
    name: String,
    state: String,
    configs: String? = null,
    minToolVersion: String? = null,
    data: (() -> MachineData)? = null,
): Repo {
    meta(name, minToolVersion)
    layout(state, configs)
    data?.let(::machineData)
    return Repo(name)
}

/** The repo's name, and the oldest loadout that may read its lock. */
fun meta(name: String, minToolVersion: String? = null) {
    registry.meta = Meta(name, minToolVersion)
}

/** Where state goes (one file per machine), and chezmoi's source when the repo holds dotfiles. */
fun layout(state: String, configs: String? = null) {
    registry.layout = registry.layout.copy(state = state, configs = configs)
}

/** The machine-data schema: every key with its default. */
fun <D : MachineData> machineData(schema: () -> D) {
    registry.data = schema().defaults()
}

/**
 * A directory of the repo. What it declares resolves `file:` paths there and
 * runs its commands there (contracts 4 and 5). The top-level [program],
 * [script], [installer] and [outdated] declare in the directory of the file
 * they're written in; `Dir("x").program(…)` declares for another one.
 */
class Dir(val path: String) {
    fun installer(name: String, block: InstallerScope.() -> Unit): Installer {
        val scope = InstallerScope().apply(block)
        registry.add("installer", name, registry.installers, scope.build(path))
        return Installer(name)
    }

    fun program(name: String, description: String = "", block: ProgramScope.() -> Unit = {}): Program {
        val scope = ProgramScope(name).apply(block)
        registry.add("program", name, registry.programs, scope.build(description, path))
        return Program(name, scope.variantKeys())
    }

    fun script(name: String, description: String = "", block: ScriptScope.() -> Unit): Script {
        val scope = ScriptScope(this, name).apply(block)
        registry.add("script", name, registry.scripts, scope.build(description))
        for ((source, outdated) in scope.outdatedSources) {
            registry.add("outdated source", source ?: name, registry.outdated, outdated)
        }
        return Script(name, scope.variantNames())
    }

    /** A custom `outdated` source not tied to one script or program. */
    fun outdated(name: String, command: String, upgrade: String? = null, needsSudo: Boolean = false) {
        registry.add("outdated source", name, registry.outdated, OutdatedSource(command, upgrade, needsSudo, path))
    }

    /** A `with` value that is a file of the repo, relative to the program's directory. */
    fun file(path: String): String = "file:$path"
}

/** The repo root. */
val root: Dir = Dir("")

/**
 * Where the declaration being made was written. `loadout compile` sets it
 * to the declaring file's directory (it knows each compiled file's path);
 * anywhere else (tests) declarations land at the repo root.
 */
object Origins {
    /** The directory a declaration (named by its argument, for messages) was written in. */
    var resolver: ((String) -> String)? = null

    internal fun here(what: String): Dir = Dir(resolver?.invoke(what) ?: "")
}

/** A program, declared in this file's directory. */
fun program(name: String, description: String = "", block: ProgramScope.() -> Unit = {}): Program =
    Origins.here("program '$name'").program(name, description, block)

/** A script, declared in this file's directory: its file and checks are relative to it. */
fun script(name: String, description: String = "", block: ScriptScope.() -> Unit): Script =
    Origins.here("script '$name'").script(name, description, block)

/** An installer, declared in this file's directory: its `file:` patterns are relative to it. */
fun installer(name: String, block: InstallerScope.() -> Unit): Installer =
    Origins.here("installer '$name'").installer(name, block)

/** A custom `outdated` source not tied to one script or program, declared in this file's directory. */
fun outdated(name: String, command: String, upgrade: String? = null, needsSudo: Boolean = false) =
    Origins.here("outdated source '$name'").outdated(name, command, upgrade, needsSudo)

/** A param value that is a file of the repo, relative to the program's directory: `dnfRepo(repofile = file("x.repo"))`. */
fun file(path: String): String = "file:$path"

/**
 * A command that runs a script of the repo, relative to the declaring file's
 * folder, with its arguments: `runScript("brew.sh install {pkg}")`. The
 * script is checked to exist (at compile and on every load) and runs as
 * `sh '<script>' <args>`, so it needs no executable bit.
 */
fun runScript(command: String): String = "file:$command"

/** Something `runAfter` can name: a program or a script. Typed, so a rename is a compile error. */
sealed interface Step {
    val name: String
}

/**
 * [items], refused when one isn't declared yet. Kotlin can't see it, but a
 * reference read while two files (or an object and the file it's in) are
 * still initialising each other is null; this names who made it instead of
 * failing somewhere inside the DSL.
 */
internal fun <T> declared(items: Array<out T>, who: String): Array<out T> {
    items.forEachIndexed { index, item ->
        if ((item as Any?) == null) {
            throw DslException(
                "$who refers to something not declared yet (argument ${index + 1}): two manifest files, or an " +
                    "object and the file it's in, refer to each other while they load. Move the declarations " +
                    "so references go one way (e.g. everything that refers to an object's members into the object).",
            )
        }
    }
    return items
}

// ─── Installers ────────────────────────────────────────────────────────

/**
 * One way a program is installed, for [ProgramScope.installVia]: an installer as it
 * is (`omarchy`), or one configured where it's named (`dnf(pkg = "vim-enhanced")`,
 * `dnfCopr(copr = "solopasha/kitty")`, `dnf { managedBy("setup-dnf.sh") }`).
 */
sealed interface InstallMethod

/** An installer configured for one program; see [Installer.invoke]. */
class ConfiguredInstaller internal constructor(val installer: Installer, internal val variant: InstallVariant) : InstallMethod

/**
 * This installer, configured for one program: its package id, and the
 * block's command, check or param values. Hand it to [ProgramScope.installVia].
 */
operator fun Installer.invoke(pkg: String? = null, block: VariantScope.() -> Unit = {}): InstallMethod =
    ConfiguredInstaller(this, VariantScope(pkg).apply(block).build(installer = null))

class Installer(val name: String) : InstallMethod {
    /**
     * Every program installed through this installer depends on [programs]
     * (setup-brew before every brew install). A required program installed
     * through this same installer is exempt from its own rule. Works on
     * built-ins too: `dnf.requires(setupDnf)`.
     */
    fun requires(vararg programs: Program) {
        registry.requires.getOrPut(name) { mutableListOf() } += declared(programs, "installer '$name'").map { it.name }
    }
}

class InstallerScope internal constructor() {
    var probe: String? = null
    var install: String? = null
    var check: String? = null
    var regex: String = VERSION
    var outdated: String? = null
    var outdatedAll: String? = null
    var upgrade: String? = null
    private var sudo = false
    private val params = mutableListOf<String>()

    fun needsSudo() {
        sudo = true
    }

    /** Values each variant supplies, substituted like `{pkg}`: `{tap}`. */
    fun params(vararg names: String) {
        params += names
    }

    internal fun build(origin: String) = InstallerModel(
        probe = probe,
        params = params.toList(),
        install = install,
        check = check,
        regex = regex,
        outdated = outdated,
        outdatedAll = outdatedAll,
        upgrade = upgrade,
        sudo = sudo,
        origin = origin,
    )
}

/** The built-in library, as values. A repo installer of the same name replaces one. */
object Builtin {
    val dnf: Installer = builtin("dnf")
    val dnfRepo: Installer = builtin("dnf-repo")
    val dnfCopr: Installer = builtin("dnf-copr")
    val brew: Installer = builtin("brew")
    val brewCask: Installer = builtin("brew-cask")
    val flatpak: Installer = builtin("flatpak")
    val pacman: Installer = builtin("pacman")
    val omarchy: Installer = builtin("omarchy")
    val omarchyAur: Installer = builtin("omarchy-aur")
    val apt: Installer = builtin("apt")

    private fun builtin(name: String): Installer {
        check(name in InstallerLibrary.names) { "no built-in installer '$name'" }
        return Installer(name)
    }
}

// ─── Programs ──────────────────────────────────────────────────────────

/** What a machine installs: a program, or one named variant of it. */
sealed interface Installable

class Program internal constructor(
    override val name: String,
    /** Its variant keys, so a machine can install a one-variant program without naming it. */
    val variants: List<String>,
) : Step, Installable {
    /** One of its variants, for a machine to map: `install(setupBrew.variant(name = "linux"))`. */
    fun variant(name: String): ProgramVariant = ProgramVariant(this, name)
}

class ProgramVariant internal constructor(val program: Program, val name: String) : Installable

class ProgramScope internal constructor(
    /** The program's name, for wrappers that derive from it. */
    val name: String,
) {
    private val install = linkedMapOf<String, InstallVariant>()
    private val dependsOn = mutableListOf<String>()
    private val tags = mutableListOf<String>()
    private val path = mutableListOf<String>()
    private var version: Pair<String, String>? = null
    private var outdated: ProgramOutdated? = null

    /**
     * The installers this program is installed via, each a variant keyed by
     * its installer's name: `installVia(dnfCopr(copr = "solopasha/kitty"), omarchy,
     * brewCask)`. Naming an installer twice is an error.
     */
    fun installVia(vararg ways: InstallMethod) {
        for (way in declared(ways, "program '$name'")) {
            when (way) {
                is Installer -> add(way.name, InstallVariant())
                is ConfiguredInstaller -> add(way.installer.name, way.variant)
            }
        }
    }

    /** A variant with no installer: its own command and check. Named only when a program has several. */
    fun custom(name: String = "custom", block: VariantScope.() -> Unit) {
        add(name, VariantScope(null).apply(block).build(installer = null))
    }

    fun dependsOn(vararg programs: Program) {
        dependsOn += declared(programs, "program '$name'").map { it.name }
    }

    fun tags(vararg tags: String) {
        this.tags += tags
    }

    /** The fallback check of every variant without one. */
    fun version(command: String, regex: String = VERSION) {
        version = command to regex
    }

    /** Directories put first on PATH for this program's commands (`$HOME/.local/bin`). */
    fun path(vararg dirs: String) {
        path += dirs
    }

    /** Is this program behind upstream? [upgrade] is the one command that moves it. */
    fun outdated(command: String, upgrade: String? = null) {
        outdated = ProgramOutdated(command, upgrade)
    }

    /**
     * Its updates are managed by a [script] of the repo's: `<script>` prints
     * the newest version (nothing when current), `<script> update` updates it.
     */
    fun updatesManagedBy(script: String) {
        outdated = ProgramOutdated("file:$script", "file:$script update")
    }

    private fun add(key: String, variant: InstallVariant) {
        if (install.put(key, variant) != null) registry.errors += "program '$name' has two '$key' variants"
    }

    internal fun variantKeys(): List<String> = install.keys.toList()

    internal fun build(description: String, origin: String) = ProgramModel(
        description = description,
        tags = tags.toList(),
        dependsOn = dependsOn.distinct(),
        version = version?.let { (command, regex) -> VersionCheck(command, regex, origin = origin, path = path.toList()) },
        install = install,
        outdated = outdated,
        path = path.toList(),
        origin = origin,
    )
}

class VariantScope internal constructor(var pkg: String?) {
    var command: String? = null
    var probe: String? = null
    var outdated: String? = null

    /** Overrides only the regex of the derived check (sublime's build numbers). */
    var regex: String? = null

    private var check: String? = null
    private var present = false
    private var sudo: Boolean? = null
    private val dependsOn = mutableListOf<String>()
    private val with = linkedMapOf<String, String>()

    /** The check reports a version. */
    fun version(command: String, regex: String = VERSION) {
        check = command
        this.regex = regex
        present = false
    }

    /** The check only says yes or no: exit 0 = installed, no version recorded. */
    fun present(command: String) {
        check = command
        regex = null
        present = true
    }

    /**
     * Installed by a [script] of the repo's (`<script>`, relative to this
     * file's folder; arguments may follow). The check still comes from the
     * installer, or from [version]/[present].
     */
    fun installedBy(script: String) {
        command = runScript(script)
    }

    /**
     * Installed and checked by a managing [script] of the repo's: `<script>
     * install` installs it, `<script> check` says whether it's there (a
     * yes/no check, unless [version] names the regex its output is read with).
     */
    fun managedBy(script: String, version: String? = null) {
        command = "file:$script install"
        if (version == null) present("file:$script check") else version("file:$script check", version)
    }

    /** The install needs sudo's password; `needsSudo(false)` says it doesn't, whatever its installer says. */
    fun needsSudo(needed: Boolean = true) {
        sudo = needed
    }

    fun dependsOn(vararg programs: Program) {
        dependsOn += declared(programs, "an install variant").map { it.name }
    }

    /** An installer param by name, for installers without a typed wrapper. */
    fun param(name: String, value: String) {
        with[name] = value
    }

    internal fun build(installer: String?) = InstallVariant(
        installer = installer,
        pkg = pkg,
        command = command,
        check = check,
        regex = regex,
        present = present,
        probe = probe,
        outdated = outdated,
        with = with,
        sudo = sudo,
        dependsOn = dependsOn.distinct(),
    )
}

// Typed wrappers for the built-in param installers: a param is a named
// argument, so a missing one doesn't compile.

/** A vendor rpm repository: [repofile] is a URL or `file("…")`. `installVia(dnfRepo(repofile = …))`. */
fun dnfRepo(repofile: String, pkg: String? = null, block: VariantScope.() -> Unit = {}): InstallMethod =
    Builtin.dnfRepo(pkg) { param("repofile", repofile); block() }

/** A COPR, enabled before the install. `installVia(dnfCopr(copr = …))`. */
fun dnfCopr(copr: String, pkg: String? = null, block: VariantScope.() -> Unit = {}): InstallMethod =
    Builtin.dnfCopr(pkg) { param("copr", copr); block() }

// ─── Scripts ───────────────────────────────────────────────────────────

/** What a machine runs: a script, or one variant of it. */
sealed interface Runnable

class Script internal constructor(
    override val name: String,
    val variants: List<String>,
) : Step, Runnable {
    fun variant(name: String): ScriptVariant = ScriptVariant(this, name)
}

class ScriptVariant internal constructor(val script: Script, val name: String) : Runnable

class ScriptScope internal constructor(private val dir: Dir, private val name: String) {
    private var file: String? = null
    private var run: String? = null
    private var check: String? = null
    private val after = mutableListOf<String>()
    private var sudo = false
    private var modes = listOf("setup", "maintain")
    private val variants = linkedMapOf<String, ScriptStep>()
    internal val outdatedSources = mutableListOf<Pair<String?, OutdatedSource>>()

    /**
     * Done by a managing [script]: `<script>` does the step, `<script> check`
     * says whether it's done. The machine's arguments reach both.
     */
    fun managedBy(script: String) {
        file = script
        check = "file:$script check \"\$@\""
    }

    fun file(path: String) {
        file = path
    }

    /** An inline script: the [commands] in order, stopping at the first that fails. */
    fun run(command: String, vararg more: String) {
        run = allOf(listOf(command) + more)
    }

    /** Done when every one of the [commands] passes (each one line, in order). */
    fun check(command: String, vararg more: String) {
        check = allOf(listOf(command) + more)
    }

    fun runAfter(vararg steps: Step) {
        after += declared(steps, "script '$name'").map {
            when (it) {
                is Program -> "programs.${it.name}"
                is Script -> "scripts.${it.name}"
            }
        }
    }

    fun needsSudo() {
        sudo = true
    }

    /** Runs only in setup-new-machine's converge. */
    fun setupOnly() {
        modes = listOf("setup")
    }

    /** Runs only from the home screen's scripts list. */
    fun maintainOnly() {
        modes = listOf("maintain")
    }

    /** One step, several ways, picked by the machine: `run(t2HidAppleKeyboard.variant(name = "arch"))`. */
    fun variant(name: String, block: ScriptScope.() -> Unit) {
        val scope = ScriptScope(dir, this.name).apply(block)
        if (variants.put(name, scope.build("")) != null) registry.errors += "a script has two '$name' variants"
    }

    /** A custom outdated source attached to this script, named after it unless [name] says otherwise. */
    fun outdated(command: String, upgrade: String? = null, name: String? = null) {
        outdatedSources += name to OutdatedSource(command, upgrade, origin = dir.path)
    }

    /**
     * What this script keeps is checked for updates by a [script] of the
     * repo's: `<script>` lists what's behind (`<item> <current> <candidate>`
     * lines), `<script> update <item>` updates one. The source is named after
     * this script unless [name] says otherwise.
     */
    fun updatesManagedBy(script: String, name: String? = null) =
        outdated(command = "file:$script", upgrade = "file:$script update {item}", name = name)

    internal fun variantNames(): List<String> = variants.keys.toList()

    internal fun build(description: String) = ScriptStep(
        description = description,
        file = file,
        run = run,
        check = check,
        after = after.distinct(),
        modes = modes,
        sudo = sudo,
        variants = variants,
        origin = dir.path,
    )
}

/**
 * [commands] joined with `&&`. One holding `||` or `;` is grouped in
 * `{ …; }` first, so the join can't change what it means.
 */
internal fun allOf(commands: List<String>): String = commands.joinToString(" && ") { command ->
    if ("||" in command || ";" in command) "{ $command; }" else command
}

// ─── Machines and profiles ─────────────────────────────────────────────

class Profile internal constructor(val name: String)

class Machine internal constructor(val hostname: String)

fun profile(name: String, block: MachineScope.() -> Unit): Profile {
    val label = "profile '$name'"
    registry.add("profile", name, registry.profiles, MachineScope(label).apply(block).build())
    return Profile(name)
}

/** A machine, named by its hostname. */
fun machine(hostname: String, block: MachineScope.() -> Unit): Machine {
    val label = "machine '$hostname'"
    registry.add("machine", hostname, registry.machines, MachineScope(label).apply(block).build())
    return Machine(hostname)
}

/**
 * The body of a machine or a profile: two verbs, `install` and `run`. Merge
 * rules are contract 2's.
 */
class MachineScope internal constructor(private val label: String) {
    private val extends = mutableListOf<String>()
    private val pm = linkedMapOf<String, String>()
    private val scripts = mutableListOf<String>()
    private val scriptVariants = linkedMapOf<String, String>()
    private var data = MachineData.EMPTY_JSON

    fun extends(vararg profiles: Profile) {
        extends += declared(profiles, label).map { it.name }
    }

    /**
     * Programs with exactly one variant (nothing to choose) and named
     * variants, mixed freely. A program with several variants and none named
     * is an error that names its variants.
     */
    fun install(vararg programs: Installable) {
        for (item in declared(programs, label)) {
            when (item) {
                is ProgramVariant -> map(item.program.name, item.name)
                is Program -> item.variants.singleOrNull()?.let { map(item.name, it) }
                    ?: run {
                        registry.errors += if (item.variants.isEmpty()) {
                            "$label installs '${item.name}', which has no install variants"
                        } else {
                            "$label installs '${item.name}' without saying how (it has: ${item.variants.joinToString()})"
                        }
                    }
            }
        }
    }

    fun install(programs: List<Installable>) = install(*programs.toTypedArray())

    /** Each program through its [installer] variant. */
    fun install(installer: Installer, vararg programs: Program) {
        declared(programs, label).forEach { map(it.name, installer.name) }
    }

    fun install(installer: Installer, programs: List<Program>) = install(installer, *programs.toTypedArray())

    fun run(vararg scripts: Runnable) {
        declared(scripts, label).forEach { add(it, emptyList()) }
    }

    fun run(scripts: List<Runnable>) = run(*scripts.toTypedArray())

    /**
     * Each argument is one or more words; one per line reads (and comments)
     * well. [first] is separate so `run(x)` means only the argument-less form.
     */
    fun run(script: Runnable, first: String, vararg more: String) =
        add(declared(arrayOf(script), label).single(), listOf(first) + more)

    fun <D : MachineData> data(schema: () -> D, block: D.() -> Unit) {
        val values = schema().apply(block)
        data = loadout.core.manifest.MachineData.merge(data, values.written())
    }

    private fun map(program: String, variant: String) {
        if (pm.put(program, variant) != null) registry.errors += "$label installs '$program' twice"
    }

    private fun add(item: Runnable, args: List<String>) {
        val script = when (item) {
            is Script -> item
            is ScriptVariant -> item.script.also { scriptVariants[it.name] = item.name }
        }
        if (scripts.any { loadout.core.model.scriptEntry(it).first == script.name }) {
            registry.errors += "$label runs '${script.name}' twice"
            return
        }
        scripts += (listOf(script.name) + args).joinToString(" ")
    }

    internal fun build() = MachineConfig(
        extends = extends.toList(),
        pm = pm,
        scripts = scripts.toList(),
        scriptVariants = scriptVariants,
        data = data,
        label = label,
    )
}
