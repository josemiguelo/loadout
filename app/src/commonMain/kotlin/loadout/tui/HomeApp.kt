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
    KeyEvent("Enter") -> HomeKey.ENTER
    KeyEvent("Escape") -> HomeKey.ESC
    KeyEvent(" ") -> HomeKey.SELECT
    KeyEvent("a") -> HomeKey.SELECT_ALL
    KeyEvent("u") -> HomeKey.SELECT_NONE
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
    // Detail lines an open section may use. Count the chrome exactly or the
    // header scrolls off the top: header + blank + 4 rows + scroll hint +
    // 3 footer lines + 1 spare, plus a line when there's a message.
    val viewport = (rows - 11 - (if (s.message != null) 1 else 0)).coerceAtLeast(3)
    // A page in the pane is the PANE's height, not the section list's.
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
            var body = 2
            // While the pane is up, nothing underneath is focused: a selection
            // bar's background would bleed through the pane's cells, and the
            // keyboard belongs to the pane regardless.
            val overlay = s.run != null
            for ((index, section) in s.sections.withIndex()) {
                val focused = index == s.cursor
                HomeSectionRow(
                    section,
                    focused = focused,
                    highlight = !overlay,
                    width = width,
                    rows = rows,
                    expanded = s.expanded,
                    spin = spin,
                )
                body++
                // The detail, opened in place: the answer is already here, so
                // showing it shouldn't mean leaving the screen.
                if (focused && s.expanded) {
                    body += when (section.action) {
                        HomeAction.INSTALL_MISSING ->
                            MissingTable(s, viewport, width, highlight = !overlay)
                        HomeAction.RUN_SCRIPTS ->
                            ScriptsTable(s, viewport, width, highlight = !overlay)
                        HomeAction.REVIEW_OUTDATED ->
                            RemoteTable(s.remote as? RemoteStatus.Answered, s, viewport, width, highlight = !overlay)
                        HomeAction.SHOW_DIFF ->
                            FleetTable(s.fleet, s.scroll, viewport, width, if (overlay) -1 else s.detailCursor)
                        else -> 0
                    }
                } else if (focused && section.offenders.isNotEmpty()) {
                    body += offenderLines(section, rows)
                }
            }
            // Fill the terminal: the footer belongs at the bottom.
            val footer = 3 + (if (s.message != null) 1 else 0)
            // -1: filling the last line scrolls the header off the top.
            repeat((rows - body - footer - 1).coerceAtLeast(0)) { Text("") }
            HomeFooter(s, width)
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
        Text(fit("╭─ $title ".padEnd(paneWidth - 1, '─') + "╮", paneWidth), color = edge)
        // An explicit foreground on every cell: Mosaic composites per cell,
        // and an uncoloured character inherits the colour of whatever was
        // underneath — which made the half of the pane over the dim columns
        // come out dim.
        for (line in window) {
            Row {
                Text("│ ", color = edge)
                if (line.startsWith(RUN_DIVIDER)) {
                    Text(clip(line, inner).padEnd(inner, '─'), color = p.dim)
                } else {
                    Text(clip(line, inner).padEnd(inner), color = p.text)
                }
                Text(" │", color = edge)
            }
        }
        // Keep the pane a stable size while output trickles in.
        repeat((paneRows - promptRows - window.size).coerceAtLeast(0)) {
            Row {
                Text("│ ", color = edge)
                Text(" ".repeat(inner), color = p.text)
                Text(" │", color = edge)
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
                    Text(" ", color = p.text)
                    Text(line, color = p.warn, textStyle = TextStyle.Bold)
                    Text(" ", color = p.text)
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
        Text(fit("╰─ $footer ".padEnd(paneWidth - 1, '─') + "╯", paneWidth), color = edge)
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
    rows: Int,
    expanded: Boolean = false,
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
    val summary = if (section.busy) frame else clip(section.summary, 41)
    val line = "  " + section.subject.padEnd(11) + summary.padEnd(42)
    if (focused && highlight && expanded) {
        // Its detail is open and the keys live there: the selection bar
        // belongs to the inner row, so the parent reads as the open heading
        // — accent, bold, no bar — and the two can't be confused.
        Row {
            Text(" ")
            Text(marker, color = markerColor, textStyle = TextStyle.Bold)
            Text(line, color = p.accent, textStyle = TextStyle.Bold)
            Text("▾ ${section.verb}", color = p.accent, textStyle = TextStyle.Bold)
        }
    } else if (focused && highlight) {
        Text(
            fit(" $marker$line" + (if (section.verb.isEmpty()) "" else "→ ${section.verb}"), width),
            color = p.selectionFg,
            background = p.selectionBg,
            textStyle = TextStyle.Bold,
        )
    } else {
        Row {
            Text(" ")
            Text(marker, color = markerColor, textStyle = TextStyle.Bold)
            Text(line)
            Text("  ${section.verb}", color = p.dim)
        }
    }
    // The offenders themselves, so nothing needs another screen to name them.
    if (focused && !expanded && section.offenders.isNotEmpty()) {
        val room = offenderRoom(rows)
        for (name in section.offenders.take(room)) {
            Text(DETAIL_INDENT + name, color = p.dim)
        }
        if (section.offenders.size > room) {
            Text(DETAIL_INDENT + "… and ${section.offenders.size - room} more", color = p.dim)
        }
    }
}

private fun offenderRoom(rows: Int) = (rows - 12).coerceIn(1, 6)

/** Lines the focused row's offender preview draws (for the filler). */
private fun offenderLines(section: HomeSection, rows: Int): Int {
    val room = offenderRoom(rows)
    return section.offenders.take(room).size + if (section.offenders.size > room) 1 else 0
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

/** Where you are in a list too long to show at once. */
@Composable
private fun ScrollHint(total: Int, scroll: Int, viewport: Int) {
    val p = LocalPalette.current
    if (total <= viewport) return
    val last = (scroll + viewport).coerceAtMost(total)
    Text(DETAIL_INDENT + "${scroll + 1}-$last of $total  ·  ↑↓ scrolls", color = p.dim)
}

/** The drifting half of `diff`, rendered under the fleet row. */
@Composable
private fun FleetTable(
    report: loadout.core.diff.DiffReport?,
    scroll: Int,
    viewport: Int,
    width: Int,
    cursor: Int,
): Int {
    val p = LocalPalette.current
    val drifted = report?.rows?.filter { it.drift || it.incomplete }.orEmpty()
    if (report == null || drifted.isEmpty()) return 0
    val nameWidth = drifted.maxOf { it.program.length }.coerceAtMost(26) + 2
    // Every machine gets a column: share what's left of the terminal.
    val colWidth = ((width - 8 - nameWidth) / report.machines.size.coerceAtLeast(1))
        .coerceIn(8, report.machines.maxOf { it.length } + 2)
    Row {
        Text(DETAIL_INDENT + "  ")
        Text("".padEnd(nameWidth), color = p.dim)
        for (machine in report.machines) Text(clip(machine, colWidth - 1).padEnd(colWidth), color = p.machine)
    }
    for ((offset, row) in drifted.drop(scroll).take(viewport).withIndex()) {
        val cells = report.machines.joinToString("") { machine ->
            val cell = when (val state = row.perMachine.getValue(machine)) {
                is InstallState.Installed -> state.version ?: "ok"
                InstallState.Missing -> "missing"
                InstallState.Unknown -> "-"
            }
            clip(cell, colWidth - 1).padEnd(colWidth)
        }
        if (scroll + offset == cursor) {
            Text(
                fit(
                    DETAIL_FOCUS + (if (row.incomplete) "✘ " else "! ") +
                        clip(row.program, nameWidth - 1).padEnd(nameWidth) + cells,
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
                Text(clip(row.program, nameWidth - 1).padEnd(nameWidth))
                Text(cells, color = if (row.drift) p.warn else p.dim)
            }
        }
    }
    ScrollHint(drifted.size, scroll, viewport)
    // +1 for the machine-name heading.
    return 1 + drifted.drop(scroll).take(viewport).size + if (drifted.size > viewport) 1 else 0
}

/**
 * The `outdated` table, rendered under the row that answered it — grouped
 * by what will ACT. A tool line says what ticking it means (every package
 * the tool reported, not only the declared ones under it); a program
 * under a tool ticks the tool; a custom source's items tick alone.
 */
@Composable
private fun RemoteTable(
    answered: RemoteStatus.Answered?,
    s: HomeState,
    viewport: Int,
    width: Int,
    highlight: Boolean = true,
): Int {
    val p = LocalPalette.current
    val lines = answered?.let { remoteLines(it) }.orEmpty()
    if (lines.isEmpty()) return 0
    val rows = answered!!.updates
    // Columns are capped, not just padded: one long name would otherwise
    // wrap every row and shred the table.
    val nameWidth = (rows.maxOfOrNull { it.name.length } ?: 8).coerceAtMost(26) + 2
    // Version columns get the room the terminal has: long java/sha strings
    // fit on a wide terminal and only get clipped on a narrow one.
    val versionCap = if (width >= 130) 30 else if (width >= 110) 22 else 16
    val currentWidth = (rows.maxOfOrNull { it.current.length } ?: 1).coerceAtMost(versionCap) + 2
    val candidateWidth = (rows.maxOfOrNull { it.candidate.length } ?: 1).coerceAtMost(versionCap) + 2
    val used = DETAIL_INDENT.length + 8 + nameWidth + currentWidth + 3 + candidateWidth
    val room = (width - used).coerceAtLeast(8)

    fun box(key: String?) = when {
        key == null -> "[–] "
        key in s.selection -> "[x] "
        else -> "[ ] "
    }
    fun version(row: UpdateRow) =
        clipVersion(row.current, currentWidth - 1).padEnd(currentWidth) + "-> " +
            clipVersion(row.candidate, candidateWidth - 1).padEnd(candidateWidth)

    for ((offset, line) in lines.drop(s.scroll).take(viewport).withIndex()) {
        val index = s.scroll + offset
        val focused = highlight && index == s.detailCursor
        val selected = line.key != null && line.key in s.selection
        when (line) {
            is RemoteLine.Tool -> {
                val t = line.info
                val total = t.total?.toString() ?: "?"
                val updates = if (t.total == 1) "1 update" else "$total updates"
                val what = when {
                    t.total == null -> "${t.declared.size} in your loadout · others unknown"
                    t.total == 0 -> "up to date"
                    t.declared.isEmpty() -> "$updates · none in your loadout"
                    else -> "$updates · ${t.declared.size} in your loadout"
                }
                val text = box(line.key) + clip(t.tool, 10).padEnd(11) + what.padEnd(36) +
                    (t.command?.let { clip(it, room) } ?: "")
                if (focused) {
                    Text(fit(DETAIL_FOCUS + text, width), color = p.selectionFg, background = p.selectionBg, textStyle = TextStyle.Bold)
                } else {
                    Row {
                        Text(DETAIL_INDENT)
                        Text(box(line.key), color = if (selected) p.accent else p.dim)
                        Text(clip(t.tool, 10).padEnd(11), textStyle = TextStyle.Bold)
                        Text(what.padEnd(36), color = if (t.total == 0) p.ok else p.warn)
                        Text(t.command?.let { clip(it, room) } ?: "", color = p.dim)
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
                val note = if (row.note.isNotEmpty() && room > 12) "  " + clip(row.note, room - 2) else ""
                val text = lead + "↑ " + clip(row.name, nameWidth - 1).padEnd(nameWidth) + version(row) + note
                if (focused) {
                    Text(fit(DETAIL_FOCUS + text, width), color = p.selectionFg, background = p.selectionBg, textStyle = TextStyle.Bold)
                } else {
                    Row {
                        Text(DETAIL_INDENT)
                        Text(lead, color = if (selected) p.accent else p.dim)
                        Text("↑ ", color = p.warn)
                        Text(clip(row.name, nameWidth - 1).padEnd(nameWidth))
                        Text(clipVersion(row.current, currentWidth - 1).padEnd(currentWidth), color = p.dim)
                        Text("-> ", color = p.dim)
                        Text(clipVersion(row.candidate, candidateWidth - 1).padEnd(candidateWidth), color = p.warn)
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
                if (focused) {
                    Text(fit(DETAIL_FOCUS + sbox + line.name, width), color = p.selectionFg, background = p.selectionBg, textStyle = TextStyle.Bold)
                } else {
                    Row {
                        Text(DETAIL_INDENT)
                        Text(sbox, color = if (all) p.accent else p.dim)
                        Text(line.name, textStyle = TextStyle.Bold)
                    }
                }
            }
            is RemoteLine.Gap -> Text("")
        }
    }
    ScrollHint(lines.size, s.scroll, viewport)
    return lines.drop(s.scroll).take(viewport).size + if (lines.size > viewport) 1 else 0
}

/**
 * The programs picker, rendered under the programs row: every program the
 * last observation found missing, with what would install it, all ticked.
 */
@Composable
private fun MissingTable(s: HomeState, viewport: Int, width: Int, highlight: Boolean = true): Int {
    val p = LocalPalette.current
    val rows = s.missing
    if (rows.isEmpty()) return 0
    val nameWidth = rows.maxOf { it.name.length }.coerceAtMost(30) + 2
    val keyWidth = rows.maxOf { it.installKey.length }.coerceAtMost(12) + 2
    val used = DETAIL_INDENT.length + 6 + nameWidth + keyWidth
    for ((offset, row) in rows.drop(s.scroll).take(viewport).withIndex()) {
        val index = s.scroll + offset
        val focused = highlight && index == s.detailCursor
        val chosen = row.name in s.chosen
        val box = if (chosen) "[x] " else "[ ] "
        val name = clip(row.name, nameWidth - 1).padEnd(nameWidth)
        val key = clip("[${row.installKey}]", keyWidth - 1).padEnd(keyWidth)
        val command = clip(row.command, (width - used).coerceAtLeast(8))
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
    ScrollHint(rows.size, s.scroll, viewport)
    return rows.drop(s.scroll).take(viewport).size + if (rows.size > viewport) 1 else 0
}

/**
 * The scripts picker, rendered under the scripts row: every maintenance
 * script this machine opts into, its last verdict, and a tick box. Ticking
 * a done one is how you force it.
 */
@Composable
private fun ScriptsTable(s: HomeState, viewport: Int, width: Int, highlight: Boolean = true): Int {
    val p = LocalPalette.current
    val rows = s.scripts
    if (rows.isEmpty()) return 0
    val nameWidth = rows.maxOf { it.name.length }.coerceAtMost(30) + 2
    for ((offset, row) in rows.drop(s.scroll).take(viewport).withIndex()) {
        val index = s.scroll + offset
        val focused = highlight && index == s.detailCursor
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
        val name = clip(row.name, nameWidth - 1).padEnd(nameWidth)
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
    ScrollHint(rows.size, s.scroll, viewport)
    return rows.drop(s.scroll).take(viewport).size + if (rows.size > viewport) 1 else 0
}

@Composable
private fun HomeFooter(s: HomeState, width: Int) {
    val p = LocalPalette.current
    Text("")
    s.message?.let { Text(fit(" $it", width), color = p.warn) }
    // Two fixed lines, clipped to the terminal: a wrapped footer unpins the
    // bottom and the filler math goes with it.
    val tight = width < 100
    val context = when {
        s.expanded && s.sections.getOrNull(s.cursor)?.action == HomeAction.INSTALL_MISSING ->
            if (tight) "↑↓ move · space tick · a all · u none · enter install · h close"
            else "↑↓ move  ·  space tick  ·  a all  ·  u none  ·  enter install" +
                (if (s.chosen.isEmpty()) "" else " ${s.chosen.size} ticked") + "  ·  h/esc close"
        s.expanded && s.sections.getOrNull(s.cursor)?.action == HomeAction.RUN_SCRIPTS ->
            if (tight) "↑↓ move · space tick · a all · u none · enter run · h close"
            else "↑↓ move  ·  space tick  ·  a all  ·  u none  ·  enter run" +
                (if (s.picked.isEmpty()) "" else " ${s.picked.size} ticked") + "  ·  h/esc close"
        s.expanded && s.sections.getOrNull(s.cursor)?.action == HomeAction.REVIEW_OUTDATED ->
            if (tight) "↑↓ move · space select pm · a all · u none · enter upgrade · h close"
            else "↑↓ move  ·  space select  ·  a all  ·  u none  ·  enter upgrade" +
                (if (s.selection.isEmpty()) "" else " ${s.selection.size} selected") + "  ·  h/esc close"
        s.expanded ->
            if (tight) "↑↓ scroll · h close" else "↑↓/pgup/pgdn scroll  ·  h/esc close"
        else ->
            if (tight) "↑↓ move · l open · enter act" else "↑↓/jk move  ·  l/→ open  ·  enter act on this line"
    }
    val verbs =
        if (tight) "r re-check · S sync · U self-upgrade · C set up · t theme · q quit"
        else "r re-check  ·  S sync  ·  U upgrade loadout  ·  C set up this machine  ·  t theme  ·  q quit"
    Text(fit(" $context", width), color = p.dim)
    Text(fit(" $verbs", width), color = p.dim)
}
