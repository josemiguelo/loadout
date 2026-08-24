package loadout.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class Manifest(
    val meta: Meta = Meta(),
    /**
     * Install mechanisms (`dnf`, `brew-cask`, ...) defined once per repo.
     * Probe, install/check patterns, and regex are properties of the
     * mechanism; programs reference installers instead of restating them.
     */
    val installers: Map<String, Installer> = emptyMap(),
    val programs: Map<String, Program> = emptyMap(),
    val scripts: Map<String, ScriptStep> = emptyMap(),
    /** Optional per-machine settings, keyed by machine name. */
    val machines: Map<String, MachineConfig> = emptyMap(),
    /**
     * Reusable program patterns. `{name}` in a template's string fields is
     * replaced with the program name at expansion. Used two ways: the
     * template's own `packages` list, or `template = "<name>"` on a program.
     */
    val templates: Map<String, Template> = emptyMap(),
) {
    /**
     * Everything the [key] variant of program [programName] resolves to.
     * Assumes the manifest validated (program and key exist).
     */
    fun resolveInstall(programName: String, key: String): ResolvedInstall {
        val program = programs.getValue(programName)
        val variant = program.install.getValue(key)
        // An explicit `installer = ...` reference wins; otherwise a variant
        // whose key names an installer uses it (`via` expands to exactly this).
        val installer = variant.installer?.let(installers::get)
            ?: if (variant.installer == null) installers[key] else null
        val pkg = variant.pkg ?: programName
        fun sub(s: String) = s.replace("{pkg}", pkg)
        val checkCommand = variant.check ?: installer?.check
        val regex = variant.regex ?: installer?.regex
        // Outdated precedence: explicit per-variant oracle, else the
        // installer's batch oracle (one command for all its packages), else
        // the installer's per-package pattern.
        val explicitOutdated = variant.outdated
        val batch = if (explicitOutdated == null) installer?.outdatedAll else null
        val outdatedCommand = explicitOutdated ?: if (batch == null) installer?.outdated else null
        val installerName = variant.installer ?: key.takeIf { installers.containsKey(it) }
        return ResolvedInstall(
            command = (variant.command ?: installer?.install)?.let(::sub),
            check = if (checkCommand != null && regex != null) {
                VersionCheck(sub(checkCommand), regex)
            } else {
                program.version
            },
            probe = variant.probe ?: installer?.probe,
            outdated = if (outdatedCommand != null && regex != null) {
                VersionCheck(sub(outdatedCommand), regex)
            } else {
                null
            },
            outdatedAll = if (batch != null && regex != null && installerName != null) {
                BatchOracle(installerName, batch, pkg, regex)
            } else {
                null
            },
        )
    }

    /** The version check to observe [programName] with when mapped to [key] (null = unmapped). */
    fun checkFor(programName: String, key: String?): VersionCheck? =
        if (key == null) programs[programName]?.version else resolveInstall(programName, key).check
}

/** A program's install variant with all installer defaults applied. */
data class ResolvedInstall(
    /** Shell command to install (null only in invalid manifests — validation rejects it). */
    val command: String?,
    /** Version check for this variant, falling back to the program's `[version]`. */
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
)

@Serializable
data class Installer(
    /** Binary that must exist (`command -v`) before installing via this mechanism. */
    val probe: String? = null,
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
     * Batch form of [outdated]: ONE command printing a `<pkg> <candidate>`
     * line per outdated package this installer manages. When present it
     * replaces the per-package [outdated] pattern (which older binaries
     * still fall back to — the field is ignored by them).
     */
    @SerialName("outdated-all")
    val outdatedAll: String? = null,
)

/**
 * One entry of a program's install table. Every field is optional: `installer`
 * (or a key that names one) supplies defaults, and `pkg` defaults to the
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
    /** Probe binary, replacing the installer's. */
    val probe: String? = null,
    /** Remote-candidate command, replacing the installer's (see [Installer.outdated]). */
    val outdated: String? = null,
)

