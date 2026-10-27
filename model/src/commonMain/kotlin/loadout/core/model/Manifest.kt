package loadout.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonObject

/**
 * A config repo, resolved: what the DSL compiles to, what loadout.lock.json
 * holds, and what every engine reads. Machines are already flattened
 * (profiles merged in, then dropped) and carry their whole data.
 */
@Serializable
data class Manifest(
    val meta: Meta = Meta(),
    val layout: RepoLayout = RepoLayout(),
    /**
     * Install mechanisms (`dnf`, `brew-cask`, ...) defined once per repo.
     * Probe, install/check patterns, and regex are properties of the
     * mechanism; programs reference installers instead of restating them.
     */
    val installers: Map<String, Installer> = emptyMap(),
    val programs: Map<String, Program> = emptyMap(),
    val scripts: Map<String, ScriptStep> = emptyMap(),
    /** Every machine, keyed by hostname. */
    val machines: Map<String, MachineConfig> = emptyMap(),
    /**
     * Custom `loadout outdated` oracles beyond the installer ones —
     * entries whose command prints one `<item> <current> <candidate>` line
     * per outdated item (nothing when current). The entry name becomes the
     * row's source tag. The built-in self-version row is conceptually the
     * first of these, hardcoded.
     */
    val outdated: Map<String, OutdatedSource> = emptyMap(),
    /**
     * Which of installers came from [loadout.core.manifest.InstallerLibrary]
     * rather than the repo — provenance for `explain`/`installers`, never
     * behavior.
     */
    val builtinInstallers: Set<String> = emptySet(),
    /** Every per-machine data key with its default. */
    val data: JsonObject = JsonObject(emptyMap()),
) {
    /**
     * Everything the [key] variant of program [programName] resolves to.
     * Assumes the manifest validated (program and key exist).
     */
    fun resolveInstall(programName: String, key: String): ResolvedInstall {
        val program = programs.getValue(programName)
        val variant = program.install.getValue(key)
        // An explicit `installer` reference wins; otherwise a variant whose
        // key names an installer uses it.
        val installer = variant.installer?.let(installers::get)
            ?: if (variant.installer == null) installers[key] else null
        val pkg = variant.pkg ?: programName
        // {pkg} plus whatever the installer declared as params — validated at
        // compile, so an unsubstituted placeholder can't reach a shell here.
        val values = mapOf("pkg" to pkg) + variant.with
        fun sub(s: String) = values.entries.fold(s) { acc, (key, value) -> acc.replace("{$key}", value) }
        val checkCommand = variant.check ?: installer?.check
        // A yes/no check records no version, so it needs no regex.
        val regex = if (variant.present) null else variant.regex ?: installer?.regex
        // Outdated precedence: explicit per-variant oracle, else the program's
        // own check (read with its version regex), else the installer's batch
        // oracle (one command for all its packages), else the installer's
        // per-package pattern.
        val explicitOutdated = variant.outdated ?: program.outdated?.command
        val outdatedRegex = if (variant.outdated == null && program.outdated != null) program.version?.regex else regex
        val batch = if (explicitOutdated == null) installer?.outdatedAll else null
        val outdatedCommand = explicitOutdated ?: if (batch == null) installer?.outdated else null
        val installerName = variant.installer ?: key.takeIf { installers.containsKey(it) }
        val probe = variant.probe ?: installer?.probe
        // Each command runs where the file that wrote it lives: a variant's
        // own override in the program's directory, a pattern in its installer's.
        val installerOrigin = installer?.origin.orEmpty()
        fun originOf(override: String?) = if (override != null) program.origin else installerOrigin
        return ResolvedInstall(
            sudo = variant.sudo ?: installer?.sudo ?: false,
            command = (variant.command ?: installer?.install)?.let(::sub),
            commandOrigin = originOf(variant.command),
            // A check through the mechanism carries its probe; the program's
            // own `version` fallback is the program itself and carries none.
            check = if (checkCommand != null && (regex != null || variant.present)) {
                VersionCheck(sub(checkCommand), regex, probe = probe, origin = originOf(variant.check), path = program.path)
            } else {
                program.version
            },
            probe = probe,
            outdated = if (outdatedCommand != null && outdatedRegex != null) {
                VersionCheck(sub(outdatedCommand), outdatedRegex, origin = originOf(explicitOutdated), path = program.path)
            } else {
                null
            },
            outdatedAll = if (batch != null && regex != null && installerName != null) {
                BatchOracle(installerName, batch, pkg, regex, installerOrigin)
            } else {
                null
            },
            upgradeWith = installer?.upgrade?.let {
                UpgradeMechanism(installerName ?: return@let null, it, installerOrigin)
            },
            path = program.path,
        )
    }

    /** The version check to observe [programName] with when mapped to [key] (null = unmapped). */
    fun checkFor(programName: String, key: String?): VersionCheck? =
        if (key == null) programs[programName]?.version else resolveInstall(programName, key).check

    /**
     * What [programName] needs installed first on a machine mapping it to
     * [key]: the program's own `depends-on`, that variant's (a COPR needs
     * dnf-plugins-core; the same program from pacman needs nothing), and
     * what the variant's installer requires of everything it installs (brew
     * needs setup-brew), except the program itself. A null [key] (no machine
     * in view) gives the program's alone.
     */
    fun dependenciesOf(programName: String, key: String?): List<String> {
        val program = programs[programName] ?: return emptyList()
        val variant = key?.let { program.install[it] }
        val installer = variant?.let { installers[it.installer ?: key] }
        val required = installer?.requires.orEmpty().filter { it != programName }
        return (program.dependsOn + variant?.dependsOn.orEmpty() + required).distinct()
    }

    /**
     * This manifest as [machine] sees it: each script it runs as a variant
     * becomes that variant, so engines read `scripts[name]` and never ask
     * which variant a machine picked.
     */
    fun forMachine(machine: String): Manifest {
        val picks = machines[machine]?.scriptVariants.orEmpty()
        if (picks.isEmpty()) return this
        return copy(
            scripts = scripts.mapValues { (name, step) -> picks[name]?.let(step::variant) ?: step },
        )
    }
}

