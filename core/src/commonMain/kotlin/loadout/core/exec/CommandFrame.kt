package loadout.core.exec

import loadout.core.model.SystemInfo

/**
 * How manifest commands run (contract 5): in the directory of the file that
 * declared them (its repo-relative `origin`), with the `LOADOUT_*`
 * variables. A frame without a repo root (unit tests) runs in the caller's
 * directory with only the variables it was given.
 */
class CommandFrame(
    /** Absolute repo root, or null for "the caller's directory". */
    private val repoRoot: String? = null,
    private val env: Map<String, String> = emptyMap(),
) {
    fun cwd(origin: String): String? = repoRoot?.let { if (origin.isEmpty()) it else "$it/$origin" }

    fun command(line: String, origin: String): ShellCommand {
        val cwd = cwd(origin)
        return ShellCommand(line, cwd, if (cwd == null) env else env + ("LOADOUT_FRAGMENT_DIR" to cwd))
    }

    companion object {
        /** The frame for [system] in the repo at absolute [repoRoot], with its `layout configs`. */
        fun of(repoRoot: String, system: SystemInfo, configs: String?): CommandFrame =
            CommandFrame(
                repoRoot,
                buildMap {
                    put("LOADOUT_REPO", repoRoot)
                    put("LOADOUT_MACHINE", system.machine)
                    put("LOADOUT_OS", system.os.id)
                    if (configs != null) put("LOADOUT_CONFIGS", "$repoRoot/$configs")
                },
            )
    }
}
