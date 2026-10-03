package loadout.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonObject

@Serializable
data class Manifest(
    val meta: Meta = Meta(),
    /** Where the repo's parts live; required in the root file, refused in fragments. */
    val layout: Layout? = null,
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
     * Custom `loadout outdated` oracles beyond the installer ones —
     * `[outdated.<name>]` entries whose command prints one
     * `<item> <current> <candidate>` line per outdated item (nothing when
     * current). The entry name becomes the row's source tag. The built-in
     * self-version row is conceptually the first of these, hardcoded.
     */
    val outdated: Map<String, OutdatedSource> = emptyMap(),
    /**
     * Which of [installers] came from [loadout.core.manifest.InstallerLibrary]
     * rather than the repo — provenance for `explain`/`installers`, never
     * behavior. Not a manifest field: loadRepo fills it in.
     */
    @Transient val builtinInstallers: Set<String> = emptySet(),
    /** loadout.toml's `[data]`: every per-machine key with its default. Filled by loadRepo. */
    @Transient val data: JsonObject = JsonObject(emptyMap()),
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
        // {pkg} plus whatever the installer declared as params — validated at
        // load, so an unsubstituted placeholder can't reach a shell here.
        val values = mapOf("pkg" to pkg) + variant.with
        fun sub(s: String) = values.entries.fold(s) { acc, (key, value) -> acc.replace("{$key}", value) }
        val checkCommand = variant.check ?: installer?.check
        val regex = variant.regex ?: installer?.regex
        // Outdated precedence: explicit per-variant oracle, else the
        // installer's batch oracle (one command for all its packages), else
        // the installer's per-package pattern.
        val explicitOutdated = variant.outdated
        val batch = if (explicitOutdated == null) installer?.outdatedAll else null
        val outdatedCommand = explicitOutdated ?: if (batch == null) installer?.outdated else null
        val installerName = variant.installer ?: key.takeIf { installers.containsKey(it) }
        val probe = variant.probe ?: installer?.probe
        // Each command runs where the file that wrote it lives: a variant's
        // own override in the program's directory, a pattern in its installer's.
        val installerOrigin = installer?.origin.orEmpty()
        fun originOf(override: String?) = if (override != null) program.origin else installerOrigin
        return ResolvedInstall(
            command = (variant.command ?: installer?.install)?.let(::sub),
            commandOrigin = originOf(variant.command),
            // A check through the mechanism carries its probe; the program's
            // own `[version]` fallback is the program itself and carries none.
            check = if (checkCommand != null && regex != null) {
                VersionCheck(sub(checkCommand), regex, probe = probe, origin = originOf(variant.check))
            } else {
                program.version
            },
            probe = probe,
            outdated = if (outdatedCommand != null && regex != null) {
                VersionCheck(sub(outdatedCommand), regex, origin = originOf(explicitOutdated))
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
        )
    }

    /** The version check to observe [programName] with when mapped to [key] (null = unmapped). */
    fun checkFor(programName: String, key: String?): VersionCheck? =
        if (key == null) programs[programName]?.version else resolveInstall(programName, key).check

    /**
     * What [programName] needs installed first on a machine mapping it to
     * [key]: the program's own `depends-on`, then that variant's (a COPR
     * needs dnf-plugins-core; the same program from pacman needs nothing).
     * A null [key] (no machine in view) gives the program's alone.
     */
    fun dependenciesOf(programName: String, key: String?): List<String> {
        val program = programs[programName] ?: return emptyList()
        val variant = key?.let { program.install[it] }
        return (program.dependsOn + variant?.dependsOn.orEmpty()).distinct()
    }
}

