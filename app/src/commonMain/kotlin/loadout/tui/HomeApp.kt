package loadout.tui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.jakewharton.mosaic.layout.KeyEvent
import com.jakewharton.mosaic.layout.onKeyEvent
import com.jakewharton.mosaic.layout.fillMaxSize
import com.jakewharton.mosaic.layout.padding
import com.jakewharton.mosaic.modifier.Modifier
import com.jakewharton.mosaic.ui.Alignment
import com.jakewharton.mosaic.ui.Box
import com.jakewharton.mosaic.ui.BoxScope
import com.jakewharton.mosaic.ui.Column
import com.jakewharton.mosaic.ui.Row
import com.jakewharton.mosaic.ui.Text
import com.jakewharton.mosaic.ui.TextStyle
import loadout.cli.AppContext
import loadout.cli.UpdateRow
import loadout.core.diff.ConfigCell
import loadout.core.diff.InstallState
import loadout.core.model.ConfigStatus
import loadout.core.model.ScriptStatus
import loadout.core.TOOL_VERSION
import loadout.core.platform.terminalColumns
import loadout.core.platform.terminalRows
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay

/**
 * The home screen across hand-offs. [show] draws it until the user picks an
 * action, then returns the state with the terminal released. The caller
 * runs the action, then [resume]s and shows it again: one model, so the
 * cursor, open tables and answers persist.
 */
class HomeScreen(app: AppContext) {
    private val model = HomeModel(app).also {
        it.load()
        it.refresh()
    }

    fun show(): HomeState {
        runTui { HomeApp(model) }
        return model.state
    }

    /** Background checks are running; [pause] waits for them. */
    val busy: Boolean get() = model.busy

    /** Call before the command runs; see [HomeModel.pause]. */
    fun pause() = model.pause()

    /** Call after it; see [HomeModel.resume]. */
    fun resume(closed: HomeState, ok: Boolean) = model.resume(closed, ok)
}

private fun homeKeyOf(event: KeyEvent): HomeKey? = when (event) {
    KeyEvent("ArrowUp"), KeyEvent("k") -> HomeKey.UP
    KeyEvent("ArrowDown"), KeyEvent("j") -> HomeKey.DOWN
    KeyEvent("ArrowRight"), KeyEvent("l") -> HomeKey.OPEN
    KeyEvent("ArrowLeft"), KeyEvent("h") -> HomeKey.CLOSE
    KeyEvent("PageUp") -> HomeKey.PAGE_UP
    KeyEvent("PageDown") -> HomeKey.PAGE_DOWN
    // vim's section jump: over the rows to the next heading. Not H/L — a
    // missed shift there would close the very list you're moving around in.
    KeyEvent("[") -> HomeKey.PREV_HEADING
    KeyEvent("]") -> HomeKey.NEXT_HEADING
    KeyEvent("Enter") -> HomeKey.ENTER
    KeyEvent("Escape") -> HomeKey.ESC
    KeyEvent(" ") -> HomeKey.SELECT
    KeyEvent("a") -> HomeKey.SELECT_ALL
    KeyEvent("u") -> HomeKey.SELECT_NONE
    // Lazy's key for "show me the diff": the row's compare page, in the browser.
    KeyEvent("K") -> HomeKey.OPEN_LINK
    KeyEvent("r") -> HomeKey.REFRESH
    // Capitals for the consequential ones: S pushes, U replaces the binary,
    // C converges the machine.
    KeyEvent("S") -> HomeKey.SYNC
    KeyEvent("U") -> HomeKey.UPGRADE
    KeyEvent("C") -> HomeKey.CONVERGE
    KeyEvent("t") -> HomeKey.THEME
    KeyEvent("q") -> HomeKey.QUIT
    KeyEvent("Tab") -> HomeKey.SWITCH
    KeyEvent("y") -> HomeKey.YES
    KeyEvent("n") -> HomeKey.NO
    else -> null
}

