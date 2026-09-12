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
import com.jakewharton.mosaic.runMosaicBlocking
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
    runMosaicBlocking { HomeApp(model) }
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
    KeyEvent("u") -> HomeKey.UPGRADE_SELECTION
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
    // Detail lines an open section may use: the terminal minus the header,
    // the four rows, the column heading and the footer.
    val viewport = (rows - 10).coerceAtLeast(3)

    CompositionLocalProvider(LocalPalette provides paletteFor(s.dark)) {
      Box(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.onKeyEvent { event ->
                homeKeyOf(event)?.let { model.handleKey(it, viewport) } != null
            },
        ) {
            HomeHeader(s, width)
            Text("")
            var body = 2
            for ((index, section) in s.sections.withIndex()) {
                val focused = index == s.cursor
                HomeSectionRow(
                    section,
                    focused = focused,
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
                        HomeAction.REVIEW_OUTDATED ->
                            RemoteTable(s.remote as? RemoteStatus.Answered, s, viewport, width)
                        HomeAction.SHOW_DIFF -> FleetTable(s.fleet, s.scroll, viewport, width)
                        else -> 0
                    }
                } else if (focused && section.offenders.isNotEmpty()) {
                    body += offenderLines(section, rows)
                }
            }
            // Fill the terminal: the footer belongs at the bottom, the same
            // way the maintain screen pins its key bar.
            val footer = 3 + (if (s.message != null) 1 else 0)
            // -1 like the maintain screen: filling the last line scrolls the
            // header off the top.
            repeat((rows - body - footer - 1).coerceAtLeast(0)) { Text("") }
            HomeFooter(s, width)
        }
        s.run?.let { RunPane(it, spin, width, rows) }
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
private fun BoxScope.RunPane(run: UpgradeRun, spin: Int, width: Int, rows: Int) {
    val p = LocalPalette.current
    // 80% of the viewport, both ways.
    val paneWidth = (width * 8 / 10).coerceIn(40, width - 2)
    val paneRows = (rows * 8 / 10).coerceIn(6, rows - 3)
    val inner = paneWidth - 4
    val title = when {
        run.cancelled -> "cancelled"
        run.done && run.failed -> "upgrade failed"
        run.done -> "upgrade finished"
        else -> "upgrading ${run.label}  ${SPINNER[spin % SPINNER.size]}"
    }
    val edge = if (run.failed) p.error else p.accent
    // No background modifier: the pane's own spaces hide what's behind it,
    // so it sits on the TERMINAL's background and follows dark/light like
    // everything else. A painted panel colour would fight the theme.
    Column(modifier = Modifier.align(Alignment.Center)) {
        Text(fit("╭─ $title ".padEnd(paneWidth - 1, '─') + "╮", paneWidth), color = edge)
        val body = run.log.takeLast(paneRows)
        for (line in body) {
            Row {
                Text("│ ", color = edge)
                Text(clip(line, inner).padEnd(inner))
                Text(" │", color = edge)
            }
        }
        // Keep the pane a stable size while output trickles in.
        repeat((paneRows - body.size).coerceAtLeast(0)) {
            Row {
                Text("│ ", color = edge)
                Text(" ".repeat(inner))
                Text(" │", color = edge)
            }
        }
        val footer = when {
            run.done -> run.summary.ifEmpty { "enter closes" }
            else -> "step ${run.current + 1} of ${run.steps.size}  ·  esc cancels"
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
            Text("   last observed state — s re-checks", color = p.dim)
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
    val summary = when {
        !section.busy -> section.summary
        section.summary.isEmpty() -> frame
        else -> "${section.summary}  $frame"
    }
    val line = "  " + section.subject.padEnd(11) + summary.padEnd(42)
    if (focused) {
        Text(
            fit(" $marker$line→ ${section.verb}", width),
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
            Text("        $name", color = p.dim)
        }
        if (section.offenders.size > room) {
            Text("        … and ${section.offenders.size - room} more", color = p.dim)
        }
    }
}

private fun offenderRoom(rows: Int) = (rows - 12).coerceIn(1, 6)

/** Lines the focused row's offender preview draws (for the filler). */
private fun offenderLines(section: HomeSection, rows: Int): Int {
    val room = offenderRoom(rows)
    return section.offenders.take(room).size + if (section.offenders.size > room) 1 else 0
}

/** Truncate to [max] columns; a wrapped row shreds the table. */
private fun clip(text: String, max: Int) = if (text.length <= max) text else text.take(max - 1) + "…"

/** Where you are in a list too long to show at once. */
@Composable
private fun ScrollHint(total: Int, scroll: Int, viewport: Int) {
    val p = LocalPalette.current
    if (total <= viewport) return
    val last = (scroll + viewport).coerceAtMost(total)
    Text("      ${scroll + 1}-$last of $total  ·  ↑↓ scrolls", color = p.dim)
}

/** The drifting half of `diff`, rendered under the fleet row. */
@Composable
private fun FleetTable(report: loadout.core.diff.DiffReport?, scroll: Int, viewport: Int, width: Int): Int {
    val p = LocalPalette.current
    val drifted = report?.rows?.filter { it.drift || it.incomplete }.orEmpty()
    if (report == null || drifted.isEmpty()) return 0
    val nameWidth = drifted.maxOf { it.program.length }.coerceAtMost(26) + 2
    // Every machine gets a column: share what's left of the terminal.
    val colWidth = ((width - 8 - nameWidth) / report.machines.size.coerceAtLeast(1))
        .coerceIn(8, report.machines.maxOf { it.length } + 2)
    Row {
        Text("        ")
        Text("".padEnd(nameWidth), color = p.dim)
        for (machine in report.machines) Text(clip(machine, colWidth - 1).padEnd(colWidth), color = p.machine)
    }
    for (row in drifted.drop(scroll).take(viewport)) {
        Row {
            Text("      ")
            Text(if (row.incomplete) "✘ " else "! ", color = if (row.incomplete) p.error else p.warn)
            Text(clip(row.program, nameWidth - 1).padEnd(nameWidth))
            for (machine in report.machines) {
                val cell = when (val state = row.perMachine.getValue(machine)) {
                    is InstallState.Installed -> state.version ?: "ok"
                    InstallState.Missing -> "missing"
                    InstallState.Unknown -> "-"
                }
                Text(clip(cell, colWidth - 1).padEnd(colWidth), color = if (row.drift) p.warn else p.dim)
            }
        }
    }
    ScrollHint(drifted.size, scroll, viewport)
    // +1 for the machine-name heading.
    return 1 + drifted.drop(scroll).take(viewport).size + if (drifted.size > viewport) 1 else 0
}

/** The `outdated` table, rendered under the row that answered it. */
@Composable
private fun RemoteTable(answered: RemoteStatus.Answered?, s: HomeState, viewport: Int, width: Int): Int {
    val p = LocalPalette.current
    val updates = answered?.updates.orEmpty()
    if (updates.isEmpty()) return 0
    // Columns are capped, not just padded: one long name would otherwise
    // wrap every row and shred the table.
    val nameWidth = updates.maxOf { it.name.length }.coerceAtMost(26) + 2
    val currentWidth = updates.maxOf { it.current.length }.coerceAtMost(16) + 2
    val candidateWidth = updates.maxOf { it.candidate.length }.coerceAtMost(16) + 2
    val sourceWidth = updates.maxOf { it.source.length }.coerceAtMost(12) + 2
    val used = 12 + nameWidth + currentWidth + 3 + candidateWidth + sourceWidth
    for ((offset, row) in updates.drop(s.scroll).take(viewport).withIndex()) {
        val index = s.scroll + offset
        val focused = index == s.detailCursor
        // [x] picked · [ ] could be · [–] loadout has no way to upgrade it.
        // Ticked by TOOL: picking a brew row picks casks too, and any dnf
        // row picks dnf-repo and dnf-copr — that's what the upgrade does.
        val mechanism = answered?.mechanismOf?.get(row.name)
        val tool = mechanism?.let { answered.toolOf[it] }
        val selected = tool != null && tool in s.selection
        val box = when {
            mechanism == null -> "[–] "
            selected -> "[x] "
            else -> "[ ] "
        }
        Row {
            Text(if (focused) "    > " else "      ")
            Text(box, color = if (selected) p.accent else p.dim)
            Text("↑ ", color = p.warn)
            Text(clip(row.name, nameWidth - 1).padEnd(nameWidth))
            Text(clip(row.current, currentWidth - 1).padEnd(currentWidth), color = p.dim)
            Text("-> ", color = p.dim)
            Text(clip(row.candidate, candidateWidth - 1).padEnd(candidateWidth), color = p.warn)
            Text(clip("[${row.source}]", sourceWidth), color = p.dim)
            if (row.note.isNotEmpty() && width - used > 12) {
                Text("  " + clip(row.note, width - used - 2), color = p.dim)
            }
        }
    }
    ScrollHint(updates.size, s.scroll, viewport)
    return updates.drop(s.scroll).take(viewport).size + if (updates.size > viewport) 1 else 0
}

@Composable
private fun HomeFooter(s: HomeState, width: Int) {
    val p = LocalPalette.current
    Text("")
    s.message?.let {
        Text(fit(" $it", width), color = p.warn)
    }
    Row {
        Text(" ")
        if (s.expanded && s.sections.getOrNull(s.cursor)?.action == HomeAction.REVIEW_OUTDATED) {
            Text("↑↓", color = p.accent, textStyle = TextStyle.Bold)
            Text(" move  ·  ", color = p.dim)
            Text("space", color = p.accent, textStyle = TextStyle.Bold)
            Text(" select its package manager  ·  ", color = p.dim)
            Text("a", color = p.accent, textStyle = TextStyle.Bold)
            Text(" all  ·  ", color = p.dim)
            Text("u", color = p.accent, textStyle = TextStyle.Bold)
            Text(
                if (s.selection.isEmpty()) " upgrade  ·  "
                else " upgrade ${s.selection.joinToString(", ")}  ·  ",
                color = p.dim,
            )
            Text("enter/h", color = p.accent, textStyle = TextStyle.Bold)
            Text(" close", color = p.dim)
        } else if (s.expanded) {
            Text("↑↓/pgup/pgdn", color = p.accent, textStyle = TextStyle.Bold)
            Text(" scroll  ·  ", color = p.dim)
            Text("enter/h/esc", color = p.accent, textStyle = TextStyle.Bold)
            Text(" close", color = p.dim)
        } else {
            Text("↑↓/jk", color = p.accent, textStyle = TextStyle.Bold)
            Text(" move  ·  ", color = p.dim)
            Text("enter", color = p.accent, textStyle = TextStyle.Bold)
            Text(" act on this line  ·  ", color = p.dim)
            Text("l", color = p.accent, textStyle = TextStyle.Bold)
            Text(" open", color = p.dim)
        }
    }
    // Verbs for the whole machine, always available.
    Row {
        Text(" ")
        Text("r", color = p.accent, textStyle = TextStyle.Bold)
        Text(" re-check  ·  ", color = p.dim)
        Text("S", color = p.accent, textStyle = TextStyle.Bold)
        Text(" sync  ·  ", color = p.dim)
        Text("U", color = p.accent, textStyle = TextStyle.Bold)
        Text(" upgrade loadout  ·  ", color = p.dim)
        Text("C", color = p.accent, textStyle = TextStyle.Bold)
        Text(" set up this machine  ·  ", color = p.dim)
        Text("t", color = p.accent, textStyle = TextStyle.Bold)
        Text(" theme  ·  ", color = p.dim)
        Text("q", color = p.accent, textStyle = TextStyle.Bold)
        Text(" quit", color = p.dim)
    }
}
