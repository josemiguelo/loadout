package loadout.cli

/**
 * Structured command help: a summary line, then indented detail lines
 * (args/flags), each on its own line — NEL (\u0085) survives Clikt's
 * re-wrapping where \n does not.
 */
internal fun commandHelp(summary: String, vararg details: String): String {
    if (details.isEmpty()) return summary
    // Rendered with PRE_WRAP (see LoadoutHelpFormatter), so plain newlines
    // and spaces survive: one indented line per arg/flag, aligned columns.
    val nameWidth = details.maxOf { it.substringBefore("  ").length }
    val lines = details.map { detail ->
        val name = detail.substringBefore("  ")
        val desc = detail.substringAfter("  ", "").trim()
        if (desc.isEmpty()) "  $name" else "  " + name.padEnd(nameWidth + 2) + desc
    }
    return (listOf(summary) + lines).joinToString("\n")
}
