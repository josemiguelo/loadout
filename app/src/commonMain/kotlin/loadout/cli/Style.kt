package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import loadout.core.platform.isStdoutTty
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

/**
 * Minimal ANSI styling for CLI tables, mirroring the TUI's color roles
 * (ok/warn/error/dim — color is signal, never decoration). Standard 4-bit
 * colors so the user's terminal theme decides the exact shades; disabled
 * automatically when stdout is piped, so scripted output stays plain.
 * Style AFTER padding — escape codes would break padEnd widths.
 */
object Style {
    private val enabled = isStdoutTty()

    fun ok(text: String) = wrap(text, "32")
    fun warn(text: String) = wrap(text, "33")
    fun error(text: String) = wrap(text, "31")
    fun dim(text: String) = wrap(text, "2")
    fun bold(text: String) = wrap(text, "1")

    private fun wrap(text: String, code: String) =
        if (enabled) "\u001b[${code}m$text\u001b[0m" else text
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
