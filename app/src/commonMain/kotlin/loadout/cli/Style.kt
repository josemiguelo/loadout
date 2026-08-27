package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import loadout.core.platform.envVar
import loadout.core.platform.isStdoutTty
import loadout.core.platform.terminalBackgroundLuma
import loadout.theme.DARK_THEME
import loadout.theme.LIGHT_THEME
import loadout.theme.Rgb
import loadout.theme.detectDarkTerminal
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

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
    private val palette =
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
}


/**
 * Run [work] under a braille spinner line (TTY only — piped output sees
 * nothing), clearing the line when done. The work runs on whatever
 * dispatcher it chooses (engines use blockingDispatcher), so the spinner
 * loop stays responsive.
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
            work()
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
