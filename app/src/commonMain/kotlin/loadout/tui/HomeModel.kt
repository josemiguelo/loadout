package loadout.tui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import loadout.cli.AppContext
import loadout.cli.ToolUpdates
import loadout.cli.UpdateRow
import loadout.cli.outdatedReport
import loadout.core.TOOL_VERSION
import loadout.core.diff.DiffEngine
import loadout.core.manifest.ManifestLoader
import loadout.core.model.MachineState
import loadout.core.model.Manifest
import loadout.core.model.ProgramStatus
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus
import loadout.core.model.SystemInfo
import loadout.core.engine.InstallEngine
import loadout.core.engine.PlanItem
import loadout.core.engine.ScriptRunner
import loadout.core.engine.ToolDown
import loadout.core.engine.UpgradeEngine
import loadout.core.engine.VersionChecker
import loadout.core.exec.RunningProcess
import loadout.core.platform.blockingDispatcher
import loadout.core.platform.nowIso
import loadout.theme.terminalIsDark
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.concurrent.atomics.AtomicBoolean
import kotlin.concurrent.atomics.ExperimentalAtomicApi

/** What a pane run is doing — the words and the ending differ, nothing else. LIST runs nothing: it shows. */
enum class PaneKind { UPGRADE, SCRIPTS, INSTALL, LIST }

/** A run in the floating pane — first as a question, then as it happens. */
data class PaneRun(
    val steps: List<String>,
    val kind: PaneKind = PaneKind.UPGRADE,
    /** A LIST pane's own title; the run kinds derive theirs from what they do. */
    val title: String = "",
    /** Some step invokes sudo: the yes may have to ask for a password first. */
    val needsSudo: Boolean = false,
    /**
     * The password being typed, while the pane asks for one (null = not
     * asking). Held only until `sudo -S -v` has stamped sudo's cache.
     */
    val password: String? = null,
    /** Why the last password was refused, shown next to the field. */
    val passwordError: String? = null,
    val current: Int = 0,
    val label: String = "",
    val log: List<String> = emptyList(),
    val done: Boolean = false,
    val failed: Boolean = false,
    /** Steps that exited non-zero, by label — named in the summary. */
    val failures: List<String> = emptyList(),
    val cancelled: Boolean = false,
    val summary: String = "",
    /** Showing the plan and waiting for a yes — nothing has run yet. */
    val confirming: Boolean = false,
    /** The exact commands, shown while confirming. */
    val commands: List<String> = emptyList(),
    /** Package managers about to upgrade EVERYTHING they manage. */
    val sweeps: List<String> = emptyList(),
    /**
     * Lines held back from the bottom. 0 follows the tail (the normal live
     * view); scrolling back pins the window so output can be read.
     */
    val scrollBack: Int = 0,
)

enum class HomeKey {
    UP, DOWN, PAGE_UP, PAGE_DOWN, PREV_HEADING, NEXT_HEADING, ENTER, OPEN, CLOSE, ESC,
    SELECT, SELECT_ALL, SELECT_NONE, OPEN_LINK,
    REFRESH, SYNC, UPGRADE, CONVERGE, THEME, QUIT,
}

/** One missing program, as the programs row lists it: what would install it. */
data class ProgramRow(
    val name: String,
    val installKey: String,
    val command: String,
)

/** One of this machine's maintenance scripts, as the scripts row lists it. */
data class ScriptRow(
    val name: String,
    /** The script itself, machine args applied — what the pane runs. */
    val command: String,
    /** Its check with args applied, when it has one (sudo guard only: the refresh re-asks it). */
    val check: String? = null,
    /** Declared `sudo = true`: it needs the password without saying `sudo`. */
    val sudo: Boolean = false,
    /** The last observed verdict; null = never observed here. */
    val status: ScriptStatus? = null,
)

/** What the remotes have said so far — they're asked on open, not on demand. */
sealed interface RemoteStatus {
    data object Asking : RemoteStatus
    data class Answered(
        val updates: List<UpdateRow>,
        val failedSources: Int,
        /** The doctor's view: every tool asked, with everything it reported, declared or not. */
        val tools: List<ToolUpdates> = emptyList(),
        /**
         * Row name to the mechanism that can upgrade it. Upgrades are whole-
         * mechanism, so picking a row means picking its installer. PROGRAM
         * rows only — a custom source's row is never in here, however its
         * item happens to be named (see [sources]).
         */
        val mechanismOf: Map<String, String> = emptyMap(),
        /**
         * Mechanism to the TOOL it drives (its probe binary): brew and
         * brew-cask are both "brew", dnf/dnf-repo/dnf-copr are all "dnf".
         * Selecting a row selects its tool — you upgrade brew, not formulae
         * but not casks.
         */
        val toolOf: Map<String, String> = emptyMap(),
        /** Tool to every mechanism it covers, for handing the engine names. */
        val mechanismsOfTool: Map<String, List<String>> = emptyMap(),
        /**
         * EVERY custom source, mapped to whether it can update ONE of its
         * items (`upgrade` declared). Rows from an upgradable one tick
         * individually — a pin in a file has nothing in common with the next
         * pin. Keyed by SOURCE, not by row name: the same name can appear in
         * two sources (python is an asdf tool and an asdf plugin), and a
         * name-keyed map made them one row.
         *
         * Read-only sources are in here too, because what a row IS comes from
         * where it came from, never from its name. A source's item may share
         * a name with a mapped program — the live repo has a `tpack` tmux
         * plugin and a `tpack` brew cask, a `rust` asdf pin and a `rust`
         * package — and a name lookup filed it under that program's tool, so
         * ticking it ran `brew upgrade`, which cannot move a git clone, and
         * the row came back outdated forever. One field, so "is a source" and
         * "can be upgraded" can never drift apart.
         */
        val sources: Map<String, Boolean> = emptyMap(),
    ) : RemoteStatus {
        /** Sources that can move an item; their rows tick one at a time. */
        val upgradableSources: Set<String> get() = sources.filterValues { it }.keys
        val names: List<String> get() = updates.map { it.name }
    }
    data class Unavailable(val reason: String) : RemoteStatus
}

/** What the user chose. The screen decides; the matching command does it. */
enum class HomeAction {
    NONE,

    // Row verbs: what the focused subject needs. None of these leaves the
    // screen: each opens its table in place and acts from it, in the pane.
    RUN_SCRIPTS, INSTALL_MISSING, REVIEW_OUTDATED, SHOW_DIFF,

    // Whole-machine verbs, on their own keys — they belong to no single row.
    SYNC, UPGRADE, SETUP,
}

/** One subject line: its verdict, and the single verb that resolves it. */
data class HomeSection(
    val subject: String,
    val summary: String,
    val verb: String,
    val action: HomeAction,
    /** null = settled, false = needs attention, true = severe. */
    val severity: Boolean? = null,
    /** Nothing has been asked yet, so neither settled nor a problem. */
    val neutral: Boolean = false,
    /** This subject is being (re)checked right now — the row spins. */
    val busy: Boolean = false,
)

data class HomeState(
    val machine: String = "",
    val system: String = "",
    val sections: List<HomeSection> = emptyList(),
    /**
     * The focused body line — an index into [homeLines], which counts
     * subject rows and the lines of every open detail alike. One cursor for
     * the whole screen: moving up off a table's first row lands on its
     * subject row, and then on the subject above it.
     */
    val cursor: Int = 0,
    val loading: Boolean = false,
    /** The verdicts are the last `status`'s, not this moment's. */
    val stale: Boolean = false,
    val remote: RemoteStatus? = null,
    /** The fleet comparison, kept so the fleet row can open it in place. */
    val fleet: loadout.core.diff.DiffReport? = null,
    /**
     * Every subject whose detail is open, by action — several at once. Only
     * an explicit h/esc closes one: walking away from a table, or opening
     * another, leaves it exactly as it was.
     */
    val open: Set<HomeAction> = emptySet(),
    /** First visible body line: the whole screen scrolls, not each table. */
    val scroll: Int = 0,
    /**
     * The detail line each subject was last focused on, so reopening its
     * table puts you back where you left instead of at its first row.
     */
    val lastRow: Map<HomeAction, Int> = emptyMap(),
    /** Rows ticked for upgrading, by program name. */
    val selection: Set<String> = emptySet(),
    /** Remote-table groups folded shut (`tool:<probe>` / `source:<name>`): h/l inside the table. */
    val collapsed: Set<String> = emptySet(),
    /** This machine's missing programs, in install order, with what would install each. */
    val missing: List<ProgramRow> = emptyList(),
    /** Missing programs ticked to install. All of them, after every re-check: missing IS the work. */
    val chosen: Set<String> = emptySet(),
    /** This machine's maintenance scripts, in run order, with their last verdicts. */
    val scripts: List<ScriptRow> = emptyList(),
    /** Scripts ticked to run. Follows the verdicts: not done = ticked, after every re-check. */
    val picked: Set<String> = emptySet(),
    /** The upgrade or script run in the floating pane, if any. */
    val run: PaneRun? = null,
    val message: String? = null,
    val dark: Boolean = true,
    val exit: Boolean = false,
    val action: HomeAction = HomeAction.NONE,
)

