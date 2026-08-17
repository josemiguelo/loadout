package io.github.josemiguelo.postinstaller.tui

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
import io.github.josemiguelo.postinstaller.cli.AppContext
import io.github.josemiguelo.postinstaller.core.TOOL_VERSION
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

    Column(
        modifier = Modifier.onKeyEvent { event ->
            val key = keyOf(event) ?: return@onKeyEvent false
            model.handleKey(key)?.let(model::dispatch)
            true
        },
    ) {
        TitleBar(s)
        Text("")
        when (s.mode) {
            Mode.LOADING -> Text(" loading…", textStyle = DIM)
            Mode.LOG -> LogView(s)
            else -> {
                Matrix(s)
                if (s.mode == Mode.DETAILS) DetailsPane(model)
            }
        }
        Text("")
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
        Text(" post-installer $TOOL_VERSION ", textStyle = TextStyle.Invert)
        Text("  ${s.repo}", textStyle = DIM)
        if (s.machine.isNotEmpty()) {
            Text("  ·  ", textStyle = DIM)
            Text(s.machine, textStyle = TextStyle.Bold)
        }
    }
}

private fun cellColor(cell: String, drift: Boolean): Color? = when {
    cell == "missing" || cell == "failed" -> Color.Red
    cell == "pending" -> Color.Yellow
    cell == "done" -> Color.Green
    cell == "-" -> null
    drift -> Color.Yellow
    else -> Color.Green
}

@Composable
private fun Matrix(s: TuiState) {
    if (s.rows.isEmpty()) {
        Text(" No programs in the manifest, or no state files yet — press r to scan this machine.")
        return
    }
    val nameWidth = (s.rows.map { it.name.length } + 7).max() + 3
    val colWidth = ((s.machines.map { it.length } + 8).maxOrNull() ?: 8) + 3

    Text(
        " " + "PROGRAM".padEnd(nameWidth) + s.machines.joinToString("") { it.padEnd(colWidth) },
        textStyle = TextStyle.Bold + DIM,
    )

    var scriptsHeaderShown = false
    s.rows.forEachIndexed { index, row ->
        if (row.isScript && !scriptsHeaderShown) {
            Text("")
            Text(" SCRIPTS", textStyle = TextStyle.Bold + DIM)
            scriptsHeaderShown = true
        }
        val drift = "drift" in row.flags
        if (index == s.selected) {
            val line = " " + row.name.padEnd(nameWidth) +
                s.machines.joinToString("") { (row.cells[it] ?: "-").padEnd(colWidth) }
            Text(line, textStyle = TextStyle.Invert)
        } else {
            Row {
                Text(" " + row.name.padEnd(nameWidth))
                for (machine in s.machines) {
                    val cell = row.cells[machine] ?: "-"
                    val color = cellColor(cell, drift)
                    Text(
                        cell.padEnd(colWidth),
                        color = color ?: Color.Unspecified,
                        textStyle = if (color == null) DIM else TextStyle.Empty,
                    )
                }
            }
        }
    }
}

@Composable
private fun DetailsPane(model: DashboardModel) {
    val lines = model.detailLines()
    if (lines.isEmpty()) return
    Text("")
    Text(" DETAILS", textStyle = TextStyle.Bold + DIM)
    lines.forEachIndexed { index, line ->
        Text(" $line", textStyle = if (index == 0) TextStyle.Bold else TextStyle.Empty)
    }
}

@Composable
private fun LogView(s: TuiState) {
    Text(" LOG", textStyle = TextStyle.Bold + DIM)
    if (s.log.isEmpty()) {
        Text(" nothing logged yet — installs and syncs write here", textStyle = DIM)
    } else {
        for (line in s.log.takeLast(20)) Text(" $line", textStyle = DIM)
    }
}

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
            Text(s.confirmText, textStyle = TextStyle.Bold)
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
                Text(" $icon ", color = color)
                Text(message.ifEmpty { "ready" })
            }
        }
    }
}

@Composable
private fun KeyBar(s: TuiState) {
    val keys = when (s.mode) {
        Mode.NORMAL -> "↑↓ move · r refresh · i install/run · a all missing · s sync · d details · l log · q quit"
        Mode.DETAILS -> "↑↓ move · d/esc close details · q back"
        Mode.LOG -> "l/esc back"
        Mode.CONFIRM_PLAN, Mode.CONFIRM_SCRIPT -> "y confirm · n cancel"
        Mode.BUSY -> "working — keys are ignored until this finishes"
        Mode.LOADING -> ""
    }
    Text(" $keys", textStyle = DIM)
}
