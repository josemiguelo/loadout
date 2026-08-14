package io.github.josemiguelo.postinstaller.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class MachineState(
    val schemaVersion: Int = 1,
    val machine: String,
    val os: String,
    val distro: String? = null,
    val arch: String,
    val packageManager: String? = null,
    val toolVersion: String,
    /** ISO-8601 UTC timestamp of the last state refresh. */
    val updatedAt: String,
    val programs: Map<String, ProgramState> = emptyMap(),
    val scripts: Map<String, ScriptState> = emptyMap(),
)

@Serializable
data class ProgramState(
    val status: ProgramStatus,
    val version: String? = null,
)

@Serializable
enum class ProgramStatus {
    @SerialName("installed")
    INSTALLED,

    @SerialName("missing")
    MISSING,

    /** The program declares no version check, so its presence cannot be determined. */
    @SerialName("unknown")
    UNKNOWN,
}

@Serializable
data class ScriptState(
    val status: ScriptStatus,
    val lastRun: String? = null,
    val exitCode: Int? = null,
)

@Serializable
enum class ScriptStatus {
    @SerialName("done")
    DONE,

    @SerialName("failed")
    FAILED,

    @SerialName("pending")
    PENDING,
}