/**
 * The home screen: one place that says what needs working on, and hands each
 * kind of work to the command that already does it.
 *
 * It owns NO domain logic — StatusEngine observes, DiffEngine compares, and
 * every action dispatches to a real subcommand. That is the difference
 * between this and the dashboard deleted in 2026-08: that one re-displayed
 * what commands did; this one orchestrates them.
 */
class HomeModel(private val app: AppContext) {
    var state by mutableStateOf(
        // Before Mosaic owns the terminal (OSC 11 query).
        HomeState(dark = terminalIsDark()),
    )
        private set

    internal fun setStateForTest(s: HomeState) {
        state = s
    }

    private val scope = CoroutineScope(SupervisorJob() + blockingDispatcher)

    /**
     * Held for every write of [state] — see [update]. A spin lock, not a
     * coroutine Mutex: keys write from the UI thread, outside any coroutine.
     */
    @OptIn(ExperimentalAtomicApi::class)
    private val writing = AtomicBoolean(false)

    /**
     * The ONE way [state] changes: [change] gets the state as it is at that
     * moment and returns the next one, with no other write in between.
     * Keys land on the UI thread, the status check, the remotes and a pane
     * run each on their own IO thread; a writer that copied a state it read
     * earlier would put back whatever landed since — the remote row's
     * `Asking` over its answer (the row spun forever), a tick over a
     * refresh. [change] must stay a pure copy: the slow work goes before
     * the call, and it must not call [update] itself (the lock isn't
     * reentrant).
     */
    @OptIn(ExperimentalAtomicApi::class)
    private fun update(change: (HomeState) -> HomeState) {
        while (!writing.compareAndSet(false, true)) { /* another write is mid-copy */ }
        try {
            state = change(state)
        } finally {
            writing.store(false)
        }
    }
    private var running: RunningProcess? = null
    private var cancelled = false
    private var pending: List<PaneStep>? = null
    private var manifest: Manifest? = null
    private var system: SystemInfo? = null
    private var stored: MachineState? = null
    private var before: Map<String, String?> = emptyMap()

    /** Stored verdicts, on screen immediately. Call before runMosaic; may throw. */
    fun load() {
        val m = app.loadManifest()
        val sys = app.detectSystem()
        manifest = m
        system = sys
        val stored = app.stateStore.read(sys.machine)
        this.stored = stored
        before = stored?.programs?.mapValues { it.value.version }.orEmpty()
        val report = fleet()
        val scripts = scriptRowsOf(m, sys, stored)
        val missing = missingRowsOf(m, sys, stored)
        update {
            it.copy(
                machine = sys.machine,
                system = "${sys.os.id}${sys.distro?.let { "/$it" }.orEmpty()} · ${sys.arch}",
                sections = sectionsOf(m, sys, stored, report, null),
                fleet = report,
                missing = missing,
                chosen = missing.map { it.name }.toSet(),
                scripts = scripts,
                picked = preselect(scripts),
                stale = stored != null,
                message = app.stateStore.lastWarnings.firstOrNull(),
            )
        }
    }

    /**
     * Two questions, asked at once: the machine's own checks (~3s) and the
     * remotes (~4s). The remote query starts IMMEDIATELY against the stored
     * state rather than queueing behind the refresh — waiting seconds to
     * start asking is the thing this screen exists to avoid. Each lands in
     * the UI as it finishes.
     */
    fun refresh() {
        val m = manifest ?: return
        val sys = system ?: return
        if (state.loading) return
        // Recompute the rows too: "asking…" has to show the moment we start,
        // not when the first answer lands.
        val sections = sectionsOf(m, sys, stored, fleet(), RemoteStatus.Asking, checking = true)
        update { it.copy(loading = true, remote = RemoteStatus.Asking, sections = sections) }

        val known = stored
        if (known != null) scope.launch { askRemotes(m, sys, known) }

        scope.launch {
            val fresh = runCatching { app.refreshAndWriteState(m, sys) }
            val observed = fresh.getOrNull() ?: known
            stored = observed ?: stored
            val report = fleet()
            val scripts = scriptRowsOf(m, sys, observed)
            val missing = missingRowsOf(m, sys, observed)
            val toolsDown = app.lastToolsDown
            update {
                it.copy(
                    loading = false,
                    stale = fresh.isFailure,
                    fleet = report,
                    sections = sectionsOf(m, sys, observed, report, it.remote, toolsDown = toolsDown),
                    missing = missing,
                    chosen = missing.map { it.name }.toSet(),
                    scripts = scripts,
                    picked = preselect(scripts),
                    // A tool the checks go through wasn't there: one sentence,
                    // here, where a person reads — not only a count in a row.
                    message = fresh.exceptionOrNull()?.message?.lineSequence()?.firstOrNull()
                        ?: toolsDown.firstOrNull()?.let { down -> "${down.message} · r re-checks once it is fixed" },
                )
            }
            // A machine with no state file yet couldn't be asked about above.
            if (known == null && observed != null) askRemotes(m, sys, observed)
        }
    }

    private suspend fun askRemotes(m: Manifest, sys: SystemInfo, observed: MachineState) {
        // Cached self-check: this screen opens constantly and GitHub's
        // unauthenticated API is rate-limited. `outdated` asks fresh.
        val remote = runCatching { outdatedReport(app, m, sys, observed, freshSelfCheck = false) }
            .fold(
                onSuccess = { r ->
                    val mapping = m.machines[sys.machine]?.pm.orEmpty()
                    val used = UpgradeEngine.upgradableInstallers(m, sys.machine)
                    RemoteStatus.Answered(
                        updates = r.updates,
                        failedSources = r.errors.size,
                        tools = r.tools,
                        mechanismOf = r.updates.mapNotNull { row ->
                            // A custom source's row is its source's, whatever
                            // it is called — never the program of that name.
                            if (row.source in m.outdated.keys || row.source == "release") return@mapNotNull null
                            val key = mapping[row.name] ?: return@mapNotNull null
                            m.resolveInstall(row.name, key).upgradeWith?.let { row.name to it.installer }
                        }.toMap(),
                        // ONLY mechanisms this machine's mapping uses. Grouping
                        // every installer that shares a probe would reach the
                        // built-in `brew` from a repo that never maps it — and
                        // then upgrade the real Homebrew.
                        toolOf = used.keys.associateWith { m.installers[it]?.probe ?: it },
                        mechanismsOfTool = used.keys.groupBy { m.installers[it]?.probe ?: it },
                        sources = m.outdated.mapValues { (_, s) -> s.upgrade != null },
                    )
                },
                onFailure = { e ->
                    RemoteStatus.Unavailable(e.message?.lineSequence()?.firstOrNull() ?: "unreachable")
                },
            )
        val known = stored
        val report = fleet()
        val toolsDown = app.lastToolsDown
        update {
            it.copy(
                remote = remote,
                sections = sectionsOf(m, sys, known, report, remote, checking = it.loading, toolsDown = toolsDown),
            )
        }
    }

    private fun fleet() = manifest?.let { m ->
        val states = app.stateStore.readAll().values
        if (states.isEmpty()) null else DiffEngine.diff(m, states)
    }