/** A program's install variant with all installer defaults applied. */
data class ResolvedInstall(
    /** Shell command to install (null only in invalid manifests — validation rejects it). */
    val command: String?,
    /** Where [command] runs: the declaring file's repo-relative directory. */
    val commandOrigin: String = "",
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
    /** How this variant upgrades in place, when its mechanism can. */
    val upgradeWith: UpgradeMechanism? = null,
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
     * a missing declared one are both load errors. "pkg" is reserved.
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
     * Batch form of [outdated]: ONE command printing a `<pkg> <candidate>`
     * line per outdated package this installer manages. When present it
     * replaces the per-package [outdated] pattern (which older binaries
     * still fall back to — the field is ignored by them).
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
     * Obsolete: parsed so existing manifests load, otherwise ignored.
     * Commands run on the terminal, where sudo prompts for itself. Same for
     * `sudo` on install variants, scripts and `[outdated.*]` sources.
     */
    val sudo: Boolean = false,
    /** Repo-relative directory of the declaring file ("" = repo root): paths resolve and commands run there. Set at load. */
    @Transient val origin: String = "",
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
    /**
     * Values for the installer's [Installer.params], as a nested table:
     * `[programs.kitty.install.dnf-copr.with]` / `copr = "solopasha/kitty"`.
     * Each becomes `{copr}` in the resolved commands.
     */
    val with: Map<String, String> = emptyMap(),
    /** Obsolete and ignored; see [Installer.sudo]. */
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
 * A machine (or profile) as the engines see it: the groups of its file
 * folded into one program mapping and one script list. Machine and profile
 * files are read by `MachineFile` from the TOML tree; the serializable form
 * (`[machines.<name>]` with `pm`/`scripts`) exists only for the test-only
 * `ManifestLoader.parse`.
 */
@Serializable
data class MachineConfig(
    /**
     * A profile (a `[layout] profiles` file), not a machine: flattened into
     * the machines extending it, then dropped — never observed, diffed or
     * converged. Set by the loader from the file's folder.
     */
    @Transient val base: Boolean = false,
    /**
     * Profiles this file builds on, in order. Their settings come first and
     * this file's override them; two of them setting the same thing
     * differently is a load error. Profiles may extend profiles.
     */
    val extends: List<String> = emptyList(),
    /**
     * Which entry of each program's `install` table this machine uses,
     * keyed by program name, from the groups' `install`. Every program a
     * machine installs must be mapped.
     */
    val pm: Map<String, String> = emptyMap(),
    /**
     * Scripts this machine opts into: entries are `"name"` or
     * `"name args..."` (first word = script name, rest = arguments passed as
     * positional parameters to `file` scripts and their checks). Any
     * whitespace separates words, newlines included, so a long entry can be a
     * TOML multi-line string. Scripts run and are observed only on machines
     * that opt in.
     */
    val scripts: List<String> = emptyList(),
    /**
     * This file's `[data]` overrides (each group's `[<group>.data]` under
     * the group's name), read from the TOML tree at load; after flattening,
     * the machine's whole data (defaults, profiles, own). Not decoded.
     */
    @Transient val data: JsonObject = JsonObject(emptyMap()),
    /** This file's own groups, as written, for `explain`. */
    @Transient val groups: Map<String, MachineGroup> = emptyMap(),
    /** The file it was read from, repo-relative, for messages. */
    @Transient val label: String = "",
) {
    /** [scripts] parsed into script name -> argument string (see [scriptEntry]). */
    fun scriptArgs(): Map<String, String> = scripts.associate(::scriptEntry)
}

/** One `[<group>]` table of a machine or profile file: a tool or concern. */
data class MachineGroup(
    /** program -> install key: `install = "x"` maps the program named like the group. */
    val install: Map<String, String> = emptyMap(),
    /** Script opt-ins, `"name"` or `"name args…"`. */
    val scripts: List<String> = emptyList(),
)

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
 * The root file's `[layout]`, as written: every key but [configs] is
 * required, so the fields stay nullable for the loader to name what's
 * missing. Paths are relative to the repo root.
 */
@Serializable
data class Layout(
    /** Globs of fragment files, loaded in this order (path-sorted within one). */
    val fragments: List<String>? = null,
    val machines: String? = null,
    /** Profiles: what machines of a kind share, `extends`-referenced, never machines. */
    val profiles: String? = null,
    val state: String? = null,
    /** The chezmoi source root, when the repo holds dotfiles. */
    val configs: String? = null,
)

/** A validated [Layout]: what the rest of the tool reads. */
data class RepoLayout(
    val fragments: List<String>,
    val machines: String,
    val profiles: String? = null,
    val state: String,
    val configs: String? = null,
)

/**
 * Commands starting with this prefix (install variant `command`s, installer
 * patterns, oracles and any check command) name a script file relative to
 * the declaring file's directory — where the command also runs — validated
 * at manifest load to exist inside the repo, instead of an inline command.
 * Tokens after the first space are arguments, so the path itself can't
 * contain spaces.
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
    /** Repo-relative directory of the declaring file ("" = repo root): paths resolve and commands run there. Set at load. */
    @Transient val origin: String = "",
)

@Serializable
data class VersionCheck(
    val command: String,
    val regex: String,
    /**
     * The tool this check asks through (the installer's probe), when the
     * check isn't the program's own binary. Set by resolveInstall, never a
     * manifest key: it's what lets "brew: command not found" mean "couldn't
     * ask" instead of "not installed".
     */
    @Transient val probe: String? = null,
    /** Repo-relative directory of the declaring file ("" = repo root): paths resolve and commands run there. Set at load. */
    @Transient val origin: String = "",
)

@Serializable
data class ScriptStep(
    val description: String = "",
    /** Script file to execute, relative to the declaring file's directory. Exactly one of [file]/[run]. */
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
     * (setup-new-machine's converge) and/or "maintain" (the home screen's scripts picker).
     * Default: both. Governs execution only — `status` observes every opted-in
     * script regardless, and `run <name>` is the explicit escape hatch.
     */
    val modes: List<String> = listOf("setup", "maintain"),
    /** Obsolete and ignored; see [Installer.sudo]. */
    val sudo: Boolean = false,
    /** Repo-relative directory of the declaring file ("" = repo root): paths resolve and commands run there. Set at load. */
    @Transient val origin: String = "",
) {
    fun appliesTo(osFamily: OsFamily): Boolean = os.isEmpty() || os.contains(osFamily.id)

    fun runsIn(mode: String): Boolean = mode in modes
}

/** One `[outdated.<name>]` custom oracle; see [Manifest.outdated]. */
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
    /** Obsolete and ignored; see [Installer.sudo]. */
    val sudo: Boolean = false,
    /** Repo-relative directory of the declaring file ("" = repo root): paths resolve and commands run there. Set at load. */
    @Transient val origin: String = "",
)
