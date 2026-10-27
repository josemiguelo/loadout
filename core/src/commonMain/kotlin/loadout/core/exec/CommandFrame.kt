package loadout.core.exec

import loadout.core.model.Origin
import loadout.core.model.SystemInfo

/**
 * How manifest commands run (contract 5): in the directory of the file that
 * declared them (its repo-relative `origin`), with the `LOADOUT_*`
 * variables. In a child repo (contract 18) a parent's declaration
 * ([Origin.PARENT]) runs in the parent's checkout with the parent's
 * `LOADOUT_REPO` and `LOADOUT_CONFIGS`, as it would in the parent itself.
 * A frame without a repo root (unit tests) runs in the caller's directory
 * with only the variables it was given.
 */
class CommandFrame(
    /** Absolute repo root, or null for "the caller's directory". */
    private val repoRoot: String? = null,
    private val env: Map<String, String> = emptyMap(),
    /** A child repo's parent: where its declarations run, and what they see instead of [env]. */
    private val parent: Parent? = null,
) {
    class Parent(val root: String, val env: Map<String, String>)

    fun cwd(origin: String): String? {
        val root = if (Origin.isParent(origin)) parent?.root ?: repoRoot else repoRoot
        val folder = Origin.folder(origin)
        return root?.let { if (folder.isEmpty()) it else "$it/$folder" }
    }

    fun command(line: String, origin: String): ShellCommand {
        val cwd = cwd(origin)
        val vars = if (Origin.isParent(origin) && parent != null) parent.env else env
        return ShellCommand(line, cwd, if (cwd == null) vars else vars + ("LOADOUT_FRAGMENT_DIR" to cwd))
    }

    companion object {
        /**
         * The frame for [system] in the repo at absolute [repoRoot], with its
         * `layout configs`; for a child repo, also its parent's absolute
         * [parentRoot] and configs.
         */
        fun of(
            repoRoot: String,
            system: SystemInfo,
            configs: String?,
            parentRoot: String? = null,
            parentConfigs: String? = null,
        ): CommandFrame {
            val common = buildMap {
                put("LOADOUT_MACHINE", system.machine)
                put("LOADOUT_OS", system.os.id)
                // Every command of a child sees its parent: a parent program's
                // `file` value runs in whichever repo's installer takes it.
                if (parentRoot != null) put("LOADOUT_PARENT", parentRoot)
            }
            fun repoEnv(root: String, configs: String?) = common + buildMap {
                put("LOADOUT_REPO", root)
                if (configs != null) put("LOADOUT_CONFIGS", "$root/$configs")
            }
            return CommandFrame(
                repoRoot,
                repoEnv(repoRoot, configs),
                parentRoot?.let { Parent(it, repoEnv(it, parentConfigs)) },
            )
        }
    }
}