    /**
     * [viewport] is how many detail lines the open section shows — the
     * scroll bound.
     */
    fun handleKey(key: HomeKey, viewport: Int = 8): Boolean {
        val s = state
        // The floating pane owns the keyboard while it's up.
        s.run?.let { run ->
            // Typing a password: printable keys never reach here (see
            // passwordKey); only enter/esc do, and esc backs out to the question.
            if (run.password != null) {
                when (key) {
                    HomeKey.ENTER -> submitPassword()
                    HomeKey.ESC -> updateRun { it.copy(password = null, passwordError = null) }
                    else -> {}
                }
                return false
            }
            when (key) {
                HomeKey.ESC, HomeKey.QUIT -> when {
                    run.confirming -> {
                        pending = null
                        update { it.copy(run = null) }
                    }
                    run.done -> update { closed(it, run) }
                    else -> cancelRun()
                }
                HomeKey.ENTER -> when {
                    run.confirming -> confirmRun()
                    run.done -> update { closed(it, run) }
                    else -> {}
                }
                // Scrolling back pins the window; coming back to 0 follows
                // the tail again, which is what a live run wants.
                HomeKey.UP -> scrollRun(1, viewport)
                HomeKey.DOWN -> scrollRun(-1, viewport)
                HomeKey.PAGE_UP -> scrollRun(viewport, viewport)
                HomeKey.PAGE_DOWN -> scrollRun(-viewport, viewport)
                HomeKey.THEME -> update { it.copy(dark = !it.dark) }
                else -> {}
            }
            return false
        }
        // Verbs that belong to the machine, not to a row: same key in either
        // mode. Each leaves the screen so the command owns the terminal.
        when (key) {
            HomeKey.SYNC -> return leaveFor(HomeAction.SYNC)
            HomeKey.UPGRADE -> return leaveFor(HomeAction.UPGRADE)
            HomeKey.CONVERGE -> return leaveFor(HomeAction.SETUP)
            else -> {}
        }
        // ONE cursor for the whole screen: subject rows and the lines of
        // every open detail are the same list, so no table can capture the
        // arrows — k off a table's first row lands on its subject row, and
        // then on the subject above it, with the table still open behind.
        val lines = homeLines(s)
        val at = snapCursor(lines, s.cursor)
        // Nothing on screen to focus yet: only the keys above answer.
        if (at < 0) return false
        val focus = lines[at]
        val index = focus.section
        val section = s.sections[index]
        val open = section.action in s.open
        // Which row of this subject's own detail the cursor is on; -1 means
        // the subject row itself.
        val row = (focus as? HomeLine.Detail)?.index ?: -1
        val inDetail = row >= 0
        val answered = s.remote as? RemoteStatus.Answered
        val onRemote = section.action == HomeAction.REVIEW_OUTDATED
        val onScripts = section.action == HomeAction.RUN_SCRIPTS
        val onPrograms = section.action == HomeAction.INSTALL_MISSING
        when (key) {
            HomeKey.UP -> moveCursor(-1, viewport)
            HomeKey.DOWN -> moveCursor(1, viewport)
            HomeKey.PAGE_UP -> moveCursor(-viewport, viewport)
            HomeKey.PAGE_DOWN -> moveCursor(viewport, viewport)
            // Over the rows rather than through them: the next thing that
            // heads a run of them — a subject row, or a group inside the
            // remote table. A page is a distance; this is a structure.
            HomeKey.PREV_HEADING -> moveToHeading(-1, viewport)
            HomeKey.NEXT_HEADING -> moveToHeading(1, viewport)
            // `l` only ever OPENS — it never dispatches, so the vim keys
            // can't start an install by accident. Inside the remote table it
            // unfolds a folded group.
            HomeKey.OPEN -> when {
                inDetail && onRemote && answered != null -> {
                    val group = remoteLines(answered, s.collapsed).getOrNull(row)?.group
                    if (group != null && group in s.collapsed) {
                        // Unfolding can put a gap back above the heading:
                        // follow it to its new place.
                        update {
                            val next = it.copy(collapsed = it.collapsed - group)
                            withCursor(next, headingLine(next, index, group), viewport)
                        }
                    }
                }
                // Already open, from its row or from inside it: l has
                // nothing left to do, and h is what closes it.
                inDetail || open -> {}
                section.busy -> say("still asking — the rows fill in as answers land")
                detailLines(s, section) > 0 -> {
                    // The table is what you opened, so the cursor goes into
                    // it — onto the row you last left it on, since closing a
                    // table to read another row shouldn't cost your place in
                    // it — and walks back out on k.
                    update {
                        val next = it.copy(open = it.open + section.action)
                        val stop = detailStop(next, index, it.lastRow[section.action] ?: 0)
                        withCursor(next, if (stop < 0) at else stop, viewport)
                    }
                }
                else -> say("nothing to open there")
            }
            // h inside the remote table folds the group under the cursor,
            // landing on its heading; a group already folded — or one with
            // nothing to fold, like a clean tool — closes the detail instead,
            // like h anywhere in the other pickers. esc never folds.
            HomeKey.CLOSE, HomeKey.ESC -> {
                val fold = if (key == HomeKey.CLOSE && inDetail && onRemote && answered != null) {
                    val group = remoteLines(answered, s.collapsed).getOrNull(row)?.group
                    // Asked of the GROUP, not the line: h on a row means fold
                    // the group it sits in, and that row is itself the proof.
                    group?.takeIf {
                        it !in s.collapsed && remoteLines(answered, s.collapsed).any { l -> l.group == it && !l.heading }
                    }
                } else {
                    null
                }
                when {
                    fold != null -> {
                        update {
                            val next = it.copy(collapsed = it.collapsed + fold)
                            withCursor(next, headingLine(next, index, fold), viewport)
                        }
                    }
                    // Only the detail the cursor is in closes; every other
                    // open one stays exactly as it was, and the cursor comes
                    // out onto the subject row it was under.
                    open -> {
                        update {
                            val next = it.copy(open = it.open - section.action)
                            val subject = homeLines(next).indexOfFirst { line -> line is HomeLine.Subject && line.section == index }
                            withCursor(next, subject, viewport)
                        }
                    }
                    // esc closes things; it never leaves the screen. The key
                    // you press to back out of a list must not also be the
                    // one that ends the session — on a tidy screen, or from
                    // a row with nothing under it, one esc too many would.
                    // q is the only way out.
                    key == HomeKey.ESC -> say(
                        if (s.open.isEmpty()) "nothing to close — q quits"
                        else "esc closes the list you're in — q quits",
                    )
                    else -> {}
                }
            }
            // space ticks the row under the cursor, whichever subject it
            // belongs to — one unit at a time.
            HomeKey.SELECT -> when {
                !inDetail -> say(if (open) "space ticks a row in the list below" else "press l to open it")
                onPrograms -> s.missing.getOrNull(row)?.let { program ->
                    update { it.copy(chosen = if (program.name in it.chosen) it.chosen - program.name else it.chosen + program.name) }
                }
                // The scripts picker ticks one script at a time — each is its
                // own unit, and ticking a done one is how you force it.
                onScripts -> s.scripts.getOrNull(row)?.let { script ->
                    update { it.copy(picked = if (script.name in it.picked) it.picked - script.name else it.picked + script.name) }
                }
                onRemote && answered != null -> {
                    // A tool line, or a program under it, ticks the TOOL:
                    // loadout only does whole upgrades, and the tool line
                    // says what that means. A source row ticks itself.
                    val line = remoteLines(answered, s.collapsed).getOrNull(row)
                    val tick = line?.key
                    update {
                        when {
                            line == null -> it
                            // A source heading ticks every item under it — or
                            // clears them all when they already are.
                            line is RemoteLine.Source && line.itemKeys.isNotEmpty() ->
                                if (it.selection.containsAll(line.itemKeys)) it.copy(selection = it.selection - line.itemKeys.toSet(), message = null)
                                else it.copy(selection = it.selection + line.itemKeys, message = null)
                            tick == null -> it.copy(message = line.refusal ?: "nothing to tick there")
                            tick in it.selection -> it.copy(selection = it.selection - tick, message = null)
                            else -> it.copy(selection = it.selection + tick, message = null)
                        }
                    }
                }
                else -> {}
            }
            // K opens the page the row's source pointed at — the GitHub
            // compare of the two shas, like Lazy's K — in the browser.
            HomeKey.OPEN_LINK -> {
                val link = if (inDetail && onRemote && answered != null) {
                    remoteLines(answered, s.collapsed).getOrNull(row)?.link
                } else {
                    null
                }
                if (link == null) {
                    say("no page to open for this row")
                } else {
                    say("opening $link")
                    openInBrowser(link)
                }
            }
            // a ticks everything, u unticks everything — two keys, so neither
            // has to guess what you meant from what's ticked. They belong to
            // the subject the cursor is in, from its row or from inside it.
            HomeKey.SELECT_ALL, HomeKey.SELECT_NONE -> {
                val all = key == HomeKey.SELECT_ALL
                when {
                    !open -> say(if (detailLines(s, section) > 0) "press l to open it" else "nothing to tick there")
                    onPrograms -> update { it.copy(chosen = if (all) it.missing.map { p -> p.name }.toSet() else emptySet()) }
                    onScripts -> update { it.copy(picked = if (all) it.scripts.map { r -> r.name }.toSet() else emptySet()) }
                    onRemote && answered != null -> {
                        val every = remoteLines(answered, s.collapsed).mapNotNull { it.key }.toSet()
                        update { it.copy(selection = if (all) every else emptySet()) }
                    }
                    else -> {}
                }
            }
            // enter ACTS on the subject the cursor is in — opening and
            // closing belong to l/h, so it is free to mean "do it". From the
            // subject row or from inside its list: the ticks are the same.
            HomeKey.ENTER -> when {
                // Never act on an answer that hasn't arrived: enter used to
                // fire the outdated command over the one still running.
                section.busy -> say("still asking — the rows fill in as answers land")
                open && onPrograms -> startInstalls(s.chosen)
                open && onScripts -> startScripts(s.picked)
                open && onRemote && answered != null -> {
                    val line = if (inDetail) remoteLines(answered, s.collapsed).getOrNull(row) else null
                    when {
                        // The sweep's cost, in full: every package the tool
                        // would move that loadout doesn't declare, one per line.
                        line is RemoteLine.Others -> update {
                            it.copy(
                                run = PaneRun(
                                    steps = emptyList(),
                                    kind = PaneKind.LIST,
                                    title = "${line.tool}: ${line.names.size} packages not in your loadout",
                                    log = line.names,
                                    done = true,
                                    summary = "these upgrade too when you upgrade ${line.tool} — enter closes",
                                ),
                            )
                        }
                        s.selection.isNotEmpty() -> startUpgrade(answered, s.selection)
                        else -> say("nothing selected — space selects one, a selects all")
                    }
                }
                open && section.action == HomeAction.SHOW_DIFF ->
                    say("this table is the comparison — there is nothing to run")
                // A closed row whose detail is already here is LOOKED at, and
                // looking is l's job.
                detailLines(s, section) > 0 -> say("press l to open it")
                // A remote row that couldn't be asked, a fleet in sync: there
                // is nothing to open, and leaving to print the same answer
                // from a command is what this screen replaced.
                onRemote -> say(
                    if (s.remote is RemoteStatus.Unavailable) "the remotes couldn't be asked — r tries again" else "everything up to date",
                )
                section.action == HomeAction.SHOW_DIFF ->
                    say("the fleet is in sync — nothing to compare")
                else -> say("nothing to do there")
            }
            HomeKey.REFRESH -> refresh()
            HomeKey.THEME -> update { it.copy(dark = !it.dark) }
            HomeKey.QUIT -> update { it.copy(exit = true) }
            // No else: the machine-wide verbs returned above, and a new key
            // should have to say what it does on a line.
            HomeKey.SYNC, HomeKey.UPGRADE, HomeKey.CONVERGE -> {}
        }
        return false
    }

