package loadout.tui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.jakewharton.mosaic.layout.KeyEvent
import com.jakewharton.mosaic.layout.onKeyEvent
import com.jakewharton.mosaic.modifier.Modifier
import com.jakewharton.mosaic.runMosaicBlocking
import com.jakewharton.mosaic.ui.Color
import com.jakewharton.mosaic.ui.Column
import com.jakewharton.mosaic.ui.Row
import com.jakewharton.mosaic.ui.Text
import com.jakewharton.mosaic.ui.TextStyle
import loadout.cli.AppContext
import loadout.core.TOOL_VERSION
import loadout.core.platform.terminalRows
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay

fun runTui(app: AppContext) {
    runMosaicBlocking { App(DashboardModel(app)) }
}

private fun keyOf(event: KeyEvent): Key? = when (event) {
    KeyEvent("ArrowUp"), KeyEvent("k") -> Key.UP
    KeyEvent("ArrowDown"), KeyEvent("j") -> Key.DOWN
    KeyEvent("r") -> Key.R
    KeyEvent("i") -> Key.I
    KeyEvent("a") -> Key.A
    KeyEvent("s") -> Key.S
    KeyEvent("d") -> Key.D
    KeyEvent("l") -> Key.L
    KeyEvent("y") -> Key.Y
    KeyEvent("n") -> Key.N
    KeyEvent("q") -> Key.Q
    KeyEvent("Escape") -> Key.ESC
    KeyEvent("Enter") -> Key.ENTER
    else -> null
}

private val SPINNER = listOf("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")
private val DIM = TextStyle.Dim


// ---------------------------------------------------------------- borders

@Composable
private fun BorderTop(title: String, width: Int, titleColor: Color) {
    Row {
        Text("╭─", textStyle = DIM)
        if (title.isNotEmpty()) {
            Text(" $title ", color = titleColor, textStyle = TextStyle.Bold)
            Text("─".repeat((width - title.length - 4).coerceAtLeast(0)) + "╮", textStyle = DIM)
        } else {
            Text("─".repeat(width - 1) + "╮", textStyle = DIM)
        }
    }
}

@Composable
private fun BorderMid(title: String, width: Int, titleColor: Color) {
    Row {
        Text("├─", textStyle = DIM)
        Text(" $title ", color = titleColor, textStyle = TextStyle.Bold)
        Text("─".repeat((width - title.length - 4).coerceAtLeast(0)) + "┤", textStyle = DIM)
    }
}

@Composable
private fun BorderBottom(width: Int) {
    Text("╰" + "─".repeat(width) + "╯", textStyle = DIM)
}

/** One panel content line: border, [spans] (must render exactly [width]-2 cells), border. */
@Composable
private fun PanelLine(width: Int, spans: @Composable () -> Unit) {
    Row {
        Text("│ ", textStyle = DIM)
        spans()
        Text(" │", textStyle = DIM)
    }
}

@Composable
private fun PanelTextLine(width: Int, text: String, color: Color = Color.Unspecified, style: TextStyle = TextStyle.Empty) {
    PanelLine(width) { Text(fit(text, width - 2), color = color, textStyle = style) }
}

private fun fit(text: String, width: Int): String =
    if (text.length > width) text.take((width - 1).coerceAtLeast(0)) + "…" else text.padEnd(width)

// ---------------------------------------------------------------- app

