package loadout.cli

import loadout.core.platform.isStdoutTty

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
