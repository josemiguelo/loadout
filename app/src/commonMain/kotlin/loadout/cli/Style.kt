package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import loadout.core.platform.envVar
import loadout.core.platform.isStdoutTty
import loadout.core.platform.terminalBackgroundLuma
import loadout.theme.DARK_THEME
import loadout.theme.LIGHT_THEME
import loadout.theme.Rgb
import loadout.theme.detectDarkTerminal
import com.github.ajalt.mordant.rendering.Theme
import com.github.ajalt.mordant.rendering.TextStyle
import com.github.ajalt.mordant.rendering.TextColors
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import loadout.core.platform.blockingDispatcher

/**
 * ANSI styling for CLI screens, using the SAME Tokyo Night / Day palette as
 * the maintain TUI (loadout.theme) so every surface speaks one visual
 * language — same roles too: ok/warn/error/dim as statuses, accent for
 * headers/actions, machine for machine identity. Color is signal, never
 * decoration. Dark vs light is detected once like the TUI does (OSC 11
 * background query, COLORFGBG fallback, dark default) — only when stdout is
 * a TTY, so piped output stays plain and never touches the terminal.
 * Style AFTER padding — escape codes would break padEnd widths.
 */
object Style {
    private val enabled = isStdoutTty()
    internal val palette =
        if (enabled && !detectDarkTerminal(terminalBackgroundLuma(), envVar("COLORFGBG"))) LIGHT_THEME else DARK_THEME

    fun ok(text: String) = fg(text, palette.ok)
    fun warn(text: String) = fg(text, palette.warn)
    fun error(text: String) = fg(text, palette.error)
    fun dim(text: String) = fg(text, palette.dim)
    fun accent(text: String) = fg(text, palette.accent)
    fun machine(text: String) = fg(text, palette.machine)
    fun bold(text: String) = if (enabled) "\u001b[1m$text\u001b[0m" else text

    /** Bold accent — section headers, mirroring the TUI's title styling. */
    fun header(text: String) = bold(accent(text))

    private fun fg(text: String, c: Rgb) =
        if (enabled) "\u001b[38;2;${c.r};${c.g};${c.b}m$text\u001b[0m" else text

    /**
     * Clikt renders `--help` through Mordant's own theme, whose defaults are
     * tuned for dark terminals (pale yellow titles, light blue names) — washed
     * out on a light background. Map our detected palette onto the style keys
     * Clikt uses so help obeys the same detection as every other screen.
     */
    fun cliktTheme() = Theme(Theme.Default) {
        styles["warning"] = mordant(palette.warn) // section titles
        styles["info"] = mordant(palette.accent) // option / argument / command names
        styles["muted"] = mordant(palette.dim) // metavars, tags
        styles["danger"] = mordant(palette.error) // errors, required markers
    }

    private fun mordant(c: Rgb): TextStyle = TextColors.rgb(c.r / 255f, c.g / 255f, c.b / 255f)
}


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

/**
 * Run [work] under a braille spinner line (TTY only — piped output sees
 * nothing), clearing the line when done. The work always runs on
 * blockingDispatcher so the spinner loop keeps ticking — wrap every step
 * slow enough to look like a hang (checks, state writes, git) in this.
 */
fun <T> CliktCommand.spinning(message: String, work: suspend () -> T): T {
    val result = runBlocking {
        val spinner = if (isStdoutTty()) {
            launch {
                val frames = listOf("\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f")
                var frame = 0
                while (isActive) {
                    echo("\r${frames[frame++ % frames.size]} $message", trailingNewline = false)
                    delay(120)
                }
            }
        } else {
            null
        }
        try {
            // On blockingDispatcher, not runBlocking's single thread: a
            // blocking call here (git, state write) would freeze the spinner.
            withContext(blockingDispatcher) { work() }
        } finally {
            spinner?.cancelAndJoin()
        }
    }
    if (isStdoutTty()) echo("\r\u001b[K", trailingNewline = false)
    return result
}

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