/** A program's install variant with all installer defaults applied. */
data class ResolvedInstall(
    /** Shell command to install (null only in invalid manifests — validation rejects it). */
    val command: String?,
    /** Where [command] runs: the declaring file's repo-relative directory. */
    val commandOrigin: String = "",
    /** Version check for this variant, falling back to the program's `version`. */
    val check: VersionCheck?,
    /** Binary that must exist before installing, or null for no probe. */
    val probe: String?,
    /**
     * Command reporting the version available from the remote source (its
     * output should be just the candidate version; the shared regex extracts
     * it), or null when this variant has no update oracle.
     */
    val outdated: VersionCheck?,
    /** The installer's batch oracle covering this variant, when it has one. */
    val outdatedAll: BatchOracle? = null,
    /** How this variant upgrades in place, when its mechanism can. */
    val upgradeWith: UpgradeMechanism? = null,
    /** [command] needs sudo's password without saying `sudo` itself (see [Installer.sudo]). */
    val sudo: Boolean = false,
    /** Directories put first on PATH for [command] (see [Program.path]). */
    val path: List<String> = emptyList(),
)

/** How a variant's mechanism upgrades: all of it, in one command. */
data class UpgradeMechanism(
    val installer: String,
    val command: String,
    /** The installer file's repo-relative directory, where [command] runs. */
    val origin: String = "",
)

/**
 * One installer-wide `outdated-all` command: prints a `<pkg> <candidate>`
 * line per outdated package, so `loadout outdated` asks each remote once
 * instead of once per program. [regex] extracts the version from the
 * candidate token, program by program.
 */
data class BatchOracle(
    val installer: String,
    val command: String,
    val pkg: String,
    val regex: String,
    /** The installer file's repo-relative directory, where [command] runs. */
    val origin: String = "",
)