@Composable
private fun HomeApp(model: HomeModel) {
    val s = model.state

    var spin by remember { mutableIntStateOf(0) }
    val spinning = s.loading || s.remote is RemoteStatus.Asking
    // EVERY effect must stop on exit: one still running keeps runMosaic alive
    // forever — quitting mid-refresh used to hang the screen.
    if (!s.exit) {
        LaunchedEffect(spinning) {
            while (spinning) {
                delay(120)
                spin++
            }
        }
    }

    // Mosaic doesn't report the real TTY size; poll it (see AGENTS).
    var size by remember { mutableIntStateOf(0) }
    var rows by remember { mutableIntStateOf(24) }
    if (!s.exit) {
        LaunchedEffect(Unit) {
            while (true) {
                size = terminalColumns() ?: 80
                rows = terminalRows() ?: 24
                delay(300)
            }
        }
    }
    val width = if (size > 0) size else 80
    // Body lines the screen can show at once — subject rows and open detail
    // lines share them, and the whole body scrolls as one. Count the chrome
    // exactly or the header scrolls off the top: header + blank + 3 footer
    // lines + 1 spare, plus a line when there's a message.
    val viewport = (rows - 6 - (if (s.message != null) 1 else 0)).coerceAtLeast(3)
    // Lines the pane shows at once: 80% of the screen minus PANE_CHROME.
    val paneRows = (rows * 8 / 10 - PANE_CHROME).coerceIn(3, (rows - 3 - PANE_CHROME).coerceAtLeast(3))

    CompositionLocalProvider(LocalPalette provides paletteFor(s.dark)) {
      Box(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.onKeyEvent { event ->
                homeKeyOf(event)?.let { key ->
                    // The model counts unwrapped lines: shrink the page by
                    // the lines wrapping adds.
                    val page = s.run?.let { run -> paneRows - (paneLayout(run, width).first.size - paneLines(run).size) }
                    model.handleKey(key, page ?: viewport)
                } != null
            },
        ) {
            HomeHeader(s, width)
            Text("")
            // While the pane is up, nothing underneath is focused: a selection
            // bar's background would bleed through the pane's cells, and the
            // keyboard belongs to the pane regardless.
            val overlay = s.run != null
            // One list, one window: subject rows and the lines of every open
            // detail, exactly as the cursor walks them.
            val lines = homeLines(s)
            val focus = if (overlay) -1 else snapCursor(lines, s.cursor)
            val scroll = s.scroll.coerceIn(0, (lines.size - viewport).coerceAtLeast(0))
            val window = lines.drop(scroll).take(viewport)
            val widths = DetailWidths(s, width)
            for ((offset, line) in window.withIndex()) {
                val index = scroll + offset
                val section = s.sections[line.section]
                when (line) {
                    is HomeLine.Subject -> HomeSectionRow(
                        section,
                        focused = index == focus,
                        highlight = !overlay,
                        width = width,
                        open = section.action in s.open,
                        spin = spin,
                    )
                    // The detail, opened in place: the answer is already here,
                    // so showing it shouldn't mean leaving the screen.
                    is HomeLine.Header -> FleetHeaderRow(s, widths)
                    is HomeLine.Detail ->
                        DetailRow(s, section, line.index, focused = index == focus, width = width, widths = widths)
                }
            }
            // Fill the terminal: the footer belongs at the bottom.
            val footer = 3 + (if (s.message != null) 1 else 0)
            // -1: filling the last line scrolls the header off the top.
            repeat((rows - 2 - window.size - footer - 1).coerceAtLeast(0)) { Text("") }
            HomeFooter(s, width, lines.size, scroll, window.size)
        }
        s.run?.let { RunPane(it, width, paneRows) }
      }
    }
    if (!s.exit) {
        LaunchedEffect(Unit) { awaitCancellation() }
    }
}

/** The pane's rows besides its lines: two borders, a gap and the buttons. */
private const val PANE_CHROME = 4

/** Space either side of a button's label, like gum's (padding "0 3"). */
private const val BUTTON_PAD = 3

/** The pane's buttons, each with whether it's focused. */
private fun paneButtons(run: PaneRun) =
    if (run.asking) listOf("Run" to !run.cancelFocused, "Cancel" to run.cancelFocused) else listOf("Close" to true)

private fun buttonsWidth(buttons: List<Pair<String, Boolean>>) =
    buttons.sumOf { (label, _) -> label.length + 2 * BUTTON_PAD } + 2 * (buttons.size - 1)

/** The pane's widest text; longer lines wrap. */
private const val READABLE = 72

