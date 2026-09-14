package loadout.cli

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

/**
 * ANSI styling for CLI screens, using the SAME Tokyo Night / Day palette as
 * the home screen (loadout.theme) so every surface speaks one visual
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