@Serializable
data class Installer(
    /** Binary that must exist (`command -v`) before installing via this mechanism. */
    val probe: String? = null,
    /**
     * Named values this mechanism needs per program, beyond the package id:
     * `params = ["copr"]` makes `{copr}` substitutable in every pattern
     * below, and every variant using this installer must supply it in its
     * `with` table. Declared, never inferred — an undeclared `with` key and
     * a missing declared one are both errors. "pkg" is reserved.
     */
    val params: List<String> = emptyList(),
    /** Install command pattern; `{pkg}` is replaced with the package id. */
    val install: String? = null,
    /** Version check command pattern; `{pkg}` is replaced with the package id. */
    val check: String? = null,
    /** Regex extracting the version from [check]'s output (capture group 1). */
    val regex: String? = null,
    /**
     * Pattern printing the version available from the remote source for
     * `{pkg}` (nothing when up to date); [regex] extracts it. Powers
     * `loadout outdated`.
     */
    val outdated: String? = null,
    /**
     * Batch form of outdated: ONE command printing a `<pkg> <candidate>`
     * line per outdated package this installer manages. When present it
     * replaces the per-package outdated pattern.
     */
    @SerialName("outdated-all")
    val outdatedAll: String? = null,
    /**
     * Upgrade EVERYTHING this mechanism manages, in one command — there is
     * no per-package form on purpose (contract 15): partial upgrades are
     * unsupported on Arch, discouraged on Fedora, and a package manager
     * resolves its own transaction anyway. Converge never runs this;
     * `loadout upgrade` is the explicit verb.
     */
    val upgrade: String? = null,
    /**
     * [install] and [upgrade] need sudo's password but don't say `sudo`
     * themselves: they call it from inside (`omarchy pkg add`, a `file:`
     * script). A run whose plan holds a step that needs sudo (this, or a
     * command that visibly runs it) asks for the password once, before the
     * first step, and keeps sudo's credentials fresh until it ends. Declared,
     * never guessed: nothing reads a script to find sudo in it. Same for
     * `sudo` on install variants, scripts and `outdated` sources.
     */
    val sudo: Boolean = false,
    /**
     * Programs every program installed through this installer depends on
     * (setup-brew before any brew install). A required program installed
     * through this same installer is exempt from its own rule.
     */
    val requires: List<String> = emptyList(),
    /** Repo-relative directory of the declaring file ("" = repo root): paths resolve and commands run there. */
    val origin: String = "",
)

/**
 * One entry of a program's install table, keyed by its installer's name or,
 * for a command of its own, by a name the program picks. Every field is
 * optional: the installer supplies defaults, and `pkg` defaults to the
 * program name — so the empty variant means "the standard package".
 */
@Serializable
data class InstallVariant(
    /** Installer providing defaults; defaults to the variant key when that names one. */
    val installer: String? = null,
    /** Package id within the installer's namespace; defaults to the program name. */
    val pkg: String? = null,
    /** Full install command, replacing the installer's pattern. `file:` prefix allowed. */
    val command: String? = null,
    /** Version check command, replacing the installer's pattern. */
    val check: String? = null,
    /** Version regex, replacing the installer's. */
    val regex: String? = null,
    /** The check only says yes or no: exit 0 = installed, no version recorded. */
    val present: Boolean = false,
    /** Probe binary, replacing the installer's. */
    val probe: String? = null,
    /** Remote-candidate command, replacing the installer's (see [Installer.outdated]). */
    val outdated: String? = null,
    /** Values for the installer's [Installer.params]; each becomes `{name}` in the resolved commands. */
    val with: Map<String, String> = emptyMap(),
    /** Replaces the installer's [Installer.sudo] for this variant's install command. */
    val sudo: Boolean? = null,
    /**
     * Programs THIS variant needs first, on top of the program's own
     * `depends-on` — for prerequisites of one mechanism only, which would
     * otherwise drag e.g. a dnf package onto a pacman machine.
     */
    @SerialName("depends-on")
    val dependsOn: List<String> = emptyList(),
)

/**
 * A machine as the engines see it: its profiles merged in (contract 2), one
 * program mapping and one script list, and its whole data.
 */
@Serializable
data class MachineConfig(
    /** Profiles this machine was built on, in order; kept for `explain`. */
    val extends: List<String> = emptyList(),
    /**
     * Which entry of each program's `install` table this machine uses, keyed
     * by program name. Every program a machine installs must be mapped.
     */
    val pm: Map<String, String> = emptyMap(),
    /**
     * Scripts this machine runs: entries are `"name"` or `"name args..."`
     * (first word = script name, rest = arguments passed as positional
     * parameters to `file` scripts and their checks). Scripts run and are
     * observed only on machines that opt in.
     */
    val scripts: List<String> = emptyList(),
    /** The variant this machine runs, for each of its scripts that has variants. */
    @SerialName("script-variants")
    val scriptVariants: Map<String, String> = emptyMap(),
    /** The machine's whole data: defaults, profiles, its own. */
    val data: JsonObject = JsonObject(emptyMap()),
    /** What declared it (`machine 'x'`, `profile 'y'`), for messages. */
    @Transient val label: String = "",
) {
    /** scripts parsed into script name -> argument string (see [scriptEntry]). */
    fun scriptArgs(): Map<String, String> = scripts.associate(::scriptEntry)
}