    /**
     * Upgrade the chosen mechanisms HERE, streaming into the floating pane.
     * Only non-interactive commands can live in the pane — a password prompt
     * behind it would be invisible — so sudo's cache must already be warm.
     */
    fun startUpgrade(answered: RemoteStatus.Answered, selection: Set<String>) {
        val m = manifest ?: return
        val sys = system ?: return
        if (state.run != null) return
        val engine = UpgradeEngine

        // Tools sweep; source items go one at a time, in the order shown.
        val tools = selection.filter { it.startsWith("tool:") }.map { it.removePrefix("tool:") }
        val items = selection.filter { it.startsWith("item:") }
            .map { it.removePrefix("item:") }
            .groupBy({ it.substringBefore('/') }, { it.substringAfter('/') })
        val plan = runCatching {
            engine.plan(m, sys.machine, tools.flatMap { answered.mechanismsOfTool[it].orEmpty() }.sorted()) +
                items.flatMap { (source, rows) -> engine.planSourceItems(m, source, rows.sorted()) }
        }.getOrElse { e ->
            say(e.message?.lineSequence()?.firstOrNull())
            return
        }
        if (plan.isEmpty()) return
        ask(plan.map { PaneStep(it.label, it.command, sweep = it.sweep, sudo = it.sudo) }, PaneKind.UPGRADE)
    }

    /**
     * Install the ticked missing programs HERE, in the pane — `install
     * <names>` without leaving. InstallEngine plans it exactly as the
     * command would (dependencies first, refusals before anything runs).
     */
    fun startInstalls(chosen: Set<String>) {
        if (state.run != null) return
        val names = state.missing.filter { it.name in chosen }.map { it.name }
        if (names.isEmpty()) {
            say("nothing ticked — space ticks a program, a ticks them all")
            return
        }
        val m = manifest ?: return
        val sys = system ?: return
        val engine = InstallEngine(app.runner, VersionChecker(app.runner, app.repoRoot.toString()), app.repoRoot)
        val plan = runCatching {
            engine.plan(m, sys.machine, names, stored?.programs.orEmpty()) { app.detection.isBinaryAvailable(it) }
        }.getOrElse { e ->
            say(e.message?.lineSequence()?.firstOrNull())
            return
        }
        val installs = plan.filterIsInstance<PlanItem.Install>()
        if (installs.isEmpty()) {
            say("already installed — r re-checks")
            return
        }
        ask(installs.map { PaneStep(it.program, it.command, sudo = it.sudo) }, PaneKind.INSTALL)
    }

    /**
     * Run the ticked scripts HERE, in the pane — the scripts themselves,
     * forced: ticking one means you want it run. Their checks are re-asked
     * by the refresh afterwards, which is the one observer either way.
     */
    fun startScripts(picked: Set<String>) {
        if (state.run != null) return
        val steps = state.scripts.filter { it.name in picked }
        if (steps.isEmpty()) {
            say("nothing ticked — space ticks a script, a ticks them all")
            return
        }
        ask(steps.map { PaneStep(it.name, it.command, check = it.check, sudo = it.sudo) }, PaneKind.SCRIPTS)
    }

    /**
     * Ask before touching anything: these commands change the machine, and
     * the sweep ones change more than the rows you picked. A step that
     * needs sudo is noted (the check counts too: the refresh runs it the
     * same way; so does a declared `sudo = true`, for commands that call
     * sudo from inside where no text match can see it) — the yes will ask for the password if sudo's cache is
     * cold, because a child's own prompt behind the pane is invisible.
     * The pane is an overlay: whatever was open stays open underneath, so
     * closing it shows the screen exactly as it was left.
     */
    private fun ask(plan: List<PaneStep>, kind: PaneKind) {
        pending = plan
        val run = PaneRun(
                steps = plan.map { it.label },
                kind = kind,
                needsSudo = plan.any { it.sudo || commandNeedsSudo(it.command) || it.check?.let(::commandNeedsSudo) == true },
                label = plan.joinToString(", ") { it.label },
                confirming = true,
                commands = plan.map { "[${it.label}]  ${it.command}" },
                sweeps = plan.filter { it.sweep }.map { it.label },
            )
        update { it.copy(run = run) }
    }

    /**
     * The yes. Runs what [ask] showed, streaming into the pane — unless a
     * step needs sudo and its cache is cold: then the pane asks for the
     * password first, and [submitPassword] comes back here.
     */
    fun confirmRun() {
        val run = state.run ?: return
        if (run.needsSudo && run.password == null && !app.runner.capture("sudo -n true").success) {
            updateRun { it.copy(password = "", passwordError = null) }
            return
        }
        startRun()
    }

    /**
     * A key while the pane asks for a password: printable characters build
     * it, Backspace edits, enter/esc are the reducer's ([handleKey]). Nothing
     * typed here is ever logged or echoed — the field renders as dots.
     */
    fun passwordKey(key: String): Boolean {
        if (state.run?.password == null) return false
        when {
            key == "Backspace" -> updateRun { it.copy(password = it.password?.dropLast(1)) }
            key.length == 1 && !key[0].isISOControl() -> updateRun { it.copy(password = it.password?.plus(key)) }
            else -> return false
        }
        return true
    }