@Composable
private fun App(model: DashboardModel) {
    LaunchedEffect(Unit) { model.dispatch(AsyncAction.LOAD) }

    val s = model.state

    var spin by remember { mutableIntStateOf(0) }
    LaunchedEffect(s.mode == Mode.BUSY) {
        while (s.mode == Mode.BUSY) {
            delay(120)
            spin++
        }
    }

    // Mosaic 0.18 doesn't report the real TTY size; poll TIOCGWINSZ ourselves.
    // The effect is guarded by !exit so it's torn down on quit — a lingering
    // effect would keep runMosaic from finishing.
    var termRows by remember { mutableIntStateOf(terminalRows() ?: 24) }
    if (!s.exit) {
        LaunchedEffect(Unit) {
            while (true) {
                delay(300)
                termRows = terminalRows() ?: 24
            }
        }
    }

    Column(
        modifier = Modifier.onKeyEvent { event ->
            val key = keyOf(event) ?: return@onKeyEvent false
            model.handleKey(key)?.let(model::dispatch)
            true
        },
    ) {
        TitleBar(s)
        when (s.mode) {
            Mode.LOADING -> Text(" loading…", textStyle = DIM)
            Mode.LOG -> LogPanel(s)
            else -> {
                // Budget the list against the real terminal height: fixed
                // chrome (title, borders, header, status, key bar) plus the
                // details panel when it's open.
                val detailsHeight = if (s.mode == Mode.DETAILS) model.detailLines().size + 2 else 0
                MatrixPanel(s, listHeight = (termRows - 8 - detailsHeight).coerceAtLeast(5))
                if (s.mode == Mode.DETAILS) DetailsPanel(model)
            }
        }
        StatusLine(s, spin)
        KeyBar(s)
    }

    if (!s.exit) {
        LaunchedEffect(Unit) { awaitCancellation() }
    }
}

@Composable
private fun TitleBar(s: TuiState) {
    Row {
        Text(" loadout $TOOL_VERSION ", color = Color.Black, background = Color.Cyan, textStyle = TextStyle.Bold)
        Text("  ${s.repo}", textStyle = DIM)
        if (s.machine.isNotEmpty()) {
            Text("  ·  ", textStyle = DIM)
            Text(s.machine, color = Color.Magenta, textStyle = TextStyle.Bold)
        }
    }
}

// ---------------------------------------------------------------- matrix

private fun cellColor(cell: String, drift: Boolean): Color? = when {
    cell == "missing" || cell == "failed" -> Color.Red
    cell == "pending" -> Color.Yellow
    cell == "done" -> Color.Green
    cell == "-" -> null
    drift -> Color.Yellow
    else -> Color.Green
}

@Composable
private fun MatrixPanel(s: TuiState, listHeight: Int) {
    if (s.rows.isEmpty()) {
        val message = "No programs in the manifest, or no state files yet — press r to scan."
        val width = message.length + 2
        BorderTop("programs", width, Color.Cyan)
        PanelTextLine(width, message)
        BorderBottom(width)
        return
    }
    val nameWidth = (s.rows.map { it.name.length } + 7).max() + 3
    val colWidth = ((s.machines.map { it.length } + 8).maxOrNull() ?: 8) + 3
    // Interior text width; +2 for the "│ "/" │" gutters handled by PanelLine.
    val inner = nameWidth + (s.machines.size.coerceAtLeast(1)) * colWidth
    val width = inner + 2

    // Viewport: when the list doesn't fit, render a window centered on the
    // selection, with more-above/below indicators taking two of its lines.
    val scrolled = s.rows.size > listHeight
    val window = if (scrolled) (listHeight - 2).coerceAtLeast(3) else listHeight
    val start = windowStart(s.selected, s.rows.size, window)
    val end = (start + window).coerceAtMost(s.rows.size)

    val title = if (scrolled) "programs ${s.selected + 1}/${s.rows.size}" else "programs"
    BorderTop(title, width, Color.Cyan)
    PanelLine(width) {
        Text("PROGRAM".padEnd(nameWidth), color = Color.Cyan, textStyle = TextStyle.Bold)
        Text(
            s.machines.joinToString("") { it.padEnd(colWidth) }.padEnd(inner - nameWidth),
            color = Color.Cyan,
            textStyle = TextStyle.Bold,
        )
    }
    if (scrolled) PanelTextLine(width, if (start > 0) "  ↑ $start more" else "", style = DIM)

    var scriptsHeaderShown = false
    for (index in start until end) {
        val row = s.rows[index]
        if (row.isScript && !scriptsHeaderShown && (index == start || !s.rows[index - 1].isScript)) {
            BorderMid("scripts", width, Color.Yellow)
            scriptsHeaderShown = true
        }
        val drift = "drift" in row.flags
        if (index == s.selected) {
            val line = row.name.padEnd(nameWidth) +
                s.machines.joinToString("") { (row.cells[it] ?: "-").padEnd(colWidth) }
            PanelLine(width) { Text(line.padEnd(inner), textStyle = TextStyle.Invert) }
        } else {
            PanelLine(width) {
                Text(row.name.padEnd(nameWidth), textStyle = TextStyle.Bold)
                for (machine in s.machines) {
                    val cell = row.cells[machine] ?: "-"
                    val color = cellColor(cell, drift)
                    Text(
                        cell.padEnd(colWidth),
                        color = color ?: Color.Unspecified,
                        textStyle = if (color == null) DIM else TextStyle.Empty,
                    )
                }
                if (s.machines.isEmpty()) Text("(no state files)".padEnd(inner - nameWidth), textStyle = DIM)
            }
        }
    }
    if (scrolled) PanelTextLine(width, if (end < s.rows.size) "  ↓ ${s.rows.size - end} more" else "", style = DIM)
    BorderBottom(width)
}