/**
 * The pane's wrapped lines and inner width on a [width]-column screen: as
 * wide as its longest line, at most [READABLE] (or 90% of a narrower
 * screen). Shared by the view and the scroll bound.
 */
private fun paneLayout(run: PaneRun, width: Int): Pair<List<String>, Int> {
    val title = if (run.asking) "run this?" else run.title
    val longest = paneLines(run).maxOfOrNull { it.length } ?: 0
    val inner = maxOf(minOf(longest, READABLE), title.length + 3, buttonsWidth(paneButtons(run)), 40)
        .coerceAtMost((width * 9 / 10 - 4).coerceAtLeast(30))
    return paneLines(run, inner) to inner
}

/**
 * The floating pane: an overlay (Mosaic's Box composites children in
 * order), centred, sized to its content (see [paneLayout]) and scrolling
 * past 80% of the height. A question (Run / Cancel) or a list (Close);
 * commands never run in it.
 */
@Composable
private fun BoxScope.RunPane(run: PaneRun, width: Int, paneRows: Int) {
    val p = LocalPalette.current
    val title = if (run.asking) "run this?" else run.title
    val edge = p.accent
    val buttons = paneButtons(run)
    val buttonsWidth = buttonsWidth(buttons)
    val (lines, inner) = paneLayout(run, width)
    val paneWidth = inner + 4
    // Read from the top; scrolling moves the window down.
    val window = lines.drop(run.scrollBack).take(paneRows)
    // No background modifier: the pane's own spaces hide what's behind it,
    // so it sits on the TERMINAL's background and follows dark/light like
    // everything else. A painted panel colour would fight the theme.
    Column(modifier = Modifier.align(Alignment.Center)) {
        Text(fit("╭─ $title ".padEnd(paneWidth - 1, '─') + "╮", paneWidth), color = edge, textStyle = TextStyle.Empty)
        // An explicit foreground AND style on every cell: Mosaic composites
        // per cell, and an unspecified attribute inherits whatever was
        // underneath — the half of the pane over the dim columns came out
        // dim, and the rows over a bold heading came out bold.
        // TextStyle.Empty is specified-and-plain; Unspecified keeps the old.
        val plain = TextStyle.Empty
        @Composable
        fun paneRow(content: @Composable () -> Unit) = Row {
            Text("│ ", color = edge, textStyle = plain)
            content()
            Text(" │", color = edge, textStyle = plain)
        }
        for (line in window) {
            paneRow { Text(clip(line, inner).padEnd(inner), color = p.text, textStyle = plain) }
        }
        paneRow { Text(" ".repeat(inner), color = p.text, textStyle = plain) }
        // Buttons as gum draws them: focused in the accent, the other grey.
        val left = (inner - buttonsWidth) / 2
        paneRow {
            Text(" ".repeat(left), color = p.text, textStyle = plain)
            for ((index, button) in buttons.withIndex()) {
                val (label, focused) = button
                if (index > 0) Text("  ", color = p.text, textStyle = plain)
                Text(
                    " ".repeat(BUTTON_PAD) + label + " ".repeat(BUTTON_PAD),
                    color = if (focused) p.onAccent else p.idleFg,
                    background = if (focused) p.accent else p.idleBg,
                    textStyle = if (focused) TextStyle.Bold else plain,
                )
            }
            Text(" ".repeat(inner - left - buttonsWidth), color = p.text, textStyle = plain)
        }
        val below = lines.size - run.scrollBack - window.size
        val bottom = if (below > 0) "╰─ $below more below · ↑↓ scroll ".padEnd(paneWidth - 1, '─') + "╯"
        else "╰" + "─".repeat(paneWidth - 2) + "╯"
        Text(fit(bottom, paneWidth), color = edge, textStyle = TextStyle.Empty)
    }
}

@Composable
private fun HomeHeader(s: HomeState, width: Int) {
    val p = LocalPalette.current
    Row {
        Text(" loadout $TOOL_VERSION", color = p.accent, textStyle = TextStyle.Bold)
        Text(" │ ", color = p.dim)
        Text(s.machine, color = p.machine, textStyle = TextStyle.Bold)
        Text(" │ ", color = p.dim)
        Text(s.system, color = p.dim)
        if (s.stale && !s.loading) {
            Text("   last observed state — r re-checks", color = p.dim)
        }
    }
}