    /**
     * Hand the typed password to `sudo -S -v` on stdin (never argv, never
     * the environment) so sudo stamps its own credential cache; every
     * `sudo` step then runs without prompting, exactly as after `sudo -v`
     * in a shell. A wrong one stays on the field and says so.
     */
    private fun submitPassword() {
        val typed = state.run?.password ?: return
        val stamped = app.runner.capture("sudo -S -p '' -v", input = typed).success
        if (stamped) {
            updateRun { it.copy(password = null, passwordError = null) }
            startRun()
        } else {
            updateRun { it.copy(password = "", passwordError = "sorry, try again") }
        }
    }

    private fun startRun() {
        val m = manifest ?: return
        val sys = system ?: return
        val plan = pending ?: return
        pending = null
        cancelled = false
        val kind = state.run?.kind ?: PaneKind.UPGRADE
        val scripts = kind == PaneKind.SCRIPTS
        val needsSudo = state.run?.needsSudo == true
        updateRun { it.copy(confirming = false, label = plan.first().label) }
        // sudo's cache expires (5 min on Fedora); a plan whose third step
        // needs sudo after a ten-minute brew step would otherwise fail with
        // "a terminal is required". Keep the stamp fresh while we run.
        val keepalive = if (needsSudo) scope.launch {
            while (isActive) {
                delay(60_000)
                app.runner.capture("sudo -n -v")
            }
        } else null
        scope.launch {
          try {
            // Script runs are history the state file keeps (lastRun, exit
            // code); the refresh below decides each status from its check.
            val results = mutableMapOf<String, ScriptState>()
            for ((index, step) in plan.withIndex()) {
                if (cancelled) break
                // A rule before each step: five commands' output in one
                // scroll is otherwise one undifferentiated stream.
                val divider = "$RUN_DIVIDER${index + 1}/${plan.size}  ${step.label} "
                updateRun {
                    it.copy(
                        current = index,
                        label = step.label,
                        log = it.log + listOfNotNull("".takeIf { index > 0 }, divider, "$ ${step.command}"),
                    )
                }
                val exit = app.runner.stream(
                    step.command,
                    workDir = app.repoRoot.toString(),
                    onStart = { running = it },
                ) { line -> if (!cancelled) appendRun(displayLines(line)) }
                running = null
                if (cancelled) break
                appendRun(listOf("exit $exit"))
                if (scripts) {
                    results[step.label] = ScriptState(
                        status = if (exit == 0) ScriptStatus.DONE else ScriptStatus.FAILED,
                        lastRun = nowIso(),
                        exitCode = exit,
                    )
                }
                if (exit != 0) updateRun { it.copy(failed = true, failures = it.failures + step.label) }
            }
            if (cancelled) {
                updateRun { it.copy(done = true, cancelled = true, summary = "cancelled — state not refreshed") }
                return@launch
            }
            // The transaction moved what it moved, the scripts did what they
            // did: re-ask everything, the same observation `status` makes.
            updateRun {
                it.copy(
                    label = "checking",
                    log = it.log + "" + when (kind) {
                        PaneKind.SCRIPTS -> "Re-checking every script…"
                        PaneKind.INSTALL -> "Re-checking every program…"
                        else -> "Checking which installed versions changed…"
                    },
                )
            }
            val fresh = runCatching { app.refreshAndWriteState(m, sys, results) }
            stored = fresh.getOrNull() ?: stored
            val changed = fresh.getOrNull()?.let { after ->
                after.programs.count { (name, now) -> now.version != null && now.version != before[name] }
            } ?: 0
            before = stored?.programs?.mapValues { it.value.version }.orEmpty()
            // A run's verdict counts only the scripts it ran: the check has
            // the last word, so a script that exited 0 can still be pending.
            val stillNot = fresh.getOrNull()?.scripts.orEmpty()
                .filter { (name, now) -> name in results && now.status != ScriptStatus.DONE }.keys.sorted()
            // With what its check said, so the log explains itself.
            val stillNotWhy = stillNot.joinToString { name ->
                app.lastScriptDetail[name]?.lineSequence()?.firstOrNull()?.let { "$name ($it)" } ?: name
            }
            // An install's verdict is its check too: exit 0 with the program
            // still missing is not installed.
            val stillMissing = if (kind == PaneKind.INSTALL) {
                fresh.getOrNull()?.programs.orEmpty()
                    .filter { (name, now) -> name in plan.map { it.label } && now.status == ProgramStatus.MISSING }
                    .keys.sorted()
            } else {
                emptyList()
            }
            // Close the re-check in the log itself: a trailing "…" line reads
            // as still running, and the footer alone is easy to miss.
            val recheck = when {
                fresh.isFailure ->
                    "Could not re-check and write the state file: ${fresh.exceptionOrNull()?.message?.lineSequence()?.firstOrNull()}"
                scripts && stillNot.isEmpty() -> "Done. All ${results.size} script(s) pass their checks; state file updated."
                scripts -> "Done. Still not done: $stillNotWhy; state file updated."
                kind == PaneKind.INSTALL && stillMissing.isEmpty() -> "Done. All ${plan.size} program(s) installed; state file updated."
                kind == PaneKind.INSTALL -> "Done. Still missing: ${stillMissing.joinToString()}; state file updated."
                changed == 0 -> "Done. No program in your loadout changed version; state file updated."
                else -> "Done. $changed program(s) in your loadout now have a new version; state file updated."
            }
            val rows = scriptRowsOf(m, sys, stored)
            val missing = missingRowsOf(m, sys, stored)
            // Name what failed: "finished with failures" makes you scroll
            // back through everything to find out which.
            val failed = (state.run?.failures.orEmpty() + stillNot + stillMissing).distinct()
            val observed = stored
            val report = fleet()
            val toolsDown = app.lastToolsDown
            update {
                it.copy(
                    sections = sectionsOf(m, sys, observed, report, it.remote, toolsDown = toolsDown),
                    scripts = rows,
                    picked = preselect(rows),
                    missing = missing,
                    chosen = missing.map { it.name }.toSet(),
                    // The table underneath still lists what was just upgraded;
                    // ask again so it's true when the pane closes.
                    remote = if (kind == PaneKind.UPGRADE) RemoteStatus.Asking else it.remote,
                    run = it.run?.copy(
                        log = it.run.log + recheck,
                        done = true,
                        failed = fresh.isFailure || failed.isNotEmpty(),
                        summary = when {
                            fresh.isFailure -> "state not written — the run above is not recorded"
                            failed.isNotEmpty() -> "not done: ${failed.joinToString()} — scroll up for the output"
                            scripts -> "all ${results.size} done — enter closes"
                            kind == PaneKind.INSTALL -> "all ${plan.size} installed — enter closes"
                            else -> "$changed program(s) changed version — enter closes"
                        },
                    ),
                )
            }
            if (kind == PaneKind.UPGRADE) stored?.let { askRemotes(m, sys, it) }
          } finally {
            keepalive?.cancel()
          }
        }
    }

    /** A finished pane closes on the screen as it was, minus what it just ran. */
    /**
     * Hand [url] to the desktop (xdg-open, else open) off the UI thread and
     * say how it went: the opener's own last line when it fails — a Qt
     * "could not connect to display" was once a silent core dump behind
     * "opened …" — with the URL kept on screen to copy by hand.
     */
    private fun openInBrowser(url: String) {
        val quoted = "'" + url.replace("'", "'\\''") + "'"
        scope.launch {
            val result = app.runner.capture(
                "sh -c 'command -v xdg-open >/dev/null 2>&1 && exec xdg-open \"\$1\" || exec open \"\$1\"' sh $quoted </dev/null",
            )
            val said = (result.stderr + result.stdout).lineSequence().map { it.trim() }.lastOrNull { it.isNotEmpty() }
            say(
                if (result.success) "opened $url"
                else "could not open a browser (${said ?: "exit ${result.exitCode}"}) — $url",
            )
        }
    }

    private fun closed(s: HomeState, run: PaneRun) =
        s.copy(run = null, selection = if (run.kind == PaneKind.UPGRADE) emptySet() else s.selection)

    /** The line under the rows: what a key did, or why it did nothing. */
    private fun say(message: String?) = update { it.copy(message = message) }

    private fun updateRun(transform: (PaneRun) -> PaneRun) {
        update { it.copy(run = it.run?.let(transform)) }
    }

    private fun appendRun(lines: List<String>) {
        if (lines.isEmpty()) return
        updateRun { it.copy(log = (it.log + lines).takeLast(MAX_RUN_LINES)) }
    }

