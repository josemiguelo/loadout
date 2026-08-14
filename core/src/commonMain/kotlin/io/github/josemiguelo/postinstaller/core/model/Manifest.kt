package io.github.josemiguelo.postinstaller.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class Manifest(
    val meta: Meta = Meta(),
    val programs: Map<String, Program> = emptyMap(),
    val scripts: Map<String, ScriptStep> = emptyMap(),
)

@Serializable
data class Meta(
    val name: String = "",
    @SerialName("min-tool-version")
    val minToolVersion: String? = null,
)

@Serializable
data class Program(
    val description: String = "",
    val tags: List<String> = emptyList(),
    @SerialName("depends-on")
    val dependsOn: List<String> = emptyList(),
    val version: VersionCheck? = null,
    /** Install command keyed by package-manager id, or [INSTALL_SCRIPT_KEY] for a PM-independent command. */
    val install: Map<String, String> = emptyMap(),
) {
    fun installCommandFor(pm: PackageManager?): String? =
        pm?.let { install[it.id] } ?: install[INSTALL_SCRIPT_KEY]
}

@Serializable
data class VersionCheck(
    val command: String,
    val regex: String,
)

@Serializable
data class ScriptStep(
    val description: String = "",
    /** Path of the script to run, relative to the config repo root, or an inline shell command. */
    val run: String,
    /** OS families this step applies to; empty = all. */
    val os: List<String> = emptyList(),
    /** Shell command; exit 0 means the step is already done and is skipped. */
    val check: String? = null,
    /** Ordering constraints: entries like "programs.git" or "scripts.dotfiles". */
    val after: List<String> = emptyList(),
) {
    fun appliesTo(osFamily: OsFamily): Boolean = os.isEmpty() || os.contains(osFamily.id)
}
