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
import loadout.core.diff.InstallState
import loadout.core.model.ScriptStatus
import loadout.core.TOOL_VERSION
import loadout.core.platform.terminalColumns
import loadout.core.platform.terminalRows
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay

/**
 * Opens the home screen and returns what the user chose. The caller runs it
 * — outside Mosaic, so the action owns the terminal.
 */
fun runHomeTui(app: AppContext): HomeAction {
    val model = HomeModel(app)
    model.load()
    model.refresh()
    runTui { HomeApp(model) }
    return model.state.action
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
    else -> null
}

@Composable
private fun HomeApp(model: HomeModel) {
    val s = model.state

    var spin by remember { mutableIntStateOf(0) }
    val spinning = s.loading || s.remote is RemoteStatus.Asking || s.run?.done == false
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
    // A page in the pane is the PANE's height, not the body's.
    val paneRows = (rows * 8 / 10).coerceIn(6, rows - 3)

    CompositionLocalProvider(LocalPalette provides paletteFor(s.dark)) {
      Box(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.onKeyEvent { event ->
                // A password field eats printable keys; enter/esc still reduce.
                if (s.run?.password != null && model.passwordKey(event.key)) return@onKeyEvent true
                homeKeyOf(event)?.let {
                    model.handleKey(it, if (s.run != null) paneRows else viewport)
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
        s.run?.let { RunPane(it, spin, width, paneRows) }
      }
    }
    if (!s.exit) {
        LaunchedEffect(Unit) { awaitCancellation() }
    }
}

/**
 * The floating pane: a real overlay (Mosaic's Box composites children in
 * order), centred over the screen, tailing whatever is running. Only
 * non-interactive commands stream here — a password prompt behind a pane is
 * invisible, so sudo's cache has to be warm before we start.
 */
@Composable
private fun BoxScope.RunPane(run: PaneRun, spin: Int, width: Int, paneRows: Int) {
    val p = LocalPalette.current
    // 80% of the viewport, both ways.
    val paneWidth = (width * 8 / 10).coerceIn(40, width - 2)
    val inner = paneWidth - 4
    val frame = SPINNER[spin % SPINNER.size]
    val title = when {
        run.kind == PaneKind.LIST -> run.title
        run.confirming -> "run this?"
        run.cancelled -> "cancelled"
        // A script that ran fine but whose check still fails isn't a failed
        // run — it's work that isn't done yet. Same for a program still missing.
        run.done && run.failed -> when (run.kind) {
            PaneKind.SCRIPTS -> "not all done"
            PaneKind.INSTALL -> "not all installed"
            else -> "upgrade failed"
        }
        run.done -> when (run.kind) {
            PaneKind.SCRIPTS -> "run finished"
            PaneKind.INSTALL -> "install finished"
            else -> "upgrade finished"
        }
        else -> when (run.kind) {
            PaneKind.SCRIPTS -> "running ${run.label}  $frame"
            PaneKind.INSTALL -> "installing ${run.label}  $frame"
            else -> "upgrading ${run.label}  $frame"
        }
    }
    val edge = if (run.failed) p.error else p.accent
    val lines = if (run.confirming) {
        val intro = when (run.kind) {
            PaneKind.SCRIPTS -> "These scripts will run, in order:"
            PaneKind.INSTALL -> "These programs will install, in order:"
            else -> "These commands will run, in order:"
        }
        listOf(intro, "") + run.commands +
            if (run.sweeps.isEmpty()) {
                emptyList()
            } else {
                listOf(
                    "",
                    "Note: ${run.sweeps.joinToString(", ")} will upgrade every package it manages,",
                    "not only the ones listed above — that is how these package managers work.",
                )
            }
    } else {
        run.log
    }
    // Scrolled back? Pin the window there; otherwise follow the tail. The
    // password prompt takes the bottom rows of the body as its own box.
    val promptRows = if (run.password != null) 5 else 0
    // A list reads from the top; a log follows its tail.
    val window = if (run.kind == PaneKind.LIST) lines.drop(run.scrollBack).take(paneRows - promptRows)
    else lines.dropLast(run.scrollBack).takeLast(paneRows - promptRows)
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
        for (line in window) {
            Row {
                Text("│ ", color = edge, textStyle = plain)
                if (line.startsWith(RUN_DIVIDER)) {
                    Text(clip(line, inner).padEnd(inner, '─'), color = p.dim, textStyle = plain)
                } else {
                    Text(clip(line, inner).padEnd(inner), color = p.text, textStyle = plain)
                }
                Text(" │", color = edge, textStyle = plain)
            }
        }
        // Keep the pane a stable size while output trickles in.
        repeat((paneRows - promptRows - window.size).coerceAtLeast(0)) {
            Row {
                Text("│ ", color = edge, textStyle = plain)
                Text(" ".repeat(inner), color = p.text, textStyle = plain)
                Text(" │", color = edge, textStyle = plain)
            }
        }
        // The one moment the pane asks YOU something: a box of its own,
        // amber and bold, so it can't be mistaken for another log line.
        run.password?.let { typed ->
            val boxWidth = inner - 2
            val boxInner = boxWidth - 4
            val field = "sudo password: " + "•".repeat(typed.length) + "_"
            val hint = run.passwordError ?: "enter confirms  ·  esc goes back"
            val boxLines = listOf(
                "╭" + "─".repeat(boxWidth - 2) + "╮",
                "│ " + fit("a step needs your sudo password", boxInner) + " │",
                "│ " + fit(field, boxInner) + " │",
                "│ " + fit(hint, boxInner) + " │",
                "╰" + "─".repeat(boxWidth - 2) + "╯",
            )
            for (line in boxLines) {
                Row {
                    Text("│ ", color = edge)
                    Text(" ", color = p.text, textStyle = TextStyle.Empty)
                    Text(line, color = p.warn, textStyle = TextStyle.Bold)
                    Text(" ", color = p.text, textStyle = TextStyle.Empty)
                    Text(" │", color = edge)
                }
            }
        }
        val below = if (run.kind == PaneKind.LIST) lines.size - run.scrollBack - window.size else run.scrollBack
        val scrolled = if (below > 0) "  ·  $below more below" else ""
        val footer = when {
            run.password != null -> "type the password above  ·  enter  ·  esc back"
            run.confirming -> "enter runs it  ·  esc cancels  ·  ↑↓/pgup/pgdn scroll$scrolled"
            run.done -> run.summary.ifEmpty { "enter closes" } + "  ·  ↑↓/pgup/pgdn scroll" + scrolled
            else -> "step ${run.current + 1} of ${run.steps.size}  ·  ↑↓/pgup/pgdn scroll  ·  esc cancels$scrolled"
        }
        Text(fit("╰─ $footer ".padEnd(paneWidth - 1, '─') + "╯", paneWidth), color = edge, textStyle = TextStyle.Empty)
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
    val fleetName = (drifted.maxOfOrNull { it.program.length } ?: 8).coerceAtMost(26) + 2
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

/** One drifting program of `diff`, rendered under the fleet row. */
@Composable
private fun FleetRow(
    s: HomeState,
    // Not the TUI's ProgramRow: the fleet's, one program across machines.
    row: loadout.core.diff.ProgramRow,
    focused: Boolean,
    width: Int,
    w: DetailWidths,
) {
    val p = LocalPalette.current
    val machines = s.fleet?.machines.orEmpty()
    val cells = machines.joinToString("") { machine ->
        val cell = when (val state = row.perMachine.getValue(machine)) {
            is InstallState.Installed -> state.version ?: "ok"
            InstallState.Missing -> "missing"
            InstallState.Unknown -> "-"
        }
        clip(cell, w.fleetColumn - 1).padEnd(w.fleetColumn)
    }
    if (focused) {
        Text(
            fit(
                DETAIL_FOCUS + (if (row.incomplete) "✘ " else "! ") +
                    clip(row.program, w.fleetName - 1).padEnd(w.fleetName) + cells,
                width,
            ),
            color = p.selectionFg,
            background = p.selectionBg,
            textStyle = TextStyle.Bold,
        )
    } else {
        Row {
            Text(DETAIL_INDENT)
            Text(if (row.incomplete) "✘ " else "! ", color = if (row.incomplete) p.error else p.warn)
            Text(clip(row.program, w.fleetName - 1).padEnd(w.fleetName))
            Text(cells, color = if (row.drift) p.warn else p.dim)
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