    private fun scrollRun(delta: Int, viewport: Int) {
        val run = state.run ?: return
        val lines = if (run.confirming) run.commands else run.log
        val max = (lines.size - viewport).coerceAtLeast(0)
        // A log is read from its tail (scrollBack counts up from the bottom);
        // a list from its top, so the same keys move the other way.
        val step = if (run.kind == PaneKind.LIST) -delta else delta
        updateRun { it.copy(scrollBack = (it.scrollBack + step).coerceIn(0, max)) }
    }

    private fun cancelRun() {
        cancelled = true
        running?.kill()
    }

    private fun leaveFor(action: HomeAction): Boolean {
        update { it.copy(action = action, exit = true) }
        return true
    }

    /**
     * Move the cursor by [delta] STOPS through the whole body — subject rows
     * and open detail lines alike, skipping gaps and column headings. It
     * stops at the first and last stop on the screen and nowhere in
     * between: an open table is walked through, not locked into.
     */
    private fun moveCursor(delta: Int, viewport: Int) {
        val s = state
        val lines = homeLines(s)
        val from = snapCursor(lines, s.cursor)
        if (from < 0) return
        val step = if (delta < 0) -1 else 1
        var target = from
        var left = if (delta < 0) -delta else delta
        var i = from + step
        while (i in lines.indices && left > 0) {
            if (lines[i].focusable) {
                target = i
                left--
            }
            i += step
        }
        update { withCursor(it, target, viewport) }
    }

    /**
     * Jump to the nearest heading in [step]'s direction — the next group in
     * the remote table, or the next subject row once its groups run out. A
     * table of 40 rows is three arrow keys' worth of paging otherwise, and
     * the thing you are looking for is the heading, not the row count.
     * Nothing to jump to leaves the cursor where it is, like the arrows do
     * at either end of the body.
     */
    private fun moveToHeading(step: Int, viewport: Int) {
        val s = state
        val lines = homeLines(s)
        val from = snapCursor(lines, s.cursor)
        if (from < 0) return
        var i = from + step
        while (i in lines.indices) {
            if (lines[i].heading && lines[i].focusable) {
                update { withCursor(it, i, viewport) }
                return
            }
            i += step
        }
    }

    /**
     * Put the cursor on [target], scroll the body just enough to show it,
     * and — when it lands inside a table — remember that line as the one
     * that subject is on, for the next time it opens.
     */
    private fun withCursor(s: HomeState, target: Int, viewport: Int): HomeState {
        val lines = homeLines(s)
        val at = snapCursor(lines, target)
        if (at < 0) return s.copy(cursor = 0, scroll = 0)
        val max = (lines.size - viewport).coerceAtLeast(0)
        val scroll = s.scroll.coerceIn((at - viewport + 1).coerceAtLeast(0), at).coerceAtMost(max)
        val line = lines[at]
        val lastRow = if (line is HomeLine.Detail) {
            s.sections.getOrNull(line.section)
                ?.let { s.lastRow + (it.action to line.index) }
                ?: s.lastRow
        } else {
            s.lastRow
        }
        return s.copy(cursor = at, scroll = scroll, lastRow = lastRow)
    }

    /**
     * The body line [section]'s cursor belongs on when its detail opens:
     * [row] — where it was left — or the first stop after it, or the last
     * one. The table can lose rows while it is closed (a re-check finds a
     * program installed, an upgrade clears a source), so the row you left
     * may not be there when you come back.
     */
    private fun detailStop(s: HomeState, section: Int, row: Int): Int {
        val stops = homeLines(s).withIndex()
            .filter { (_, line) -> line is HomeLine.Detail && line.section == section && line.focusable }
        val at = stops.firstOrNull { (_, line) -> (line as HomeLine.Detail).index >= row } ?: stops.lastOrNull()
        return at?.index ?: -1
    }

    /**
     * Where [group]'s heading sits in the body of [s] — the state AFTER the
     * fold or unfold. Folding can remove the gap above a heading and
     * unfolding can put it back, so everything below shifts and a cursor
     * left at the old index lands on the gap, highlighting nothing.
     */
    private fun headingLine(s: HomeState, section: Int, group: String): Int {
        val answered = s.remote as? RemoteStatus.Answered ?: return 0
        val heading = remoteLines(answered, s.collapsed).indexOfFirst { it.heading && it.group == group }
        return homeLines(s).indexOfFirst { it is HomeLine.Detail && it.section == section && it.index == heading }
    }
}

/** Log lines starting with this are step dividers; the pane rules them across. */
internal const val RUN_DIVIDER = "── "

/** Log lines the pane keeps; the viewer tails a long run. */
private const val MAX_RUN_LINES = 5_000

/** One command the pane runs, whatever planned it. */
private data class PaneStep(
    val label: String,
    val command: String,
    val check: String? = null,
    /** A package manager about to upgrade everything it manages. */
    val sweep: Boolean = false,
    /** Declared `sudo = true`: the command calls sudo from inside. */
    val sudo: Boolean = false,
)

private val SUDO = Regex("(^|[^-\\w])sudo\\b")

/** Whether [command] actually invokes sudo (not "pseudo-tty", not "sudoku"). */
internal fun commandNeedsSudo(command: String) = SUDO.containsMatchIn(command)

private val ANSI_ESCAPES = Regex("\u001b\\[[0-9;?]*[ -/]*[@-~]|\u001b\\][^\u0007\u001b]*(\u0007|\u001b\\\\)?|\u001b.")

/**
 * Display-safe lines from one raw chunk of process output. Real tools emit
 * carriage-return progress redraws (`10%\r50%\r100%`), ANSI colors, and tabs
 * — rendered verbatim they mash into one garbled line. Keep the final state
 * of a \r-run, strip escapes, expand tabs, split any embedded newlines.
 */
internal fun displayLines(raw: String): List<String> =
    raw.split('\n')
        .map { chunk ->
            val settled = chunk.split('\r').lastOrNull { it.isNotBlank() } ?: ""
            settled.replace(ANSI_ESCAPES, "").replace("\t", "    ")
        }
        .filter { it.isNotBlank() }

/**
 * Pure: the scripts row's picker — this machine's opted-in maintain-mode
 * scripts in run order, each with the verdict the last observation wrote
 * down (never observed = null, which is unproven, not done).
 */
internal fun scriptRowsOf(manifest: Manifest, system: SystemInfo, observed: MachineState?): List<ScriptRow> {
    val enabled = manifest.machines[system.machine]?.scriptArgs().orEmpty()
    val verdicts = observed?.scripts.orEmpty()
    return ManifestLoader.scriptOrder(manifest, enabled.keys)
        .filter { name ->
            name in enabled &&
                manifest.scripts.getValue(name).appliesTo(system.os) &&
                manifest.scripts.getValue(name).runsIn("maintain")
        }
        .map { name ->
            val step = manifest.scripts.getValue(name)
            val args = enabled.getValue(name)
            ScriptRow(
                name = name,
                command = ScriptRunner.commandFor(step, args),
                check = step.check?.let { ScriptRunner.withArgs(it, args) },
                sudo = step.sudo,
                status = verdicts[name]?.status,
            )
        }
}

/**
 * Pure: the programs row's picker — every mapped program the last
 * observation found missing, in manifest order, with the command its
 * mapped variant would run (dependencies are the engine's business when
 * the ticks are planned).
 */
internal fun missingRowsOf(manifest: Manifest, system: SystemInfo, observed: MachineState?): List<ProgramRow> {
    val mapping = manifest.machines[system.machine]?.pm.orEmpty()
    val programs = observed?.programs.orEmpty()
    return manifest.programs.keys
        .filter { name -> name in mapping && programs[name]?.status == ProgramStatus.MISSING }
        .map { name ->
            val key = mapping.getValue(name)
            ProgramRow(name, key, manifest.resolveInstall(name, key).command.orEmpty())
        }
}

/** Anything not known-done starts ticked: that IS the work. */
internal fun preselect(rows: List<ScriptRow>): Set<String> =
    rows.filter { it.status != ScriptStatus.DONE }.map { it.name }.toSet()

/**
 * One line of the remote table. The table is grouped by what will ACT: a
 * tool line (dnf, brew…) with everything it reported, its declared programs
 * under it, a note for what it would touch beyond them; then each custom
 * source with its items. [key] is what ticking selects (null = can't);
 * [focusable] lines are cursor stops.
 */
