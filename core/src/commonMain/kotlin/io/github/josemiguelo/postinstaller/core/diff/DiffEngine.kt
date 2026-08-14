package io.github.josemiguelo.postinstaller.core.diff

import io.github.josemiguelo.postinstaller.core.model.MachineState
import io.github.josemiguelo.postinstaller.core.model.Manifest
import io.github.josemiguelo.postinstaller.core.model.ProgramStatus

sealed interface InstallState {
    data class Installed(val version: String?) : InstallState
    data object Missing : InstallState
    /** No state entry for this program (stale state file or check failed to parse). */
    data object Unknown : InstallState
}

data class ProgramRow(
    val program: String,
    val perMachine: Map<String, InstallState>,
) {
    /** Two or more machines report distinct installed versions. */
    val drift: Boolean =
        perMachine.values
            .filterIsInstance<InstallState.Installed>()
            .mapNotNull { it.version }
            .distinct()
            .size > 1

    /** At least one machine is missing this program. */
    val incomplete: Boolean = perMachine.values.any { it is InstallState.Missing }
}

data class DiffReport(
    val machines: List<String>,
    val rows: List<ProgramRow>,
) {
    val hasDrift: Boolean = rows.any { it.drift }
    val hasMissing: Boolean = rows.any { it.incomplete }
}

object DiffEngine {
    fun diff(manifest: Manifest, states: Collection<MachineState>): DiffReport {
        val machines = states.map { it.machine }.sorted()
        val byMachine = states.associateBy { it.machine }

        val rows = manifest.programs.keys.sorted().map { program ->
            ProgramRow(
                program = program,
                perMachine = machines.associateWith { machine ->
                    val entry = byMachine.getValue(machine).programs[program]
                    when (entry?.status) {
                        ProgramStatus.INSTALLED -> InstallState.Installed(entry.version)
                        ProgramStatus.MISSING -> InstallState.Missing
                        ProgramStatus.UNKNOWN, null -> InstallState.Unknown
                    }
                },
            )
        }
        return DiffReport(machines, rows)
    }
}
