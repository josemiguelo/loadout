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
import loadout.core.platform.terminalColumns
import loadout.core.platform.terminalRows
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay

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

private fun fit(text: String, width: Int): String =
    if (text.length > width) text.take((width - 1).coerceAtLeast(0)) + "…" else text.padEnd(width)

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
