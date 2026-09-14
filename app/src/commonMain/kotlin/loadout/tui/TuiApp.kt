package loadout.tui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import com.jakewharton.mosaic.Mosaic
import com.jakewharton.mosaic.terminal.Terminal
import com.jakewharton.mosaic.tty.Tty
import com.jakewharton.mosaic.tty.terminal.asTerminalIn
import com.jakewharton.mosaic.ui.Color
import loadout.theme.DARK_THEME
import loadout.theme.LIGHT_THEME
import loadout.theme.Rgb
import loadout.theme.ThemePalette
import androidx.compose.runtime.BroadcastFrameClock
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlin.time.TimeSource

internal val SPINNER = listOf("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")

// ---------------------------------------------------------------- theme

/** Semantic color roles. Terminals get true color; Mosaic downsamples if not. */
data class Palette(
    val text: Color,
    val accent: Color,
    val onAccent: Color,
    val machine: Color,
    val dim: Color,
    val ok: Color,
    val warn: Color,
    val error: Color,
    val selectionBg: Color,
    val selectionFg: Color,
)

// Palettes come from loadout.theme — the CLI styles from the same values.
private fun Rgb.toColor() = Color(r, g, b)

private fun ThemePalette.toPalette() = Palette(
    text = text.toColor(),
    accent = accent.toColor(),
    onAccent = onAccent.toColor(),
    machine = machine.toColor(),
    dim = dim.toColor(),
    ok = ok.toColor(),
    warn = warn.toColor(),
    error = error.toColor(),
    selectionBg = selectionBg.toColor(),
    selectionFg = selectionFg.toColor(),
)

private val DARK_PALETTE = DARK_THEME.toPalette()
private val LIGHT_PALETTE = LIGHT_THEME.toPalette()

internal val LocalPalette = compositionLocalOf { DARK_PALETTE }

internal fun paletteFor(dark: Boolean) = if (dark) DARK_PALETTE else LIGHT_PALETTE

internal fun fit(text: String, width: Int): String =
    if (text.length > width) text.take((width - 1).coerceAtLeast(0)) + "…" else text.padEnd(width)

// ---------------------------------------------------------------- frame loop

/**
 * Our own frame loop around Mosaic's composition — for two things stock
 * `runMosaicBlocking` gets wrong inside tmux. Mosaic probes the terminal at
 * start-up and, when the primary device-attributes reply names a VT100
 * (`?1;…c` — exactly what tmux answers), skips EVERY capability query: it
 * neither hides the cursor nor learns that synchronized output (mode 2026)
 * is available. Its renderer then clears each line and rewrites it in the
 * open, and tmux repaints whatever it has parsed so far — with a spinner
 * ticking every 120ms that shows as the pane's text flickering.
 *
 * So every frame here is wrapped in `?2026h`…`?2026l` (a terminal that
 * doesn't know the mode ignores it) and the cursor is hidden for the app's
 * lifetime; the finally puts it back even on a throw. Frames are otherwise
 * drawn like Mosaic's: cursor back up to the first line, clear-and-write
 * each row, clear below when the frame shrank.
 */
internal fun runTui(content: @Composable () -> Unit) {
    print("\u001b[?25l")
    try {
        runBlocking {
            coroutineScope {
                val terminal = checkNotNull(Tty.tryBind()) { "Unable to run in non-interactive mode." }
                    .asTerminalIn(this)
                terminal.use { runFrames(it, content) }
            }
        }
    } finally {
        print("\u001b[?25h")
    }
}

private suspend fun runFrames(terminal: Terminal, content: @Composable () -> Unit) = coroutineScope {
    val clock = BroadcastFrameClock()
    val ansi = terminal.capabilities.ansiLevel
    val underline = terminal.capabilities.kittyUnderline
    var lastHeight = 0
    val mosaic = Mosaic(
        coroutineContext = coroutineContext + clock,
        onDraw = { m ->
            val canvas = m.draw()
            val frame = buildString {
                append("\u001b[?2026h")
                if (lastHeight > 0) append("\u001b[${lastHeight}F")
                for (row in 0 until canvas.height) {
                    if (row < lastHeight) append("\u001b[K")
                    canvas.appendRowTo(this, row, ansi, underline)
                    append("\r\n")
                }
                if (canvas.height < lastHeight) append("\u001b[J")
                append("\u001b[?2026l")
            }
            lastHeight = canvas.height
            print(frame)
        },
        terminal = terminal,
    )
    mosaic.setContent(content)
    // Mosaic's own loop does the same: a frame every millisecond, the delay
    // being the yield that lets the composition's coroutines run.
    val start = TimeSource.Monotonic.markNow()
    val ticker = launch {
        while (true) {
            clock.sendFrame(start.elapsedNow().inWholeNanoseconds)
            delay(1)
        }
    }
    mosaic.awaitComplete()
    ticker.cancel()
}
