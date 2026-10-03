package loadout.core.diff

import loadout.core.model.ConfigStatus
import loadout.core.model.MachineState
import loadout.core.model.Manifest
import loadout.core.model.ProgramStatus

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

sealed interface ConfigCell {
    data object Applied : ConfigCell
    data class Drifted(val files: Int) : ConfigCell
    /** No state entry: the unit isn't on this machine, or chezmoi couldn't answer. */
    data object Unknown : ConfigCell
}

data class ConfigRow(
    val unit: String,
    val perMachine: Map<String, ConfigCell>,
) {
    /** At least one machine's files differ from the repo. */
    val drifted: Boolean = perMachine.values.any { it is ConfigCell.Drifted }
}

data class DiffReport(
    val machines: List<String>,
    val rows: List<ProgramRow>,
    /** Every config unit any compared machine reports; empty without configs. */
    val configs: List<ConfigRow> = emptyList(),
) {
    val hasDrift: Boolean = rows.any { it.drift }
    val hasMissing: Boolean = rows.any { it.incomplete }
    val hasConfigDrift: Boolean = configs.any { it.drifted }
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
        val configs = states.flatMap { it.configs.keys }.distinct().sorted().map { unit ->
            ConfigRow(
                unit = unit,
                perMachine = machines.associateWith { machine ->
                    val entry = byMachine.getValue(machine).configs[unit]
                    when (entry?.status) {
                        ConfigStatus.APPLIED -> ConfigCell.Applied
                        ConfigStatus.DRIFTED -> ConfigCell.Drifted(entry.files.size)
                        ConfigStatus.UNKNOWN, null -> ConfigCell.Unknown
                    }
                },
            )
        }
        return DiffReport(machines, rows, configs)
    }
}
