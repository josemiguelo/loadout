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
 * `layout configs` as its source directory. A unit is a top-level config:
 * `.config/<name>` is `<name>`, anything else its first path segment
 * (`.zshenv`, `.local`). Units come from chezmoi's own list, so
 * `.chezmoiignore` decides what exists; nothing is opted in. Only the
 * command [applyCommand] builds changes anything.
 *
 * A child repo (contract 18) has two sources, its parent's and its own, in
 * that order: a unit may span both, and a target both manage is refused
 * (one file, one repo). chezmoi runs with [env] (`LOADOUT_REPO`,
 * `LOADOUT_MACHINE`), so templates see the machine loadout runs as.
 */
class ConfigEngine(
    private val runner: ProcessRunner,
    private val sources: List<Source>,
    private val env: Map<String, String> = emptyMap(),
) {
    /** One chezmoi source directory; [label] is what a refusal calls its repo ("this repo", "parent dotfiles"). */
    class Source(val dir: String, val label: String = "this repo")

    constructor(runner: ProcessRunner, sourceDir: String) : this(runner, listOf(Source(sourceDir)))

    private fun chezmoi(source: Source) = "chezmoi --source ${shellQuote(source.dir)} --no-pager"

    /** Why chezmoi couldn't answer during the last [observe], or null. */
    var lastReason: String? = null
        private set

    /** Each source's managed targets, in source order. */
    private fun managed(): List<Pair<Source, List<String>>> =
        sources.map { source ->
            source to ask(source, "managed --include files,symlinks").lineSequence().filter { it.isNotBlank() }.toList()
        }

    /** Targets more than one source manages, with the sources' labels. */
    private fun overlaps(managed: List<Pair<Source, List<String>>>): Map<String, List<String>> =
        managed.flatMap { (source, targets) -> targets.map { it to source.label } }
            .groupBy({ it.first }, { it.second })
            .filterValues { it.size > 1 }

    /** The units chezmoi manages, sorted by name; a unit spanning sources is one unit. */
    fun units(): List<ConfigUnit> =
        managed().flatMap { it.second }.distinct()
            .groupBy(::unitOf)
            .map { (name, targets) -> ConfigUnit(name, targets.sorted()) }
            .sortedBy { it.name }

    /** Every target `chezmoi status` reports, over every source. */
    fun entries(): List<ConfigEntry> =
        sources.flatMap { source ->
            ask(source, "status --include files,symlinks").lineSequence()
                .filter { it.length > 3 }
                .map { ConfigEntry(it.substring(3), edited = it[0] != ' ', drifted = it[1] != ' ') }
                .toList()
        }

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
        val managed: List<Pair<Source, List<String>>>
        val entries: List<ConfigEntry>
        try {
            managed = managed()
            entries = entries()
        } catch (e: ConfigException) {
            lastReason = e.message
            return previous.keys.sorted().associateWith { ConfigState(ConfigStatus.UNKNOWN, reason = e.message) }
        }
        val units = managed.flatMap { it.second }.map(::unitOf)
        val overlapping = overlaps(managed).entries.groupBy({ unitOf(it.key) }, { it })
        val drifted = entries.filter { it.drifted }.groupBy({ unitOf(it.target) }, { it.target })
        return (units + drifted.keys).distinct().sorted().associateWith { name ->
            val files = drifted[name].orEmpty().distinct().sorted()
            val clash = overlapping[name]?.minByOrNull { it.key }
            when {
                clash != null -> ConfigState(ConfigStatus.UNKNOWN, reason = clashMessage(clash.key, clash.value))
                files.isEmpty() -> ConfigState(ConfigStatus.APPLIED)
                else -> ConfigState(ConfigStatus.DRIFTED, files)
            }
        }
    }

    /**
     * `chezmoi apply` for [targets] (null = everything), without a terminal:
     * it fails instead of asking. [force] overwrites files edited in place.
     */
    fun applyCommand(targets: List<String>?, force: Boolean): ShellCommand {
        val flags = " apply --no-tty" + (if (force) " --force" else "")
        if (sources.size == 1) {
            val paths = targets?.let { list -> paths(sources.single(), list) }.orEmpty()
            return ShellCommand(chezmoi(sources.single()) + flags + paths, env = env)
        }
        // Each source applies its own targets, the parent's first.
        val managed = managed()
        val clashes = overlaps(managed).filterKeys { targets == null || it in targets }
        clashes.entries.minByOrNull { it.key }?.let { throw ConfigException(clashMessage(it.key, it.value)) }
        val lines = managed.mapNotNull { (source, mine) ->
            when {
                targets == null -> chezmoi(source) + flags
                else -> targets.filter { it in mine }.takeIf { it.isNotEmpty() }?.let { chezmoi(source) + flags + paths(source, it) }
            }
        }
        return ShellCommand(lines.ifEmpty { listOf("true") }.joinToString(" && "), env = env)
    }

    private fun paths(source: Source, targets: List<String>): String {
        val destination = ask(source, "target-path").trim()
        return targets.joinToString("") { " " + shellQuote("$destination/$it") }
    }

    private fun clashMessage(target: String, labels: List<String>) =
        "$target is managed by ${labels.joinToString(" and ")} — a file belongs to one repo"

    private fun ask(source: Source, args: String): String {
        val result = runner.capture(ShellCommand("${chezmoi(source)} $args", env = env))
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
