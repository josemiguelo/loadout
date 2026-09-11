package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand

/** One printed row: usually a single line, plus any detail lines under it. */
class TableRow(val lines: List<String>, val severity: Boolean? = null)

private val ANSI = Regex("\u001b\\[[0-9;]*m")

/** Visible width of a styled string — escape codes take no columns. */
private fun printedWidth(text: String) = ANSI.replace(text, "").length

/**
 * Echo table rows, wrapping the ones that need attention (severity non-null:
 * false = warn, true = error) in a rounded box. Consecutive attention rows
 * share one box, so a run reads as a single block, and the box takes the
 * severe color if any row in it is severe. Plain rows get the same
 * two-column gutter the border occupies, so columns line up either way.
 */
fun CliktCommand.echoRows(rows: List<TableRow>) {
    fun paint(severe: Boolean, text: String) = if (severe) Style.error(text) else Style.warn(text)
    val width = rows.filter { it.severity != null }
        .flatMap { it.lines }.maxOfOrNull { printedWidth(it) } ?: 0
    var severe = false
    for ((index, row) in rows.withIndex()) {
        if (row.severity == null) {
            row.lines.forEach { echo("  $it") }
            continue
        }
        if (index == 0 || rows[index - 1].severity == null) {
            severe = (index..rows.lastIndex)
                .takeWhile { rows[it].severity != null }
                .any { rows[it].severity == true }
            echo(paint(severe, "\u256d" + "\u2500".repeat(width + 2) + "\u256e"))
        }
        for (line in row.lines) {
            val pad = " ".repeat((width - printedWidth(line)).coerceAtLeast(0))
            echo(paint(severe, "\u2502") + " " + line + pad + " " + paint(severe, "\u2502"))
        }
        if (index == rows.lastIndex || rows[index + 1].severity == null) {
            echo(paint(severe, "\u2570" + "\u2500".repeat(width + 2) + "\u256f"))
        }
    }
}