sealed interface RemoteLine {
    val key: String?
    val focusable: Boolean
    /** Why ticking does nothing, when it does nothing. */
    val refusal: String? get() = null
    /** The group this line belongs to — what h folds and l unfolds. */
    val group: String? get() = null
    /** A heading: the line that stays when its group is folded. */
    val heading: Boolean get() = false
    /**
     * Whether folding this heading would hide anything. A clean tool heads
     * no rows, so a chevron on it promises content that doesn't exist — and
     * folding is filtered by group, which can't tell "folded, nothing
     * hidden" from "folded, rows hidden" once the rows are gone.
     */
    val foldable: Boolean get() = false
    /** A page about this row's change, when its source printed one. */
    val link: String? get() = null

    data class Tool(
        val info: ToolUpdates,
        override val key: String?,
        override val foldable: Boolean = false,
    ) : RemoteLine {
        override val focusable get() = true
        override val refusal get() = if (key == null) "${info.tool} declares no upgrade command" else null
        override val group get() = "tool:${info.tool}"
        override val heading get() = true
    }
    data class Program(val row: UpdateRow, override val key: String?, override val group: String) : RemoteLine {
        override val focusable get() = true
        override val refusal get() = if (key == null) "${row.name} has no mechanism loadout can upgrade" else null
    }
    /** What the sweep touches that loadout doesn't declare — enter lists them all. */
    data class Others(val tool: String, val names: List<String>) : RemoteLine {
        override val key: String? get() = null
        override val focusable get() = true
        override val refusal get() = "nothing to tick — enter lists them"
        override val group get() = "tool:$tool"
    }
    /**
     * A custom source's heading. Its items tick one at a time, and the
     * heading ticks all of them at once ([itemKeys]; empty = read-only source).
     */
    data class Source(val name: String, val itemKeys: List<String>) : RemoteLine {
        override val key: String? get() = null
        override val focusable get() = true
        override val refusal get() = if (itemKeys.isEmpty()) "$name can't update its items from loadout" else null
        override val group get() = "source:$name"
        override val heading get() = true
        // A source exists only because it has rows.
        override val foldable get() = true
    }
    /** Breathing room between groups. */
    data object Gap : RemoteLine {
        override val key: String? get() = null
        override val focusable get() = false
    }
    data class Item(val row: UpdateRow, override val key: String?) : RemoteLine {
        override val focusable get() = true
        override val refusal get() = if (key == null) "${row.source} can't update its items from loadout" else null
        override val group get() = "source:${row.source}"
        override val link get() = row.link
    }
}

/**
 * Pure: the remote table as lines — tools first (every one asked, clean
 * ones too), then sources. A group in [collapsed] keeps only its heading.
 */
internal fun remoteLines(answered: RemoteStatus.Answered, collapsed: Set<String> = emptySet()): List<RemoteLine> {
    val lines = mutableListOf<RemoteLine>()
    val placed = mutableSetOf<UpdateRow>()
    // A tool no batch oracle described (per-package oracles only) still
    // heads its programs — it just can't say how many others it would move.
    val described = answered.tools.map { it.tool }.toSet()
    val undescribed = answered.updates
        .mapNotNull { row -> answered.toolOf[answered.mechanismOf[row.name]]?.takeIf { it !in described }?.let { it to row.name } }
        .groupBy({ it.first }, { it.second })
        .map { (tool, names) ->
            ToolUpdates(tool, answered.mechanismsOfTool[tool].orEmpty(), total = null, declared = names, others = emptyList(), command = "")
        }
    // A blank line between groups, except between two QUIET ones — up to
    // date, or folded: one-liners read better stacked.
    var previousQuiet = true
    fun gap(quiet: Boolean) {
        if (lines.isNotEmpty() && !(previousQuiet && quiet)) lines += RemoteLine.Gap
        previousQuiet = quiet
    }
    for (tool in answered.tools + undescribed) {
        gap(quiet = tool.total == 0 || "tool:${tool.tool}" in collapsed)
        val key = if (tool.command != null && tool.tool in answered.mechanismsOfTool) "tool:${tool.tool}" else null
        // Its rows, before its heading: the heading has to say whether it
        // heads anything. Sources keep their own rows — read-only included.
        val rows = answered.updates.filter { row ->
            row !in placed && row.source !in answered.sources && row.source != "release" &&
                (answered.toolOf[answered.mechanismOf[row.name]] == tool.tool || row.name in tool.declared)
        }
        lines += RemoteLine.Tool(tool, key, foldable = rows.isNotEmpty() || tool.others.isNotEmpty())
        for (row in rows) {
            lines += RemoteLine.Program(row, key, "tool:${tool.tool}")
            placed += row
        }
        if (tool.others.isNotEmpty()) lines += RemoteLine.Others(tool.tool, tool.others)
    }
    // Everything else, grouped by source: the binary's own row, custom
    // sources, and programs whose mechanism no tool line claimed.
    val rest = answered.updates.filter { it !in placed }
    for ((source, rows) in rest.groupBy { it.source }) {
        gap(quiet = "source:$source" in collapsed)
        val keys = rows.mapNotNull { selectionKey(answered, it) }
        lines += RemoteLine.Source(source, keys)
        for (row in rows) lines += RemoteLine.Item(row, selectionKey(answered, row))
    }
    return lines.filter { it.heading || it.group == null || it.group !in collapsed }
}

/**
 * What ticking [row] selects. A package row selects the TOOL behind it (dnf,
 * brew — the sweep upgrades all of it); a custom source's row selects just
 * that row, because its items are independent. Null = loadout can't upgrade
 * it at all.
 */
internal fun selectionKey(answered: RemoteStatus.Answered, row: UpdateRow): String? {
    if (row.source == "release") return null
    // A source's row ticks itself or nothing at all. It never falls through
    // to a tool: sharing a name with a mapped program would otherwise tick
    // that program's sweep, which cannot move what the source tracks.
    if (row.source in answered.sources) {
        return if (row.source in answered.upgradableSources) "item:${row.source}/${row.name}" else null
    }
    val tool = answered.toolOf[answered.mechanismOf[row.name]] ?: return null
    return "tool:$tool"
}

/**
 * One line of the body, as both the cursor and the renderer see it. There is
 * ONE cursor for the whole screen and it walks this list, so a table can
 * never capture it: k off a table's first row lands on the subject row above
 * it and keeps going, with the table still open behind.
 */
sealed interface HomeLine {
    /** The subject this line belongs to — an index into [HomeState.sections]. */
    val section: Int
    /** A cursor stop. The remote table's gaps and a table's own column heading are not. */
    val focusable: Boolean
    /** Heads a run of rows — what `[`/`]` jump between: a subject row, or a remote group's heading. */
    val heading: Boolean

    data class Subject(override val section: Int) : HomeLine {
        override val focusable get() = true
        override val heading get() = true
    }

    /** Row [index] of that subject's open detail: a remote line, a script, a program, a drifted row. */
    data class Detail(
        override val section: Int,
        val index: Int,
        override val focusable: Boolean = true,
        override val heading: Boolean = false,
    ) : HomeLine

    /** A table's own column heading (the fleet's machine names) — part of the table, never a stop. */
    data class Header(override val section: Int) : HomeLine {
        override val focusable get() = false
        override val heading get() = false
    }
}

/** Pure: the body, subject rows and every open detail, in the order it's drawn. */
internal fun homeLines(state: HomeState): List<HomeLine> {
    val lines = mutableListOf<HomeLine>()
    for ((index, section) in state.sections.withIndex()) {
        lines += HomeLine.Subject(index)
        if (section.action !in state.open) continue
        when (section.action) {
            HomeAction.REVIEW_OUTDATED -> {
                val answered = state.remote as? RemoteStatus.Answered
                answered?.let { remote ->
                    remoteLines(remote, state.collapsed).forEachIndexed { row, line ->
                        lines += HomeLine.Detail(index, row, focusable = line.focusable, heading = line.heading)
                    }
                }
            }
            HomeAction.RUN_SCRIPTS -> state.scripts.indices.forEach { lines += HomeLine.Detail(index, it) }
            HomeAction.INSTALL_MISSING -> state.missing.indices.forEach { lines += HomeLine.Detail(index, it) }
            HomeAction.SHOW_DIFF -> driftedRows(state).indices.let { rows ->
                if (rows.isEmpty()) return@let
                lines += HomeLine.Header(index)
                rows.forEach { lines += HomeLine.Detail(index, it) }
            }
            else -> {}
        }
    }
    return lines
}

