package loadout.theme

/**
 * The one source of truth for loadout's visual identity, shared by the
 * maintain TUI (Mosaic colors) and the CLI (24-bit ANSI). Color is signal,
 * never decoration: every role below means something (ok/warn/error/dim as
 * statuses, accent for headers and actions, machine for machine identity).
 */
data class Rgb(val r: Int, val g: Int, val b: Int)

data class ThemePalette(
    val accent: Rgb,
    val onAccent: Rgb,
    val machine: Rgb,
    val dim: Rgb,
    val ok: Rgb,
    val warn: Rgb,
    val error: Rgb,
    val selectionBg: Rgb,
    val selectionFg: Rgb,
)

/** Tokyo Night. */
val DARK_THEME = ThemePalette(
    accent = Rgb(0x7a, 0xa2, 0xf7),
    onAccent = Rgb(0x1a, 0x1b, 0x26),
    machine = Rgb(0xbb, 0x9a, 0xf7),
    // Tokyo Night dark5, not comment (0x565f89): de-emphasized must still be
    // readable — comment-gray drowned on translucent terminal backgrounds.
    dim = Rgb(0x73, 0x7a, 0xa2),
    ok = Rgb(0x9e, 0xce, 0x6a),
    warn = Rgb(0xe0, 0xaf, 0x68),
    error = Rgb(0xf7, 0x76, 0x8e),
    selectionBg = Rgb(0x36, 0x4a, 0x82),
    selectionFg = Rgb(0xc0, 0xca, 0xf5),
)

/** Light: vivid-but-readable on white (GitHub-light-like saturation). */
val LIGHT_THEME = ThemePalette(
    accent = Rgb(0x09, 0x69, 0xda),
    onAccent = Rgb(0xff, 0xff, 0xff),
    machine = Rgb(0x82, 0x50, 0xdf),
    dim = Rgb(0x6e, 0x77, 0x81),
    ok = Rgb(0x1a, 0x7f, 0x37),
    warn = Rgb(0x9a, 0x67, 0x00),
    error = Rgb(0xd1, 0x24, 0x2f),
    selectionBg = Rgb(0x2e, 0x33, 0x40),
    selectionFg = Rgb(0xe5, 0xe9, 0xf0),
)

/**
 * Whether the terminal looks dark. Mosaic 0.18 can't report the terminal
 * theme, so we ask the terminal for its background color (OSC 11 ->
 * [bgLuma]); when it doesn't answer, fall back to the COLORFGBG convention
 * ("<fg>;<bg>", bg 7/15 = light). Unknown -> dark, the safer default.
 */
fun detectDarkTerminal(bgLuma: Double?, colorFgBg: String?): Boolean {
    if (bgLuma != null) return bgLuma < 0.5
    val bg = colorFgBg?.substringAfterLast(';')?.toIntOrNull() ?: return true
    return bg != 7 && bg != 15
}
