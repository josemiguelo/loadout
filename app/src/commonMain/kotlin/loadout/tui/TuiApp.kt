package loadout.tui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
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
import loadout.core.platform.envVar
import loadout.core.platform.terminalColumns
import loadout.core.platform.terminalRows
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay

fun runTui(app: AppContext) {
    // Construct the model (and its OSC background query) before Mosaic
    // switches the terminal into its own modes.
    val model = DashboardModel(app)
    runMosaicBlocking { App(model) }
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
    KeyEvent("t") -> Key.T
    KeyEvent("y") -> Key.Y
    KeyEvent("n") -> Key.N
    KeyEvent("q") -> Key.Q
    KeyEvent("Escape") -> Key.ESC
    KeyEvent("Enter") -> Key.ENTER
    else -> null
}

private val SPINNER = listOf("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")
private val BOLD = TextStyle.Bold

// ---------------------------------------------------------------- theme

/** Semantic color roles. Terminals get true color; Mosaic downsamples if not. */
data class Palette(
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

/** Tokyo Night. */
private val DARK_PALETTE = Palette(
    accent = Color(0x7a, 0xa2, 0xf7),
    onAccent = Color(0x1a, 0x1b, 0x26),
    machine = Color(0xbb, 0x9a, 0xf7),
    dim = Color(0x56, 0x5f, 0x89),
    ok = Color(0x9e, 0xce, 0x6a),
    warn = Color(0xe0, 0xaf, 0x68),
    error = Color(0xf7, 0x76, 0x8e),
    selectionBg = Color(0x36, 0x4a, 0x82),
    selectionFg = Color(0xc0, 0xca, 0xf5),
)

/** Light: vivid-but-readable on white (GitHub-light-like saturation). */
private val LIGHT_PALETTE = Palette(
    accent = Color(0x09, 0x69, 0xda),
    onAccent = Color(0xff, 0xff, 0xff),
    machine = Color(0x82, 0x50, 0xdf),
    dim = Color(0x6e, 0x77, 0x81),
    ok = Color(0x1a, 0x7f, 0x37),
    warn = Color(0x9a, 0x67, 0x00),
    error = Color(0xd1, 0x24, 0x2f),
    selectionBg = Color(0x2e, 0x33, 0x40),
    selectionFg = Color(0xe5, 0xe9, 0xf0),
)

private val LocalPalette = compositionLocalOf { DARK_PALETTE }

// ---------------------------------------------------------------- borders

@Composable
private fun BorderTop(title: String, width: Int, titleColor: Color) {
    val p = LocalPalette.current
    Row {
        Text("╭─", color = p.dim)
        if (title.isNotEmpty()) {
            Text(" $title ", color = titleColor, textStyle = BOLD)
            Text("─".repeat((width - title.length - 4).coerceAtLeast(0)) + "╮", color = p.dim)
        } else {
            Text("─".repeat(width - 1) + "╮", color = p.dim)
        }
    }
}

@Composable
private fun BorderMid(title: String, width: Int, titleColor: Color) {
    val p = LocalPalette.current
    Row {
        Text("├─", color = p.dim)
        Text(" $title ", color = titleColor, textStyle = BOLD)
        Text("─".repeat((width - title.length - 4).coerceAtLeast(0)) + "┤", color = p.dim)
    }
}

@Composable
private fun BorderBottom(width: Int) {
    Text("╰" + "─".repeat(width) + "╯", color = LocalPalette.current.dim)
}

/** One panel content line: border, [spans] (must render exactly [width]-2 cells), border. */
@Composable
private fun PanelLine(width: Int, spans: @Composable () -> Unit) {
    val p = LocalPalette.current
    Row {
        Text("│ ", color = p.dim)
        spans()
        Text(" │", color = p.dim)
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

    CompositionLocalProvider(LocalPalette provides if (s.dark) DARK_PALETTE else LIGHT_PALETTE) {
        Column(
            modifier = Modifier.onKeyEvent { event ->
                val key = keyOf(event) ?: return@onKeyEvent false
                model.handleKey(key)?.let(model::dispatch)
                true
            },
        ) {
            TitleBar(s)
            when (s.mode) {
                Mode.LOADING -> Text(" loading…", color = LocalPalette.current.dim)
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
    }

    if (!s.exit) {
        LaunchedEffect(Unit) { awaitCancellation() }
    }
}

@Composable
private fun TitleBar(s: TuiState) {
    val p = LocalPalette.current
    val home = envVar("HOME")
    val repo = if (home != null && s.repo.startsWith(home)) "~" + s.repo.removePrefix(home) else s.repo

    @Composable
    fun segment(label: String, value: String, valueColor: Color = Color.Unspecified) {
        Text(" │ ", color = p.dim)
        Text("$label ", color = p.dim)
        Text(value, color = valueColor, textStyle = BOLD)
    }

    Row {
        Text(" loadout v$TOOL_VERSION ", color = p.onAccent, background = p.accent, textStyle = BOLD)
        segment("machine", s.machine.ifEmpty { "detecting…" }, p.machine)
        segment("repo", repo)
        if (s.machines.isNotEmpty()) {
            segment("tracking", "${s.machines.size} machine${if (s.machines.size == 1) "" else "s"}", p.accent)
        }
    }
}

// ---------------------------------------------------------------- matrix

/** Semantic color for a matrix cell, or null for the dim neutral "-". */
private fun cellColor(cell: String, drift: Boolean, p: Palette): Color? = when {
    cell == "missing" || cell == "failed" -> p.error
    cell == "pending" -> p.warn
    cell == "done" -> p.ok
    cell == "-" -> null
    drift -> p.warn
    else -> p.ok
}

@Composable
private fun MatrixPanel(s: TuiState, listHeight: Int) {
    val p = LocalPalette.current
    if (s.rows.isEmpty()) {
        val message = "No programs in the manifest, or no state files yet — press r to scan."
        val width = message.length + 2
        BorderTop("programs", width, p.accent)
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
    BorderTop(title, width, p.accent)
    PanelLine(width) {
        Text("PROGRAM".padEnd(nameWidth), color = p.accent, textStyle = BOLD)
        Text(
            s.machines.joinToString("") { it.padEnd(colWidth) }.padEnd(inner - nameWidth),
            color = p.accent,
            textStyle = BOLD,
        )
    }
    if (scrolled) PanelTextLine(width, if (start > 0) "  ↑ $start more" else "", color = p.dim)

    var scriptsHeaderShown = false
    for (index in start until end) {
        val row = s.rows[index]
        if (row.isScript && !scriptsHeaderShown && (index == start || !s.rows[index - 1].isScript)) {
            BorderMid("scripts", width, p.warn)
            scriptsHeaderShown = true
        }
        val drift = "drift" in row.flags
        if (index == s.selected) {
            val line = row.name.padEnd(nameWidth) +
                s.machines.joinToString("") { (row.cells[it] ?: "-").padEnd(colWidth) }
            PanelLine(width) {
                Text(line.padEnd(inner), color = p.selectionFg, background = p.selectionBg, textStyle = BOLD)
            }
        } else {
            PanelLine(width) {
                Text(row.name.padEnd(nameWidth))
                for (machine in s.machines) {
                    val cell = row.cells[machine] ?: "-"
                    val color = cellColor(cell, drift, p)
                    Text(cell.padEnd(colWidth), color = color ?: p.dim)
                }
                if (s.machines.isEmpty()) Text("(no state files)".padEnd(inner - nameWidth), color = p.dim)
            }
        }
    }
    if (scrolled) PanelTextLine(width, if (end < s.rows.size) "  ↓ ${s.rows.size - end} more" else "", color = p.dim)
    BorderBottom(width)
}

// ---------------------------------------------------------------- panels

@Composable
private fun DetailsPanel(model: DashboardModel) {
    val p = LocalPalette.current
    val lines = model.detailLines()
    if (lines.isEmpty()) return
    val width = (lines.maxOf { it.length } + 2).coerceAtLeast(20)
    BorderTop("details", width, p.machine)
    lines.forEachIndexed { index, line ->
        PanelTextLine(width, line, style = if (index == 0) BOLD else TextStyle.Empty)
    }
    BorderBottom(width)
}

@Composable
private fun LogPanel(s: TuiState) {
    val p = LocalPalette.current
    val lines = s.log.takeLast(20).ifEmpty { listOf("nothing logged yet — installs, scripts and syncs write here") }
    val width = (lines.maxOf { it.length } + 2).coerceAtLeast(30)
    BorderTop("log", width, p.warn)
    for (line in lines) PanelTextLine(width, line, color = p.dim)
    BorderBottom(width)
}

// ---------------------------------------------------------------- footer

@Composable
private fun StatusLine(s: TuiState, spin: Int) {
    val p = LocalPalette.current
    when (s.mode) {
        Mode.BUSY -> Row {
            Text(" ${SPINNER[spin % SPINNER.size]} ", color = p.accent)
            Text(s.message ?: "working…")
            s.log.lastOrNull()?.let { Text("   $it", color = p.dim) }
        }
        Mode.CONFIRM_PLAN, Mode.CONFIRM_SCRIPT -> Row {
            Text(" ? ", color = p.warn, textStyle = BOLD)
            Text(s.confirmText, color = p.warn, textStyle = BOLD)
        }
        else -> {
            val message = s.message ?: ""
            val (icon, color) = when {
                message.startsWith("error") || "FAILED" in message || "failed:" in message ->
                    "✘" to p.error
                "sudo needs" in message || "nothing to" in message || message == "cancelled" ->
                    "•" to p.warn
                message == KEY_HELP || message.isEmpty() -> "•" to p.accent
                else -> "✔" to p.ok
            }
            Row {
                Text(" $icon ", color = color, textStyle = BOLD)
                Text(message.ifEmpty { "ready" })
            }
        }
    }
}

@Composable
private fun KeyBar(s: TuiState) {
    val p = LocalPalette.current
    val keys: List<Pair<String, String>> = when (s.mode) {
        Mode.NORMAL -> listOf(
            "↑↓" to "move", "r" to "refresh", "i" to "install/run", "a" to "all missing",
            "s" to "sync", "d" to "details", "l" to "log", "t" to "theme", "q" to "quit",
        )
        Mode.DETAILS -> listOf("↑↓" to "move", "d" to "close details", "q" to "back")
        Mode.LOG -> listOf("l" to "back", "esc" to "back")
        Mode.CONFIRM_PLAN, Mode.CONFIRM_SCRIPT -> listOf("y" to "confirm", "n" to "cancel")
        Mode.BUSY -> emptyList()
        Mode.LOADING -> emptyList()
    }
    if (keys.isEmpty()) {
        if (s.mode == Mode.BUSY) Text(" keys are ignored until this finishes", color = p.dim)
        return
    }
    Row {
        Text(" ")
        keys.forEachIndexed { index, (key, label) ->
            if (index > 0) Text("  ·  ", color = p.dim)
            Text(key, color = p.accent, textStyle = BOLD)
            Text(" $label", color = p.dim)
        }
    }
}

// ---------------------------------------------------------------- maintain tui

/**
 * Interactive `loadout maintain`: select scripts, run them sequentially with
 * a live log accordion, browse full logs afterwards. Returns the exit code
 * (1 when any script ended failed, still pending, or cancelled).
 */
fun runMaintainTui(app: AppContext): Int {
    // Model construction + load happen before Mosaic owns the terminal (OSC
    // theme query) and so manifest errors still reach Main.kt's clean catch.
    val model = MaintainModel(app)
    model.load()
    if (model.state.rows.isEmpty()) {
        println("No opted-in scripts for this machine.")
        return 0
    }
    runMosaicBlocking { MaintainApp(model) }
    return model.state.exitCode
}

private fun maintainKeyOf(event: KeyEvent): MaintainKey? = when (event) {
    KeyEvent("ArrowUp"), KeyEvent("k") -> MaintainKey.UP
    KeyEvent("ArrowDown"), KeyEvent("j") -> MaintainKey.DOWN
    KeyEvent("PageUp") -> MaintainKey.PAGE_UP
    KeyEvent("PageDown") -> MaintainKey.PAGE_DOWN
    KeyEvent(" ") -> MaintainKey.SPACE
    KeyEvent("a") -> MaintainKey.A
    KeyEvent("n") -> MaintainKey.N
    KeyEvent("t") -> MaintainKey.T
    KeyEvent("q") -> MaintainKey.Q
    KeyEvent("Escape") -> MaintainKey.ESC
    KeyEvent("Enter") -> MaintainKey.ENTER
    else -> null
}

@Composable
private fun MaintainApp(model: MaintainModel) {
    val s = model.state

    var spin by remember { mutableIntStateOf(0) }
    LaunchedEffect(s.phase == MaintainPhase.RUNNING) {
        while (s.phase == MaintainPhase.RUNNING) {
            delay(120)
            spin++
        }
    }

    // Per-script elapsed seconds: a script can stay silent for minutes, so
    // the ticking counter is the visible sign of progress.
    val runningName = s.rows.firstOrNull { it.status == RunStatus.RUNNING || it.status == RunStatus.CHECKING }?.name
    var elapsed by remember { mutableIntStateOf(0) }
    LaunchedEffect(runningName) {
        elapsed = 0
        if (runningName != null) {
            while (true) {
                delay(1000)
                elapsed++
            }
        }
    }

    // Same TIOCGWINSZ polling as the dashboard (see App), width included —
    // the maintain screen is borderless and fills the whole terminal.
    var termRows by remember { mutableIntStateOf(terminalRows() ?: 24) }
    var termCols by remember { mutableIntStateOf(terminalColumns() ?: 80) }
    if (!s.exit) {
        LaunchedEffect(Unit) {
            while (true) {
                delay(300)
                termRows = terminalRows() ?: 24
                termCols = terminalColumns() ?: 80
            }
        }
    }

    // Log lines an expanded box may use: terminal height minus one line per
    // script row and the fixed chrome (title, blank, status, key bar).
    val logHeight = (termRows - s.rows.size - 6).coerceAtLeast(3)
    val width = termCols

    CompositionLocalProvider(LocalPalette provides if (s.dark) DARK_PALETTE else LIGHT_PALETTE) {
        Column(
            modifier = Modifier.onKeyEvent { event ->
                val key = maintainKeyOf(event) ?: return@onKeyEvent false
                if (model.handleKey(key, logHeight)) model.startRun()
                true
            },
        ) {
            MaintainTitleBar(s)
            Text("")
            MaintainPanel(s, spin, elapsed, logHeight, width)
            // Push the footer to the bottom of the terminal.
            val used = 4 + s.rows.size + maintainExpandedLines(s, logHeight)
            repeat((termRows - used - 1).coerceAtLeast(0)) { Text("") }
            MaintainStatusLine(s, spin, elapsed)
            MaintainKeyBar(s)
        }
    }

    if (!s.exit) {
        LaunchedEffect(Unit) { awaitCancellation() }
    }
}

/** Lines the expanded accordion/viewer currently occupies (for the filler). */
private fun maintainExpandedLines(s: MaintainState, logHeight: Int): Int = when {
    s.phase == MaintainPhase.RUNNING ->
        s.rows.firstOrNull { it.status == RunStatus.RUNNING || it.status == RunStatus.CHECKING }?.log?.let { log ->
            minOf(log.size, logHeight) + if (log.size > logHeight) 1 else 0
        } ?: 0
    s.phase == MaintainPhase.DONE && s.viewing != null -> {
        val log = s.rows.first { it.name == s.viewing }.log
        val start = s.scroll.coerceAtMost((log.size - logHeight).coerceAtLeast(0))
        val window = minOf(logHeight, log.size - start)
        window + (if (start > 0) 1 else 0) + (if (log.size - start - window > 0) 1 else 0)
    }
    else -> 0
}

@Composable
private fun MaintainTitleBar(s: MaintainState) {
    val p = LocalPalette.current
    Row {
        Text(" loadout maintain ", color = p.onAccent, background = p.accent, textStyle = BOLD)
        Text(" │ ", color = p.dim)
        Text("machine ", color = p.dim)
        Text(s.machine, color = p.machine, textStyle = BOLD)
        Text(" │ ", color = p.dim)
        Text("scripts ", color = p.dim)
        Text("${s.rows.size}", color = p.accent, textStyle = BOLD)
        if (s.phase == MaintainPhase.SELECT) {
            Text(" │ ", color = p.dim)
            Text("selected ", color = p.dim)
            Text("${s.selected.size}", color = p.accent, textStyle = BOLD)
        }
    }
}

private fun runStatusLabel(row: MaintainRow, selectedForRun: Boolean, elapsed: Int): String = when (row.status) {
    RunStatus.RUNNING -> "running… ${elapsed}s"
    RunStatus.CHECKING -> "checking… ${elapsed}s"
    RunStatus.DONE -> "done"
    RunStatus.PENDING -> "pending"
    RunStatus.FAILED -> "failed"
    RunStatus.CANCELLED -> "cancelled"
    RunStatus.WAITING -> if (selectedForRun) "queued" else "skipped"
}

/** Borderless full-width list: one row per script, accordion lines beneath. */
@Composable
private fun MaintainPanel(s: MaintainState, spin: Int, elapsed: Int, logHeight: Int, width: Int) {
    val p = LocalPalette.current
    val nameWidth = s.rows.maxOf { it.name.length } + 3

    for ((index, row) in s.rows.withIndex()) {
        val selectedForRun = row.name in s.selected
        val marker = when {
            s.phase == MaintainPhase.SELECT -> if (selectedForRun) "[x] " else "[ ] "
            row.status == RunStatus.RUNNING || row.status == RunStatus.CHECKING ->
                " ${SPINNER[spin % SPINNER.size]}  "
            row.status == RunStatus.DONE -> " ✔  "
            row.status == RunStatus.PENDING || row.status == RunStatus.FAILED -> " ✘  "
            row.status == RunStatus.CANCELLED -> " ✘  "
            else -> " ·  "
        }
        val statusLabel = if (s.phase == MaintainPhase.SELECT) "" else runStatusLabel(row, selectedForRun, elapsed)
        val hasCursor = s.phase != MaintainPhase.RUNNING && index == s.cursor
        if (hasCursor) {
            // Selection bar stretches across the whole terminal.
            Text(
                fit(" " + marker + row.name.padEnd(nameWidth) + statusLabel, width),
                color = p.selectionFg,
                background = p.selectionBg,
                textStyle = BOLD,
            )
        } else {
            Row {
                val markerColor = when (row.status) {
                    RunStatus.DONE -> p.ok
                    RunStatus.PENDING, RunStatus.FAILED, RunStatus.CANCELLED -> p.error
                    RunStatus.RUNNING, RunStatus.CHECKING -> p.accent
                    RunStatus.WAITING -> if (selectedForRun) p.accent else p.dim
                }
                Text(" ")
                Text(marker, color = markerColor, textStyle = BOLD)
                Text(row.name.padEnd(nameWidth))
                val statusColor = when (row.status) {
                    RunStatus.DONE -> p.ok
                    RunStatus.PENDING -> p.warn
                    RunStatus.FAILED, RunStatus.CANCELLED -> p.error
                    RunStatus.RUNNING, RunStatus.CHECKING -> p.accent
                    RunStatus.WAITING -> p.dim
                }
                Text(fit(statusLabel, (width - 5 - nameWidth).coerceAtLeast(0)), color = statusColor)
            }
        }
        // Accordion: the running row's live tail, or the viewer's window.
        // The model seeds every run's log with its command, so the box is
        // never empty while running (a silent script doesn't look frozen).
        if (s.phase == MaintainPhase.RUNNING && (row.status == RunStatus.RUNNING || row.status == RunStatus.CHECKING)) {
            MaintainLogLines(row.log.takeLast(logHeight), above = (row.log.size - logHeight).coerceAtLeast(0), below = 0, width = width)
        } else if (s.phase == MaintainPhase.DONE && s.viewing == row.name) {
            val start = s.scroll.coerceAtMost((row.log.size - logHeight).coerceAtLeast(0))
            val window = row.log.drop(start).take(logHeight)
            MaintainLogLines(window, above = start, below = row.log.size - start - window.size, width = width)
        }
    }
}

@Composable
private fun MaintainLogLines(lines: List<String>, above: Int, below: Int, width: Int) {
    val p = LocalPalette.current
    if (above > 0) Text(fit("      ↑ $above more", width), color = p.dim)
    for (line in lines) {
        Text(fit("      $line", width), color = p.dim)
    }
    if (below > 0) Text(fit("      ↓ $below more", width), color = p.dim)
}

@Composable
private fun MaintainStatusLine(s: MaintainState, spin: Int, elapsed: Int) {
    val p = LocalPalette.current
    if (s.phase == MaintainPhase.RUNNING) {
        val running = s.rows.firstOrNull { it.status == RunStatus.RUNNING || it.status == RunStatus.CHECKING }
        Row {
            Text(" ${SPINNER[spin % SPINNER.size]} ", color = p.accent)
            if (running != null) {
                val verb = if (running.status == RunStatus.CHECKING) "checking" else "running"
                Text("$verb ${running.name} · ${elapsed}s")
                Text("   full logs open when the run finishes", color = p.dim)
            } else {
                // Between the last script and DONE: the state file is written.
                Text(s.message ?: "updating state…")
            }
        }
        return
    }
    val message = s.message ?: if (s.phase == MaintainPhase.SELECT) "select the scripts to run" else ""
    val (icon, color) = when {
        "pending" in message || "failed" in message || message.startsWith("cancelled") -> "✘" to p.error
        "sudo needs" in message || "nothing selected" in message -> "•" to p.warn
        message.startsWith("all ") -> "✔" to p.ok
        else -> "•" to p.accent
    }
    Row {
        Text(" $icon ", color = color, textStyle = BOLD)
        Text(message)
    }
}

@Composable
private fun MaintainKeyBar(s: MaintainState) {
    val p = LocalPalette.current
    val keys: List<Pair<String, String>> = when {
        s.phase == MaintainPhase.SELECT -> listOf(
            "↑↓" to "move", "space" to "toggle", "a" to "all", "n" to "none",
            "enter" to "run", "t" to "theme", "q" to "quit",
        )
        s.phase == MaintainPhase.RUNNING -> listOf("esc" to "cancel", "t" to "theme")
        s.viewing != null -> listOf("↑↓" to "scroll", "pgup/pgdn" to "page", "esc" to "close", "q" to "quit")
        else -> listOf("↑↓" to "move", "enter" to "view log", "t" to "theme", "q" to "quit")
    }
    Row {
        Text(" ")
        keys.forEachIndexed { index, (key, label) ->
            if (index > 0) Text("  ·  ", color = p.dim)
            Text(key, color = p.accent, textStyle = BOLD)
            Text(" $label", color = p.dim)
        }
    }
}