/**
 * The line the cursor really sits on: the nearest stop at or above [cursor].
 * The body reshapes under it constantly — a refresh empties the programs
 * picker, a source's rows are upgraded away — and a cursor left on a line
 * that no longer exists would highlight nothing. Above first: an emptied
 * table drops you on its own subject row, not on the next one down.
 */
internal fun snapCursor(lines: List<HomeLine>, cursor: Int): Int {
    if (lines.isEmpty()) return -1
    val at = cursor.coerceIn(0, lines.lastIndex)
    for (i in at downTo 0) if (lines[i].focusable) return i
    for (i in at..lines.lastIndex) if (lines[i].focusable) return i
    return -1
}

/** The drifting half of the fleet comparison — the only part the table shows. */
internal fun driftedRows(state: HomeState) =
    state.fleet?.rows?.filter { it.drift || it.incomplete }.orEmpty()

/** How many detail lines this section can open in place (0 = none). */
internal fun detailLines(state: HomeState, section: HomeSection?): Int = when (section?.action) {
    HomeAction.INSTALL_MISSING -> state.missing.size
    HomeAction.RUN_SCRIPTS -> state.scripts.size
    HomeAction.REVIEW_OUTDATED -> (state.remote as? RemoteStatus.Answered)?.let { remoteLines(it, state.collapsed).size } ?: 0
    HomeAction.SHOW_DIFF -> driftedRows(state).size
    else -> 0
}

/** All a subject line gets for its answer, so the summary can fit itself. */
internal const val SUMMARY_WIDTH = 41

private const val SEP = " · "

/**
 * The remote row's one line, ordered by what the reader can do about it: a
 * tool is ONE command for every package it has, so it leads; everything
 * else takes an update each, counted and then named biggest-group-first
 * while the width lasts.
 *
 * A tool with nothing outdated is left OUT — naming it spent the line
 * saying there was no work ("brew 0 · 42 pins"), while the 42 that did have
 * work stayed anonymous. Counts of different kinds of work never merge into
 * one total either: "brew 3" is one keystroke, "42 more" is forty-two.
 */
internal fun remoteSummary(remote: RemoteStatus.Answered): String {
    // A null total is "no batch oracle can say", which is not the same as
    // idle — keep asking with a "?" rather than claiming it's clean.
    val tools = remote.tools
        .filter { it.total == null || it.total > 0 }
        .map { "${it.tool} ${it.total ?: "?"}" }
    val singles = remote.updates.filter {
        it.source in remote.sources || it.source == "release" || remote.mechanismOf[it.name] == null
    }
    val counted = when {
        singles.isEmpty() -> null
        // "more" only reads right after a count it adds to.
        tools.isNotEmpty() -> "${singles.size} more"
        singles.size == 1 -> "1 update"
        else -> "${singles.size} updates"
    }
    // A crashed source outranks the group names: it's the one thing on this
    // line that means the rest of the line may be understating the work.
    val failed = when (remote.failedSources) {
        0 -> null
        1 -> "1 source failed"
        else -> "${remote.failedSources} sources failed"
    }
    val head = tools + listOfNotNull(counted, failed)
    if (head.isEmpty()) return "everything up to date"

    val groups = singles.groupingBy { groupLabel(it) }.eachCount().entries
        .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
        .map { "${it.key} ${it.value}" }
    var line = head.joinToString(SEP)
    var shown = 0
    for (group in groups) {
        val candidate = line + SEP + group
        if (candidate.length > SUMMARY_WIDTH) break
        line = candidate
        shown++
    }
    // The marker counts the groups left, which the total can't say — but it
    // never costs a named group, since the total already implies "and more".
    if (shown in 1 until groups.size) {
        val marker = "$SEP+${groups.size - shown} more"
        if (line.length + marker.length <= SUMMARY_WIDTH) line += marker
    }
    return line
}

/** Where a row came from, as the reader knows it — not as the code keys it. */
private fun groupLabel(row: UpdateRow) = if (row.source == "release") "loadout" else row.source

/** Pure: the four subject lines for a machine's observed state. */
internal fun sectionsOf(
    manifest: Manifest,
    system: SystemInfo,
    observed: MachineState?,
    fleet: loadout.core.diff.DiffReport?,
    remote: RemoteStatus?,
    checking: Boolean = false,
    toolsDown: List<ToolDown> = emptyList(),
): List<HomeSection> {
    val programs = observed?.programs.orEmpty()
    val missing = programs.filterValues { it.status == ProgramStatus.MISSING }.keys.sorted()
    val installed = programs.count { it.value.status == ProgramStatus.INSTALLED }
    // Checks that couldn't run (their tool wasn't there): neither installed
    // nor missing, and nothing to install — the machine has to be fixed first.
    val unchecked = programs.filterValues { it.status == ProgramStatus.UNKNOWN && it.reason != null }
    val scripts = observed?.scripts.orEmpty()
    val unfinished = scripts.filterValues { it.status != ScriptStatus.DONE }.keys.sorted()
    val done = scripts.count { it.value.status == ScriptStatus.DONE }
    // The picker lists maintain-mode scripts; a machine with none has
    // nothing to open, whatever setup-only scripts are pending (C for those).
    val pickable = scriptRowsOf(manifest, system, observed).isNotEmpty()
    val mapped = manifest.machines[system.machine]?.pm?.size ?: 0
    val drifted = fleet?.rows?.count { it.drift || it.incomplete } ?: 0

    return listOf(
        HomeSection(
            subject = "programs",
            // While the checks run the row is only the spinner, like the
            // remote row: a stale count next to it reads as the answer.
            summary = when {
                checking -> ""
                observed == null -> "$mapped mapped — not observed yet"
                unchecked.isEmpty() -> "$installed installed · ${missing.size} missing"
                else -> "$installed installed · ${missing.size} missing · ${unchecked.size} not checked"
            },
            verb = when {
                checking -> ""
                missing.isNotEmpty() -> "install what's missing"
                // Say what's wrong, not "nothing missing": the checks that
                // failed never answered. In loadout's words when the refresh
                // asked the tool itself; the shell's line otherwise (a stored
                // state has no tools-down list).
                unchecked.isNotEmpty() ->
                    toolsDown.firstOrNull()?.let { if (it.onPath) "${it.tool} checks fail" else "${it.tool} is not on PATH" }
                        ?: unchecked.values.first().reason!!
                else -> "nothing missing"
            },
            action = if (missing.isEmpty()) HomeAction.NONE else HomeAction.INSTALL_MISSING,
            severity = when {
                missing.isNotEmpty() -> true
                unchecked.isNotEmpty() -> false
                else -> null
            },
            neutral = checking,
            busy = checking,
        ),
        HomeSection(
            subject = "scripts",
            summary = when {
                checking -> ""
                observed == null -> "not observed yet"
                else -> "$done done · ${unfinished.size} pending"
            },
            verb = if (checking) "" else if (unfinished.isEmpty()) "nothing pending" else "run what's pending",
            action = if (pickable) HomeAction.RUN_SCRIPTS else HomeAction.NONE,
            severity = if (unfinished.isEmpty()) null else false,
            neutral = checking,
            busy = checking,
        ),
        HomeSection(
            subject = "remote",
            summary = when (remote) {
                null -> "not asked yet"
                // Empty on purpose: the row shows the spinner instead.
                RemoteStatus.Asking -> ""
                is RemoteStatus.Unavailable -> "unavailable — ${remote.reason}"
                is RemoteStatus.Answered -> remoteSummary(remote)
            },
            verb = if (remote is RemoteStatus.Asking) "" else "review them",
            action = HomeAction.REVIEW_OUTDATED,
            severity = when {
                remote is RemoteStatus.Answered && remote.failedSources > 0 -> true
                remote is RemoteStatus.Answered && (remote.names.isNotEmpty() || remote.tools.any { (it.total ?: 0) > 0 }) -> false
                else -> null
            },
            neutral = remote == null || remote is RemoteStatus.Asking || remote is RemoteStatus.Unavailable,
            busy = remote is RemoteStatus.Asking,
        ),
        HomeSection(
            subject = "fleet",
            summary = when {
                fleet == null -> "no state files yet"
                drifted == 0 -> "${fleet.machines.size} machine(s) in sync"
                else -> "$drifted program(s) drifted across ${fleet.machines.size} machines"
            },
            verb = if (fleet == null) "nothing to compare" else "compare the fleet",
            action = if (fleet == null) HomeAction.NONE else HomeAction.SHOW_DIFF,
            severity = if (drifted == 0) null else false,
        ),
    )
}