@Composable
private fun HomeSectionRow(
    section: HomeSection,
    focused: Boolean,
    width: Int,
    open: Boolean = false,
    spin: Int = 0,
    highlight: Boolean = true,
) {
    val p = LocalPalette.current
    val marker = when {
        section.neutral -> " · "
        section.severity == null -> " ✔ "
        section.severity == false -> " ! "
        else -> " ✘ "
    }
    val markerColor = when {
        section.neutral -> p.dim
        section.severity == null -> p.ok
        section.severity == false -> p.warn
        else -> p.error
    }
    // A working row spins where its answer will be, rather than a spinner
    // parked in the title bar away from the thing it describes.
    val frame = SPINNER[spin % SPINNER.size]
    val summary = if (section.busy) frame else clip(section.summary, SUMMARY_WIDTH)
    val line = "  " + section.subject.padEnd(11) + summary.padEnd(SUMMARY_WIDTH + 1)
    // ▾ while its table is open below — the cursor is often somewhere else
    // by then, so the row itself has to say which subjects are open.
    val arrow = if (open) "▾ " else "→ "
    if (focused && highlight) {
        Text(
            fit(" $marker$line" + (if (section.verb.isEmpty()) "" else arrow + section.verb), width),
            color = p.selectionFg,
            background = p.selectionBg,
            textStyle = TextStyle.Bold,
        )
    } else if (open) {
        Row {
            Text(" ")
            Text(marker, color = markerColor, textStyle = TextStyle.Bold)
            Text(line, color = p.accent, textStyle = TextStyle.Bold)
            Text("▾ ${section.verb}", color = p.accent, textStyle = TextStyle.Bold)
        }
    } else {
        Row {
            Text(" ")
            Text(marker, color = markerColor, textStyle = TextStyle.Bold)
            Text(line)
            Text("  ${section.verb}", color = p.dim)
        }
    }
}

/** Detail lines sit one step in from their row, so the nesting reads. */
private const val DETAIL_INDENT = "          "
private const val DETAIL_FOCUS = "        ❯ "

/** Truncate to [max] columns; a wrapped row shreds the table. */
private fun clip(text: String, max: Int) = if (text.length <= max) text else text.take(max - 1) + "…"

/**
 * Versions differ at the END ("adoptopenjdk-21.0.6+7" vs "…21.0.8+9"), so
 * a version that can't fit loses its head, not its tail — right-clipping
 * showed two identical prefixes and hid the only part that changed.
 */
private fun clipVersion(text: String, max: Int) = if (text.length <= max) text else "…" + text.takeLast(max - 1)

/**
 * Every open detail's column widths, measured once a frame. The rows are
 * drawn one at a time now (the body is one scrolling list), so the widths
 * can't be worked out row by row — a column is only straight if every row
 * of the table agrees on it.
 */
private class DetailWidths(s: HomeState, val width: Int) {
    val missingName = (s.missing.maxOfOrNull { it.name.length } ?: 8).coerceAtMost(30) + 2
    val missingKey = (s.missing.maxOfOrNull { it.installKey.length } ?: 4).coerceAtMost(12) + 2
    val missingRoom = (width - DETAIL_INDENT.length - 6 - missingName - missingKey).coerceAtLeast(8)

    val scriptName = (s.scripts.maxOfOrNull { it.name.length } ?: 8).coerceAtMost(30) + 2

    val configName = (s.configs.maxOfOrNull { it.name.length } ?: 8).coerceAtMost(30) + 2
    val configRoom = (width - DETAIL_INDENT.length - 6 - configName - 10).coerceAtLeast(8)

    private val updates = (s.remote as? RemoteStatus.Answered)?.updates.orEmpty()
    // Columns are capped, not just padded: one long name would otherwise
    // wrap every row and shred the table.
    val remoteName = (updates.maxOfOrNull { it.name.length } ?: 8).coerceAtMost(26) + 2
    // Version columns get the room the terminal has: long java/sha strings
    // fit on a wide terminal and only get clipped on a narrow one.
    private val versionCap = if (width >= 130) 30 else if (width >= 110) 22 else 16
    val current = (updates.maxOfOrNull { it.current.length } ?: 1).coerceAtMost(versionCap) + 2
    val candidate = (updates.maxOfOrNull { it.candidate.length } ?: 1).coerceAtMost(versionCap) + 2
    val remoteRoom =
        (width - (DETAIL_INDENT.length + 8 + remoteName + current + 3 + candidate)).coerceAtLeast(8)

