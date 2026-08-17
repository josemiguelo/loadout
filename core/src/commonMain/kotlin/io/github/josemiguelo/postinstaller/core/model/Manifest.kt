package io.github.josemiguelo.postinstaller.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class Manifest(
    val meta: Meta = Meta(),
    val programs: Map<String, Program> = emptyMap(),
    val scripts: Map<String, ScriptStep> = emptyMap(),
    /** Optional per-machine settings, keyed by machine name. */
    val machines: Map<String, MachineConfig> = emptyMap(),
)

@Serializable
data class MachineConfig(
    /**
     * Which entry of each program's `install` table this machine uses,
     * keyed by program name. Every program a machine installs must be mapped.
     */
    val pm: Map<String, String> = emptyMap(),
)

@Serializable
data class Meta(
    val name: String = "",
    @SerialName("min-tool-version")
    val minToolVersion: String? = null,
)

/**
 * Install values starting with this prefix name a script file relative to the
 * repo root (validated to exist at manifest load) instead of an inline command.
 */
const val INSTALL_FILE_PREFIX: String = "file:"

@Serializable
data class Program(
    val description: String = "",
    val tags: List<String> = emptyList(),
    @SerialName("depends-on")
    val dependsOn: List<String> = emptyList(),
    val version: VersionCheck? = null,
    /**
     * Install commands keyed by arbitrary labels — package-manager ids
     * (`brew`, `dnf`, ...) or custom variants (`script`, `script-fedora`, ...).
     * Each machine's `[machines.<name>.pm]` mapping picks which key to use.
     */
    val install: Map<String, String> = emptyMap(),
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
) {
    fun appliesTo(osFamily: OsFamily): Boolean = os.isEmpty() || os.contains(osFamily.id)
}