// ---------------------------------------------------------------- panels

@Composable
private fun DetailsPanel(model: DashboardModel) {
    val lines = model.detailLines()
    if (lines.isEmpty()) return
    val width = (lines.maxOf { it.length } + 2).coerceAtLeast(20)
    BorderTop("details", width, Color.Magenta)
    lines.forEachIndexed { index, line ->
        PanelTextLine(width, line, style = if (index == 0) TextStyle.Bold else TextStyle.Empty)
    }
    BorderBottom(width)
}

@Composable
private fun LogPanel(s: TuiState) {
    val lines = s.log.takeLast(20).ifEmpty { listOf("nothing logged yet — installs, scripts and syncs write here") }
    val width = (lines.maxOf { it.length } + 2).coerceAtLeast(30)
    BorderTop("log", width, Color.Yellow)
    for (line in lines) PanelTextLine(width, line, style = DIM)
    BorderBottom(width)
}

// ---------------------------------------------------------------- footer

@Composable
private fun StatusLine(s: TuiState, spin: Int) {
    when (s.mode) {
        Mode.BUSY -> Row {
            Text(" ${SPINNER[spin % SPINNER.size]} ", color = Color.Cyan)
            Text(s.message ?: "working…")
            s.log.lastOrNull()?.let { Text("   $it", textStyle = DIM) }
        }
        Mode.CONFIRM_PLAN, Mode.CONFIRM_SCRIPT -> Row {
            Text(" ? ", color = Color.Yellow, textStyle = TextStyle.Bold)
            Text(s.confirmText, color = Color.Yellow, textStyle = TextStyle.Bold)
        }
        else -> {
            val message = s.message ?: ""
            val (icon, color) = when {
                message.startsWith("error") || "FAILED" in message || "failed:" in message ->
                    "✘" to Color.Red
                "sudo needs" in message || "nothing to" in message || message == "cancelled" ->
                    "•" to Color.Yellow
                message == KEY_HELP || message.isEmpty() -> "•" to Color.Cyan
                else -> "✔" to Color.Green
            }
            Row {
                Text(" $icon ", color = color, textStyle = TextStyle.Bold)
                Text(message.ifEmpty { "ready" })
            }
        }
    }
}

@Composable
private fun KeyBar(s: TuiState) {
    val keys: List<Pair<String, String>> = when (s.mode) {
        Mode.NORMAL -> listOf(
            "↑↓" to "move", "r" to "refresh", "i" to "install/run", "a" to "all missing",
            "s" to "sync", "d" to "details", "l" to "log", "q" to "quit",
        )
        Mode.DETAILS -> listOf("↑↓" to "move", "d" to "close details", "q" to "back")
        Mode.LOG -> listOf("l" to "back", "esc" to "back")
        Mode.CONFIRM_PLAN, Mode.CONFIRM_SCRIPT -> listOf("y" to "confirm", "n" to "cancel")
        Mode.BUSY -> emptyList()
        Mode.LOADING -> emptyList()
    }
    if (keys.isEmpty()) {
        if (s.mode == Mode.BUSY) Text(" keys are ignored until this finishes", textStyle = DIM)
        return
    }
    Row {
        Text(" ")
        keys.forEachIndexed { index, (key, label) ->
            if (index > 0) Text("  ·  ", textStyle = DIM)
            Text(key, color = Color.Cyan, textStyle = TextStyle.Bold)
            Text(" $label", textStyle = DIM)
        }
    }
}