    private val drifted = driftedRows(s)
    val fleetName = (drifted.maxOfOrNull { it.name.length } ?: 8).coerceAtMost(26) + 2
    // Every machine gets a column: share what's left of the terminal.
    val fleetColumn = s.fleet?.let { report ->
        ((width - 8 - fleetName) / report.machines.size.coerceAtLeast(1))
            .coerceAtMost((report.machines.maxOfOrNull { it.length } ?: 6) + 2)
            .coerceAtLeast(8)
    } ?: 8
}

/** One line of some subject's open detail — whichever subject it belongs to. */
@Composable
private fun DetailRow(
    s: HomeState,
    section: HomeSection,
    row: Int,
    focused: Boolean,
    width: Int,
    widths: DetailWidths,
) {
    when (section.action) {
        HomeAction.INSTALL_MISSING -> s.missing.getOrNull(row)?.let { MissingRow(s, it, focused, width, widths) }
        HomeAction.RUN_SCRIPTS -> s.scripts.getOrNull(row)?.let { ScriptLine(s, it, focused, width, widths) }
        HomeAction.APPLY_CONFIGS -> s.configs.getOrNull(row)?.let { ConfigLine(s, it, focused, width, widths) }
        HomeAction.REVIEW_OUTDATED -> (s.remote as? RemoteStatus.Answered)?.let { answered ->
            remoteLines(answered, s.collapsed).getOrNull(row)?.let { RemoteRow(s, it, focused, width, widths) }
        }
        HomeAction.SHOW_DIFF -> driftedRows(s).getOrNull(row)?.let { FleetRow(s, it, focused, width, widths) }
        else -> {}
    }
}

/** The fleet table's own heading: which machine each column belongs to. */
@Composable
private fun FleetHeaderRow(s: HomeState, w: DetailWidths) {
    val p = LocalPalette.current
    val report = s.fleet ?: return
    Row {
        Text(DETAIL_INDENT + "  ")
        Text("".padEnd(w.fleetName), color = p.dim)
        for (machine in report.machines) {
            Text(clip(machine, w.fleetColumn - 1).padEnd(w.fleetColumn), color = p.machine)
        }
    }
}

/** One drifting program or config of `diff`, rendered under the fleet row. */
@Composable
private fun FleetRow(
    s: HomeState,
    line: FleetLine,
    focused: Boolean,
    width: Int,
    w: DetailWidths,
) {
    val p = LocalPalette.current
    val machines = s.fleet?.machines.orEmpty()
    val cells = machines.joinToString("") { machine ->
        val cell = when (line) {
            is FleetLine.Program -> when (val state = line.row.perMachine.getValue(machine)) {
                is InstallState.Installed -> state.version ?: "ok"
                InstallState.Missing -> "missing"
                InstallState.Unknown -> "-"
            }
            is FleetLine.Config -> when (val state = line.row.perMachine.getValue(machine)) {
                ConfigCell.Applied -> "applied"
                is ConfigCell.Drifted -> "drifted (${state.files})"
                ConfigCell.Unknown -> "-"
            }
        }
        clip(cell, w.fleetColumn - 1).padEnd(w.fleetColumn)
    }
    // A missing install is severe; version drift and a drifted config are not.
    val severe = line is FleetLine.Program && line.row.incomplete
    if (focused) {
        Text(
            fit(DETAIL_FOCUS + (if (severe) "✘ " else "! ") + clip(line.name, w.fleetName - 1).padEnd(w.fleetName) + cells, width),
            color = p.selectionFg,
            background = p.selectionBg,
            textStyle = TextStyle.Bold,
        )
    } else {
        Row {
            Text(DETAIL_INDENT)
            Text(if (severe) "✘ " else "! ", color = if (severe) p.error else p.warn)
            Text(clip(line.name, w.fleetName - 1).padEnd(w.fleetName))
            Text(cells, color = if (severe) p.dim else p.warn)
        }
    }
}

/**
 * One line of the `outdated` table, rendered under the row that answered it
 * — grouped by what will ACT. A tool line says what ticking it means (every
 * package the tool reported, not only the declared ones under it); a program
 * under a tool ticks the tool; a custom source's items tick alone.
 */