private val WHITESPACE = Regex("\\s+")

/**
 * One `scripts` entry as (name, arguments): words split on any whitespace
 * and the arguments re-joined with single spaces. The arguments are pasted
 * into a shell command line, where a newline would end the command.
 */
fun scriptEntry(entry: String): Pair<String, String> {
    val words = entry.trim().split(WHITESPACE)
    return words.first() to words.drop(1).joinToString(" ")
}

@Serializable
data class Meta(
    val name: String = "",
    @SerialName("min-tool-version")
    val minToolVersion: String? = null,
)

/**
 * Where the repo keeps what loadout writes and reads besides the manifests.
 * Paths are relative to the repo root.
 */
@Serializable
data class RepoLayout(
    /** The state directory: one `<machine>.json` per machine. Required. */
    val state: String = "",
    /** The chezmoi source root, when the repo holds dotfiles. */
    val configs: String? = null,
    /**
     * Globs of the manifest sources, in compile order. The lock's hash covers
     * the files they match, so an edit the lock hasn't seen is refused.
     */
    val sources: List<String> = emptyList(),
    /** The repo this one builds on, for a child repo (contract 18); null for any other. */
    val parent: ParentLayout? = null,
)

/**
 * A child repo's parent, as its lock records it: the public repo whose
 * programs, scripts, installers, profiles and data schema the child's
 * manifests use by name. Its declarations in the child's lock carry
 * [Origin.PARENT] origins and run in [path].
 */
@Serializable
data class ParentLayout(
    /** What messages call it: "parent dotfiles". */
    val name: String,
    /** Its checkout, as `parent(path = …)` wrote it: `~/…`, absolute, or relative to the child's root. */
    val path: String,
    /** Its state directory, read (never written) for the fleet view. */
    val state: String,
    /** Its chezmoi source, applied beside the child's. */
    val configs: String? = null,
    /** Its manifest globs, from its own lock. */
    val sources: List<String> = emptyList(),
    /** sha256 of the files [sources] match ([loadout.core.manifest.LockFile.sourcesHash]): a change is refused until the child recompiles. */
    val hash: String = "",
)

/**
 * A declaration's origin, as the lock records it: the repo-relative folder
 * of the file that wrote it, where its commands run and its `file:` paths
 * resolve. In a child repo's lock, a declaration of its parent's is that
 * folder in the parent, prefixed [PARENT].
 */
object Origin {
    const val PARENT: String = "parent:"

    fun isParent(origin: String): Boolean = origin.startsWith(PARENT)

    /** The folder, relative to its repo's root. */
    fun folder(origin: String): String = origin.removePrefix(PARENT)

    fun ofParent(folder: String): String = PARENT + folder
}

/**
 * Commands starting with this prefix (install variant `command`s, installer
 * patterns, oracles and any check command) name a script file relative to
 * the declaring file's directory — where the command also runs — validated
 * at compile to exist inside the repo, instead of an inline command. Tokens
 * after the first space are arguments, so the path itself can't contain
 * spaces.
 */
const val INSTALL_FILE_PREFIX: String = "file:"

/** Expand a `file:path args…` command to `sh 'path' args…`; others pass through. */
fun expandFilePrefix(command: String): String {
    if (!command.startsWith(INSTALL_FILE_PREFIX)) return command
    val spec = command.removePrefix(INSTALL_FILE_PREFIX)
    val path = spec.substringBefore(' ')
    val args = spec.substringAfter(' ', "")
    return "sh '$path'" + if (args.isNotEmpty()) " $args" else ""
}

/**
 * The shell line for [command]: `file:` expanded, and [path] put first on
 * PATH. The directories are expanded by the shell, so `$HOME` works.
 */
fun shellLine(command: String, path: List<String> = emptyList()): String {
    val line = expandFilePrefix(command)
    if (path.isEmpty()) return line
    return "PATH=\"${path.joinToString(":")}:\$PATH\"; export PATH; $line"
}