@Serializable
data class Template(
    val version: VersionCheck? = null,
    /** Installer names expanded into install variants, like [Program.via]. */
    val via: List<String> = emptyList(),
    val install: Map<String, InstallVariant> = emptyMap(),
    /** Program names to expand from this template where it is defined. */
    val packages: List<String> = emptyList(),
    /** Per-package field overrides; keys must be members of [packages]. */
    val overrides: Map<String, Program> = emptyMap(),
)

@Serializable
data class MachineConfig(
    /**
     * Marks a parent config ("fedora", "macos", ...) that real machines
     * `extends`-reference. Bases are flattened into their children at load
     * and are NOT machines: never observed, never diffed, never converged.
     */
    val base: Boolean = false,
    /**
     * Name of the base config this machine inherits (a `base = true` file).
     * `[pm]` merges per key (this file wins); `scripts` is a union where a
     * same-named entry here replaces the base's (args included). Bases may
     * extend bases; real machines may only extend bases.
     */
    val extends: String? = null,
    /**
     * Which entry of each program's `install` table this machine uses,
     * keyed by program name. Every program a machine installs must be mapped.
     */
    val pm: Map<String, String> = emptyMap(),
    /**
     * Scripts this machine opts into: entries are `"name"` or
     * `"name args..."` (first word = script name, rest = arguments passed as
     * positional parameters to `file` scripts and their checks). Scripts run
     * and are observed only on machines that opt in.
     */
    val scripts: List<String> = emptyList(),
) {
    /** [scripts] parsed into script name -> argument string. */
    fun scriptArgs(): Map<String, String> = scripts.associate { entry ->
        entry.substringBefore(' ') to entry.substringAfter(' ', "").trim()
    }
}

@Serializable
data class Meta(
    val name: String = "",
    @SerialName("min-tool-version")
    val minToolVersion: String? = null,
)

/**
 * Commands starting with this prefix (install variant `command`s and any
 * check command) name a script file relative to the repo root — validated to
 * exist at manifest load — instead of an inline command. Tokens after the
 * first space are arguments, so the path itself can't contain spaces.
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

@Serializable
data class Program(
    val description: String = "",
    /** Name of a [Template] this program is expanded from (resolved at manifest load). */
    val template: String? = null,
    val tags: List<String> = emptyList(),
    @SerialName("depends-on")
    val dependsOn: List<String> = emptyList(),
    /** Variant-independent version check; the fallback when a variant resolves no check. */
    val version: VersionCheck? = null,
    /**
     * Installer names this program installs through with all defaults —
     * shorthand expanded into [install] entries at manifest load.
     */
    val via: List<String> = emptyList(),
    /**
     * Install variants keyed by arbitrary labels — installer names (`dnf`) or
     * custom variants (`script`, `brew-linux`). Each machine's mapping in
     * `machines/<name>.toml` picks which key to use.
     */
    val install: Map<String, InstallVariant> = emptyMap(),
)

@Serializable
data class VersionCheck(
    val command: String,
    val regex: String,
)

@Serializable
data class ScriptStep(
    val description: String = "",
    /** Script file to execute, relative to the config repo root. Exactly one of [file]/[run]. */
    val file: String? = null,
    /** Inline shell command to execute. Exactly one of [file]/[run]. */
    val run: String? = null,
    /** OS families this step applies to; empty = all. */
    val os: List<String> = emptyList(),
    /** Shell command; exit 0 means the step is already done and is skipped. */
    val check: String? = null,
    /** Ordering constraints: entries like "programs.git" or "scripts.dotfiles". */
    val after: List<String> = emptyList(),
    /**
     * Execution surfaces this script participates in: "setup"
     * (setup-new-machine's converge) and/or "maintain" (the maintain picker).
     * Default: both. Governs execution only — `status` observes every opted-in
     * script regardless, and `run <name>` is the explicit escape hatch.
     */
    val modes: List<String> = listOf("setup", "maintain"),
) {
    fun appliesTo(osFamily: OsFamily): Boolean = os.isEmpty() || os.contains(osFamily.id)

    fun runsIn(mode: String): Boolean = mode in modes
}