@Composable
private fun RemoteRow(s: HomeState, line: RemoteLine, focused: Boolean, width: Int, w: DetailWidths) {
    val p = LocalPalette.current
    val selected = line.key != null && line.key in s.selection

    fun box(key: String?) = when {
        key == null -> "[–] "
        key in s.selection -> "[x] "
        else -> "[ ] "
    }
    fun version(row: UpdateRow) =
        clipVersion(row.current, w.current - 1).padEnd(w.current) + "-> " +
            clipVersion(row.candidate, w.candidate - 1).padEnd(w.candidate)

    when (line) {
        is RemoteLine.Tool -> {
            val t = line.info
            // A folded group shows a chevron where its rows would be —
            // only when it has rows: a clean tool hides nothing, so a
            // chevron there would promise content that doesn't exist.
            val name = clip(t.tool, 9) + if (line.foldable && line.group in s.collapsed) " ▸" else ""
            val total = t.total?.toString() ?: "?"
            val updates = if (t.total == 1) "1 update" else "$total updates"
            val what = when {
                t.total == null -> "${t.declared.size} in your loadout · others unknown"
                t.total == 0 -> "up to date"
                t.declared.isEmpty() -> "$updates · none in your loadout"
                else -> "$updates · ${t.declared.size} in your loadout"
            }
            val text = box(line.key) + name.padEnd(11) + what.padEnd(36) +
                (t.command?.let { clip(it, w.remoteRoom) } ?: "")
            if (focused) {
                Text(fit(DETAIL_FOCUS + text, width), color = p.selectionFg, background = p.selectionBg, textStyle = TextStyle.Bold)
            } else {
                Row {
                    Text(DETAIL_INDENT)
                    Text(box(line.key), color = if (selected) p.accent else p.dim)
                    Text(name.padEnd(11), textStyle = TextStyle.Bold)
                    Text(what.padEnd(36), color = if (t.total == 0) p.ok else p.warn)
                    Text(t.command?.let { clip(it, w.remoteRoom) } ?: "", color = p.dim)
                }
            }
        }
        is RemoteLine.Program, is RemoteLine.Item -> {
            val row = if (line is RemoteLine.Program) line.row else (line as RemoteLine.Item).row
            val nested = line is RemoteLine.Program
            // A program under its tool shows no box of its own: the
            // tool's box is the one that means anything. A source item
            // has its own, indented under the heading's.
            val lead = if (nested) "    " else "  " + box(line.key)
            val note = (if (row.note.isNotEmpty() && w.remoteRoom > 12) "  " + clip(row.note, w.remoteRoom - 2) else "") +
                (if (row.link != null) "  ↗" else "")
            val text = lead + "↑ " + clip(row.name, w.remoteName - 1).padEnd(w.remoteName) + version(row) + note
            if (focused) {
                Text(fit(DETAIL_FOCUS + text, width), color = p.selectionFg, background = p.selectionBg, textStyle = TextStyle.Bold)
            } else {
                Row {
                    Text(DETAIL_INDENT)
                    Text(lead, color = if (selected) p.accent else p.dim)
                    Text("↑ ", color = p.warn)
                    Text(clip(row.name, w.remoteName - 1).padEnd(w.remoteName))
                    Text(clipVersion(row.current, w.current - 1).padEnd(w.current), color = p.dim)
                    Text("-> ", color = p.dim)
                    Text(clipVersion(row.candidate, w.candidate - 1).padEnd(w.candidate), color = p.warn)
                    if (note.isNotEmpty()) Text(note, color = p.dim)
                }
            }
        }
        is RemoteLine.Others -> {
            // The honest cost of the sweep, in the tool's own package
            // names — amber, like every "needs your attention" mark on the
            // screen: the part of the sweep you didn't ask for. Enter
            // opens the whole list in the pane.
            val head = "+ ${line.names.size} more not in your loadout · enter lists them"
            if (focused) {
                Text(fit(DETAIL_FOCUS + "    " + head, width), color = p.selectionFg, background = p.selectionBg, textStyle = TextStyle.Bold)
            } else {
                Row {
                    Text(DETAIL_INDENT + "    ")
                    Text(head, color = p.warn, textStyle = TextStyle.Bold)
                }
            }
        }
        is RemoteLine.Source -> {
            // The heading's box ticks all of its items: [x] when every
            // one is, [ ] otherwise, [–] when the source can't update.
            val all = line.itemKeys.isNotEmpty() && s.selection.containsAll(line.itemKeys)
            val sbox = when {
                line.itemKeys.isEmpty() -> "[–] "
                all -> "[x] "
                else -> "[ ] "
            }
            val name = line.name + if (line.foldable && line.group in s.collapsed) " ▸" else ""
            if (focused) {
                Text(fit(DETAIL_FOCUS + sbox + name, width), color = p.selectionFg, background = p.selectionBg, textStyle = TextStyle.Bold)
            } else {
                Row {
                    Text(DETAIL_INDENT)
                    Text(sbox, color = if (all) p.accent else p.dim)
                    Text(name, textStyle = TextStyle.Bold)
                }
            }
        }
        is RemoteLine.Gap -> Text("")
    }
}