@Serializable
data class Program(
    val description: String = "",
    val tags: List<String> = emptyList(),
    @SerialName("depends-on")
    val dependsOn: List<String> = emptyList(),
    /** Variant-independent version check; the fallback when a variant resolves no check. */
    val version: VersionCheck? = null,
    /**
     * Install variants, keyed by installer name (`dnf`) or, for a command of
     * the program's own, by the name it gives it (`linux`). Each machine's
     * mapping picks which key to use.
     */
    val install: Map<String, InstallVariant> = emptyMap(),
    /**
     * This program's own remote check, for programs no installer's oracle
     * covers (a binary that updates itself). Its candidate is read with the
     * program's [version] regex, and [ProgramOutdated.upgrade] moves this one
     * program on its own.
     */
    val outdated: ProgramOutdated? = null,
    /**
     * Directories put first on PATH for this program's commands, for a tool
     * that lands somewhere a fresh shell doesn't look yet (`$HOME/.local/bin`).
     */
    val path: List<String> = emptyList(),
    /** Repo-relative directory of the declaring file ("" = repo root): paths resolve and commands run there. */
    val origin: String = "",
)

/** A program's own `outdated` block: [command] prints the newest version, [upgrade] updates it. */
@Serializable
data class ProgramOutdated(
    /** Prints the newest version available (nothing when up to date); the program's version regex reads it. */
    val command: String,
    /** Updates this program alone. Runs once per upgrade; `{item}` is not substituted. */
    val upgrade: String? = null,
)

@Serializable
data class VersionCheck(
    val command: String,
    /** Extracts the version (capture group 1); null for a yes/no check, which records none. */
    val regex: String? = null,
    /**
     * The tool this check asks through (the installer's probe), when the
     * check isn't the program's own binary. Set by resolveInstall, never
     * declared: it's what lets "brew: command not found" mean "couldn't ask"
     * instead of "not installed".
     */
    @Transient val probe: String? = null,
    /** Repo-relative directory of the declaring file ("" = repo root): paths resolve and commands run there. */
    val origin: String = "",
    /** Directories put first on PATH (see [Program.path]). */
    val path: List<String> = emptyList(),
)

@Serializable
data class ScriptStep(
    val description: String = "",
    /** Script file to execute, relative to the declaring file's directory. Exactly one of [file]/[run]. */
    val file: String? = null,
    /** Inline shell command to execute. Exactly one of [file]/[run]. */
    val run: String? = null,
    /** Shell command; exit 0 means the step is already done and is skipped. */
    val check: String? = null,
    /** Ordering constraints: entries like "programs.git" or "scripts.dotfiles". */
    val after: List<String> = emptyList(),
    /**
     * Execution surfaces this script participates in: "setup"
     * (setup-new-machine's converge) and/or "maintain" (the home screen's scripts picker).
     * Default: both. Governs execution only — `status` observes every opted-in
     * script regardless, and `run <name>` is the explicit escape hatch.
     */
    val modes: List<String> = listOf("setup", "maintain"),
    /** The script needs sudo's password without saying `sudo`; see [Installer.sudo]. */
    val sudo: Boolean = false,
    /**
     * Ways to do this one step, keyed by name; a machine running the script
     * picks one. Each holds its own [file]/[run], [check] and [after]; the
     * step's own description, modes and sudo apply to all of them.
     */
    val variants: Map<String, ScriptStep> = emptyMap(),
    /** Repo-relative directory of the declaring file ("" = repo root): paths resolve and commands run there. */
    val origin: String = "",
) {
    fun runsIn(mode: String): Boolean = mode in modes

    /** The step as variant [name] does it. Assumes the variant exists. */
    fun variant(name: String): ScriptStep {
        val chosen = variants.getValue(name)
        return copy(
            file = chosen.file,
            run = chosen.run,
            check = chosen.check ?: check,
            after = (after + chosen.after).distinct(),
            sudo = sudo || chosen.sudo,
            variants = emptyMap(),
            origin = chosen.origin,
        )
    }
}

/** One custom `outdated` oracle; see [Manifest.outdated]. */
@Serializable
data class OutdatedSource(
    /** Command printing `<item> <current> <candidate>` lines. `file:` allowed. */
    val command: String? = null,
    /**
     * How to update ONE of this source's items: `{item}` is the row name, and
     * the command runs once per row you pick. Per-item on purpose — a pin in
     * a file and a plugin clone are independent, unlike a package manager's
     * transaction (contract 15). Without this, the source's rows are
     * read-only. `file:` allowed.
     */
    val upgrade: String? = null,
    /** [upgrade] needs sudo's password without saying `sudo`; see [Installer.sudo]. */
    val sudo: Boolean = false,
    /** Repo-relative directory of the declaring file ("" = repo root): paths resolve and commands run there. */
    val origin: String = "",
)
