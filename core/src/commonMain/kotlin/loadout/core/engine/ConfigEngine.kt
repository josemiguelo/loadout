package loadout.core.engine

import loadout.core.LoadoutException
import loadout.core.exec.ProcessRunner
import loadout.core.exec.ShellCommand
import loadout.core.model.ConfigState
import loadout.core.model.ConfigStatus

/** A refusal about configs: chezmoi couldn't answer, a unit doesn't exist, or files were edited in place. */
class ConfigException(message: String) : LoadoutException(message)

/** One config unit and the targets chezmoi manages in it, relative to the destination. */
data class ConfigUnit(val name: String, val targets: List<String>)

/**
 * One line of `chezmoi status`, [target] relative to the destination.
 * [drifted]: `apply` would change it (the second column). [edited]: it
 * changed since chezmoi last wrote it (the first column).
 */
data class ConfigEntry(val target: String, val edited: Boolean, val drifted: Boolean)

/**
 * The repo's dotfiles as loadout sees them, through chezmoi, with
 * `[layout] configs` as its source directory. A unit is a top-level config:
 * `.config/<name>` is `<name>`, anything else its first path segment
 * (`.zshenv`, `.local`). Units come from chezmoi's own list, so
 * `.chezmoiignore` decides what exists; nothing is opted in. Only the
 * command [applyCommand] builds changes anything.
 */
class ConfigEngine(private val runner: ProcessRunner, sourceDir: String) {
    private val chezmoi = "chezmoi --source ${shellQuote(sourceDir)} --no-pager"

    /** Why chezmoi couldn't answer during the last [observe], or null. */
    var lastReason: String? = null
        private set

    /** The units chezmoi manages, sorted by name. */
    fun units(): List<ConfigUnit> =
        ask("managed --include files,symlinks").lineSequence()
            .filter { it.isNotBlank() }
            .groupBy(::unitOf)
            .map { (name, targets) -> ConfigUnit(name, targets.sorted()) }
            .sortedBy { it.name }

    /** Every target `chezmoi status` reports. */
    fun entries(): List<ConfigEntry> =
        ask("status --include files,symlinks").lineSequence()
            .filter { it.length > 3 }
            .map { ConfigEntry(it.substring(3), edited = it[0] != ' ', drifted = it[1] != ' ') }
            .toList()

    /**
     * Targets apply would change that also changed since chezmoi last wrote
     * them: `apply` asks before overwriting those, so they need a decision.
     * Limited to [targets] when given.
     */
    fun edited(targets: Collection<String>? = null): List<String> =
        entries().filter { it.edited && it.drifted && (targets == null || it.target in targets) }
            .map { it.target }
            .sorted()

    /**
     * Observe every unit: APPLIED when nothing in it would change on apply,
     * else DRIFTED with those files. When chezmoi can't answer, the units
     * last seen in [previous] are UNKNOWN with the reason (also [lastReason]).
     */
    fun observe(previous: Map<String, ConfigState>): Map<String, ConfigState> {
        lastReason = null
        val units: List<ConfigUnit>
        val entries: List<ConfigEntry>
        try {
            units = units()
            entries = entries()
        } catch (e: ConfigException) {
            lastReason = e.message
            return previous.keys.sorted().associateWith { ConfigState(ConfigStatus.UNKNOWN, reason = e.message) }
        }
        val drifted = entries.filter { it.drifted }.groupBy({ unitOf(it.target) }, { it.target })
        return (units.map { it.name } + drifted.keys).distinct().sorted().associateWith { name ->
            val files = drifted[name].orEmpty().sorted()
            if (files.isEmpty()) ConfigState(ConfigStatus.APPLIED) else ConfigState(ConfigStatus.DRIFTED, files)
        }
    }

    /**
     * `chezmoi apply` for [targets] (null = everything), without a terminal:
     * it fails instead of asking. [force] overwrites files edited in place.
     */
    fun applyCommand(targets: List<String>?, force: Boolean): ShellCommand {
        val paths = targets?.let { list ->
            val destination = ask("target-path").trim()
            list.joinToString("") { " " + shellQuote("$destination/$it") }
        }.orEmpty()
        return ShellCommand("$chezmoi apply --no-tty" + (if (force) " --force" else "") + paths)
    }

    private fun ask(args: String): String {
        val result = runner.capture("$chezmoi $args")
        if (result.success) return result.stdout
        if (result.exitCode == 127) throw ConfigException("chezmoi is not on PATH")
        val line = (result.stderr.lineSequence() + result.stdout.lineSequence())
            .firstOrNull { it.isNotBlank() }?.trim()
            ?: "exit ${result.exitCode}"
        throw ConfigException(if (line.startsWith("chezmoi")) line else "chezmoi: $line")
    }

    companion object {
        /** The unit a target belongs to: `.config/<name>/…` is `<name>`, else the first segment. */
        fun unitOf(target: String): String {
            val parts = target.split('/')
            return if (parts[0] == ".config" && parts.size >= 2) parts[1] else parts[0]
        }

        private fun shellQuote(s: String) = "'" + s.replace("'", "'\\''") + "'"
    }
}