/**
 * One row of the programs picker, under the programs row: a program the last
 * observation found missing, with what would install it.
 */
@Composable
private fun MissingRow(s: HomeState, row: ProgramRow, focused: Boolean, width: Int, w: DetailWidths) {
    val p = LocalPalette.current
    val chosen = row.name in s.chosen
    val box = if (chosen) "[x] " else "[ ] "
    val name = clip(row.name, w.missingName - 1).padEnd(w.missingName)
    val key = clip("[${row.installKey}]", w.missingKey - 1).padEnd(w.missingKey)
    val command = clip(row.command, w.missingRoom)
    if (focused) {
        Text(
            fit(DETAIL_FOCUS + box + "✘ " + name + key + command, width),
            color = p.selectionFg,
            background = p.selectionBg,
            textStyle = TextStyle.Bold,
        )
    } else {
        Row {
            Text(DETAIL_INDENT)
            Text(box, color = if (chosen) p.accent else p.dim)
            Text("✘ ", color = p.error)
            Text(name)
            Text(key, color = p.dim)
            Text(command, color = p.dim)
        }
    }
}

/**
 * One row of the scripts picker, under the scripts row: a maintenance script
 * this machine opts into, its last verdict, and a tick box. Ticking a done
 * one is how you force it.
 */
@Composable
private fun ScriptLine(s: HomeState, row: ScriptRow, focused: Boolean, width: Int, w: DetailWidths) {
    val p = LocalPalette.current
    val picked = row.name in s.picked
    val box = if (picked) "[x] " else "[ ] "
    // Same marks as the status table: ✔ done, ! pending, ✘ failed, and
    // · for a script nothing has observed here yet.
    val (mark, markColor, verdict) = when (row.status) {
        ScriptStatus.DONE -> Triple("✔ ", p.ok, "done")
        ScriptStatus.PENDING -> Triple("! ", p.warn, "pending")
        ScriptStatus.FAILED -> Triple("✘ ", p.error, "failed")
        null -> Triple("· ", p.dim, "not observed")
    }
    val name = clip(row.name, w.scriptName - 1).padEnd(w.scriptName)
    if (focused) {
        Text(
            fit(DETAIL_FOCUS + box + mark + name + verdict, width),
            color = p.selectionFg,
            background = p.selectionBg,
            textStyle = TextStyle.Bold,
        )
    } else {
        Row {
            Text(DETAIL_INDENT)
            Text(box, color = if (picked) p.accent else p.dim)
            Text(mark, color = markColor)
            Text(name)
            Text(verdict, color = if (row.status == ScriptStatus.DONE) p.dim else markColor)
        }
    }
}

/**
 * One row of the configs picker, under the configs row: a config unit, its
 * last verdict, the files apply would change, and a tick box.
 */
@Composable
private fun ConfigLine(s: HomeState, row: ConfigItem, focused: Boolean, width: Int, w: DetailWidths) {
    val p = LocalPalette.current
    val ticked = row.name in s.applying
    val box = if (ticked) "[x] " else "[ ] "
    val (mark, markColor, verdict) = when (row.status) {
        ConfigStatus.APPLIED -> Triple("✔ ", p.ok, "applied")
        ConfigStatus.DRIFTED -> Triple("! ", p.warn, "drifted")
        ConfigStatus.UNKNOWN -> Triple("? ", p.warn, "not checked")
        null -> Triple("· ", p.dim, "not observed")
    }
    val name = clip(row.name, w.configName - 1).padEnd(w.configName)
    val files = if (row.files.isEmpty()) "" else "  " + clip(row.files.joinToString(), w.configRoom)
    if (focused) {
        Text(
            fit(DETAIL_FOCUS + box + mark + name + verdict + files, width),
            color = p.selectionFg,
            background = p.selectionBg,
            textStyle = TextStyle.Bold,
        )
    } else {
        Row {
            Text(DETAIL_INDENT)
            Text(box, color = if (ticked) p.accent else p.dim)
            Text(mark, color = markColor)
            Text(name)
            Text(verdict, color = if (row.status == ConfigStatus.APPLIED) p.dim else markColor)
            if (files.isNotEmpty()) Text(files, color = p.dim)
        }
    }
}

@Composable
private fun HomeFooter(s: HomeState, width: Int, total: Int, scroll: Int, shown: Int) {
    val p = LocalPalette.current
    Text("")
    s.message?.let { Text(fit(" $it", width), color = p.warn) }
    // Two fixed lines, clipped to the terminal: a wrapped footer unpins the
    // bottom and the filler math goes with it.
    val tight = width < 100
    // The keys the cursor's own line answers to. It may sit on a subject row
    // with its table open below, so this follows the SUBJECT, not whether
    // the cursor is inside the list.
    val lines = homeLines(s)
    val at = snapCursor(lines, s.cursor)
    val section = lines.getOrNull(at)?.let { s.sections.getOrNull(it.section) }
    val open = section != null && section.action in s.open
    val context = when {
        open && section.action == HomeAction.INSTALL_MISSING ->
            if (tight) "↑↓ move · space tick · a all · u none · enter install · h close"
            else "↑↓ move  ·  space tick  ·  a all  ·  u none  ·  enter install" +
                (if (s.chosen.isEmpty()) "" else " ${s.chosen.size} ticked") + "  ·  h/esc close"
        open && section.action == HomeAction.RUN_SCRIPTS ->
            if (tight) "↑↓ move · space tick · a all · u none · enter run · h close"
            else "↑↓ move  ·  space tick  ·  a all  ·  u none  ·  enter run" +
                (if (s.picked.isEmpty()) "" else " ${s.picked.size} ticked") + "  ·  h/esc close"
        open && section.action == HomeAction.APPLY_CONFIGS ->
            if (tight) "↑↓ move · space tick · a all · u none · enter apply · h close"
            else "↑↓ move  ·  space tick  ·  a all  ·  u none  ·  enter apply" +
                (if (s.applying.isEmpty()) "" else " ${s.applying.size} ticked") + "  ·  h/esc close"
        open && section.action == HomeAction.REVIEW_OUTDATED ->
            if (tight) "↑↓ move · space · a all · u none · h fold/close · l unfold · K diff · enter upgrade"
            else "↑↓ move  ·  space select  ·  a all  ·  u none  ·  h fold, l unfold  ·  K diff ↗  ·  enter upgrade" +
                (if (s.selection.isEmpty()) "" else " ${s.selection.size} selected") + "  ·  h again/esc close"
        open ->
            if (tight) "↑↓ move · [ ] jump · h close" else "↑↓/pgup/pgdn move  ·  [ ] jump  ·  h/esc close"
        // The jump is on the lines with room for it: the pickers' own keys
        // fill theirs, and a footer that wraps unpins the bottom of the screen.
        else ->
            if (tight) "↑↓ move · [ ] jump · l open · enter act"
            else "↑↓/jk move  ·  [ ] jump to next list  ·  l/→ open  ·  enter act on this line"
    }
    // The whole screen scrolls now, so say where in it you are.
    val where = if (total > shown) "  ·  ${scroll + 1}-${scroll + shown} of $total" else ""
    val verbs =
        if (tight) "r re-check · S sync · U self-upgrade · C set up · t theme · q quit"
        else "r re-check  ·  S sync  ·  U upgrade loadout  ·  C set up this machine  ·  t theme  ·  q quit"
    Text(fit(" $context$where", width), color = p.dim)
    Text(fit(" $verbs", width), color = p.dim)
}
