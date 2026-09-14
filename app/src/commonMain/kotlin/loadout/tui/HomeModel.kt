package loadout.tui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import loadout.cli.AppContext
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
import loadout.core.engine.ScriptRunner
import loadout.core.engine.UpgradeEngine
import loadout.core.engine.VersionChecker
import loadout.core.exec.RunningProcess
import loadout.core.platform.blockingDispatcher
import loadout.core.platform.envVar
import loadout.core.platform.nowIso
import loadout.core.platform.terminalBackgroundLuma
import loadout.theme.detectDarkTerminal
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** A run in the floating pane — first as a question, then as it happens. */
data class PaneRun(
    val steps: List<String>,
    /** Scripts from the scripts row, not an upgrade: the words and the ending differ. */
    val scripts: Boolean = false,
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
    UP, DOWN, PAGE_UP, PAGE_DOWN, ENTER, OPEN, CLOSE, ESC,
    SELECT, SELECT_ALL, UPGRADE_SELECTION,
    REFRESH, SYNC, UPGRADE, CONVERGE, THEME, QUIT,
}

/** One of this machine's maintenance scripts, as the scripts row lists it. */
data class ScriptRow(
    val name: String,
    /** The script itself, machine args applied — what the pane runs. */
    val command: String,
    /** Its check with args applied, when it has one (sudo guard only: the refresh re-asks it). */
    val check: String? = null,
    /** The last observed verdict; null = never observed here. */
    val status: ScriptStatus? = null,
)

/** What the remotes have said so far — they're asked on open, not on demand. */
sealed interface RemoteStatus {
    data object Asking : RemoteStatus
    data class Answered(
        val updates: List<UpdateRow>,
        val failedSources: Int,
        /**
         * Row name to the mechanism that can upgrade it. Upgrades are whole-
         * mechanism, so picking a row means picking its installer.
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
         * Custom sources that can update one of their items. Rows from these
         * tick individually — a pin in a file has nothing in common with the
         * next pin. Kept as a SET of sources, not a row-name map: the same
         * name can appear in two sources (python is an asdf tool and an asdf
         * plugin), and a name-keyed map made them one row.
         */
        val upgradableSources: Set<String> = emptySet(),
    ) : RemoteStatus {
        val names: List<String> get() = updates.map { it.name }
    }
    data class Unavailable(val reason: String) : RemoteStatus
}

/** What the user chose. The screen decides; the matching command does it. */
enum class HomeAction {
    NONE,

    // Row verbs: what the focused subject needs. RUN_SCRIPTS never leaves
    // the screen — its detail is the picker and the pane runs the picks.
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
    val offenders: List<String> = emptyList(),
)

data class HomeState(
    val machine: String = "",
    val system: String = "",
    val sections: List<HomeSection> = emptyList(),
    val cursor: Int = 0,
    val loading: Boolean = false,
    /** The verdicts are the last `status`'s, not this moment's. */
    val stale: Boolean = false,
    val remote: RemoteStatus? = null,
    /** The fleet comparison, kept so the fleet row can open it in place. */
    val fleet: loadout.core.diff.DiffReport? = null,
    /** The focused section's detail is open in place (the remote table). */
    val expanded: Boolean = false,
    /** First visible line of the open detail. */
    val scroll: Int = 0,
    /** Focused line inside the open detail. */
    val detailCursor: Int = 0,
    /** Rows ticked for upgrading, by program name. */
    val selection: Set<String> = emptySet(),
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
        HomeState(dark = detectDarkTerminal(terminalBackgroundLuma(), envVar("COLORFGBG"))),
    )
        private set

    internal fun setStateForTest(s: HomeState) {
        state = s
    }

    private val scope = CoroutineScope(SupervisorJob() + blockingDispatcher)
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
        state = state.copy(
            machine = sys.machine,
            system = "${sys.os.id}${sys.distro?.let { "/$it" }.orEmpty()} · ${sys.arch}",
            sections = sectionsOf(m, sys, stored, report, null),
            fleet = report,
            scripts = scripts,
            picked = preselect(scripts),
            stale = stored != null,
            message = app.stateStore.lastWarnings.firstOrNull(),
        )
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
        state = state.copy(
            loading = true,
            remote = RemoteStatus.Asking,
            sections = sectionsOf(m, sys, stored, fleet(), RemoteStatus.Asking, checking = true),
        )

        val known = stored
        if (known != null) scope.launch { askRemotes(m, sys, known) }

        scope.launch {
            val fresh = runCatching { app.refreshAndWriteState(m, sys) }
            val observed = fresh.getOrNull() ?: known
            stored = observed ?: stored
            val report = fleet()
            val scripts = scriptRowsOf(m, sys, observed)
            state = state.copy(
                loading = false,
                stale = fresh.isFailure,
                fleet = report,
                sections = sectionsOf(m, sys, observed, report, state.remote),
                scripts = scripts,
                picked = preselect(scripts),
                message = fresh.exceptionOrNull()?.message?.lineSequence()?.firstOrNull(),
            )
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
                    val used = UpgradeEngine(app.runner, VersionChecker(app.runner, app.repoRoot.toString()), app.repoRoot)
                        .upgradableInstallers(m, sys.machine)
                    RemoteStatus.Answered(
                        updates = r.updates,
                        failedSources = r.errors.size,
                        mechanismOf = r.updates.mapNotNull { row ->
                            val key = mapping[row.name] ?: return@mapNotNull null
                            m.resolveInstall(row.name, key).upgradeWith?.let { row.name to it.installer }
                        }.toMap(),
                        // ONLY mechanisms this machine's mapping uses. Grouping
                        // every installer that shares a probe would reach the
                        // built-in `brew` from a repo that never maps it — and
                        // then upgrade the real Homebrew.
                        toolOf = used.keys.associateWith { m.installers[it]?.probe ?: it },
                        mechanismsOfTool = used.keys.groupBy { m.installers[it]?.probe ?: it },
                        upgradableSources = m.outdated.filterValues { it.upgrade != null }.keys,
                    )
                },
                onFailure = { e ->
                    RemoteStatus.Unavailable(e.message?.lineSequence()?.firstOrNull() ?: "unreachable")
                },
            )
        state = state.copy(
            remote = remote,
            sections = sectionsOf(m, sys, stored, fleet(), remote, checking = state.loading),
        )
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
            when (key) {
                HomeKey.ESC, HomeKey.QUIT -> when {
                    run.confirming -> {
                        pending = null
                        state = s.copy(run = null)
                    }
                    run.done -> state = closed(s, run)
                    else -> cancelRun()
                }
                HomeKey.ENTER -> when {
                    run.confirming -> confirmRun()
                    run.done -> state = closed(s, run)
                    else -> {}
                }
                // Scrolling back pins the window; coming back to 0 follows
                // the tail again, which is what a live run wants.
                HomeKey.UP -> scrollRun(1, viewport)
                HomeKey.DOWN -> scrollRun(-1, viewport)
                HomeKey.PAGE_UP -> scrollRun(viewport, viewport)
                HomeKey.PAGE_DOWN -> scrollRun(-viewport, viewport)
                HomeKey.THEME -> state = s.copy(dark = !s.dark)
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
        // With a detail open the arrows belong to it, not to the section list.
        if (s.expanded) {
            val answered = s.remote as? RemoteStatus.Answered
            val onRemote = s.sections.getOrNull(s.cursor)?.action == HomeAction.REVIEW_OUTDATED
            val onScripts = s.sections.getOrNull(s.cursor)?.action == HomeAction.RUN_SCRIPTS
            when (key) {
                HomeKey.UP -> moveDetail(-1, viewport)
                HomeKey.DOWN -> moveDetail(1, viewport)
                HomeKey.PAGE_UP -> moveDetail(-viewport, viewport)
                HomeKey.PAGE_DOWN -> moveDetail(viewport, viewport)
                HomeKey.ESC, HomeKey.CLOSE ->
                    state = s.copy(expanded = false, scroll = 0, detailCursor = 0)
                HomeKey.OPEN -> {} // already open
                // The scripts picker ticks one script at a time — each is its
                // own unit, and ticking a done one is how you force it.
                HomeKey.SELECT -> if (onScripts) {
                    s.scripts.getOrNull(s.detailCursor)?.let { row ->
                        state = s.copy(picked = if (row.name in s.picked) s.picked - row.name else s.picked + row.name)
                    }
                } else if (onRemote && answered != null) {
                    // Selecting a package selects its MECHANISM: loadout only
                    // does whole upgrades, so anything else would be a lie
                    // about what pressing u will run.
                    val row = answered.updates.getOrNull(s.detailCursor)
                    // A package row ticks its whole tool; a source row ticks
                    // itself, because that's the unit each one upgrades in.
                    val key = row?.let { selectionKey(answered, it) }
                    state = when {
                        row == null -> s
                        key == null -> s.copy(message = "${row.name} has no mechanism loadout can upgrade")
                        key in s.selection -> s.copy(selection = s.selection - key, message = null)
                        else -> s.copy(selection = s.selection + key, message = null)
                    }
                }
                HomeKey.SELECT_ALL -> if (onScripts) {
                    val every = s.scripts.map { it.name }.toSet()
                    state = s.copy(picked = if (s.picked.containsAll(every)) emptySet() else every)
                } else if (onRemote && answered != null) {
                    val every = answered.updates.mapNotNull { selectionKey(answered, it) }.toSet()
                    state = s.copy(selection = if (s.selection.containsAll(every)) emptySet() else every)
                }
                // enter IS the upgrade here — opening and closing belong to
                // l/h, so enter is free to mean "do it".
                HomeKey.ENTER, HomeKey.UPGRADE_SELECTION -> if (onScripts) {
                    if (key == HomeKey.ENTER) startScripts(s.picked)
                } else if (onRemote && answered != null && s.selection.isNotEmpty()) {
                    startUpgrade(answered, s.selection)
                }
                HomeKey.THEME -> state = s.copy(dark = !s.dark)
                HomeKey.REFRESH -> refresh()
                HomeKey.QUIT -> state = s.copy(exit = true)
                else -> {}
            }
            return false
        }
        when (key) {
            HomeKey.UP -> state = s.copy(cursor = (s.cursor - 1).coerceAtLeast(0))
            HomeKey.DOWN ->
                state = s.copy(cursor = (s.cursor + 1).coerceAtMost(s.sections.lastIndex.coerceAtLeast(0)))
            // `l` only ever opens a detail; enter also acts when there is none.
            HomeKey.OPEN -> {
                val section = s.sections.getOrNull(s.cursor)
                state = when {
                    section?.busy == true -> s.copy(message = "still asking — the rows fill in as answers land")
                    detailLines(s, section) > 0 -> s.copy(expanded = true, scroll = 0, detailCursor = 0)
                    else -> s.copy(message = "nothing to open there")
                }
            }
            HomeKey.CLOSE -> {} // nothing open
            HomeKey.ENTER -> {
                val section = s.sections.getOrNull(s.cursor) ?: return false
                when {
                    // Never act on an answer that hasn't arrived: enter used
                    // to fire the outdated command over the one still running.
                    section.busy ->
                        state = s.copy(message = "still asking — the rows fill in as answers land")
                    // Rows whose detail is already here are LOOKED at, and
                    // looking is l's job.
                    detailLines(s, section) > 0 ->
                        state = s.copy(message = "press l to open it")
                    section.action == HomeAction.NONE ->
                        state = s.copy(message = "nothing to do there")
                    else -> {
                        // The screen closes so the action owns the terminal —
                        // sudo prompts and full-screen runners both need that.
                        state = s.copy(action = section.action, exit = true)
                        return true
                    }
                }
            }
            HomeKey.REFRESH -> refresh()
            HomeKey.THEME -> state = s.copy(dark = !s.dark)
            HomeKey.QUIT, HomeKey.ESC -> state = s.copy(exit = true)
            else -> {}
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
        val engine = UpgradeEngine(app.runner, VersionChecker(app.runner, app.repoRoot.toString()), app.repoRoot)

        // Tools sweep; source items go one at a time, in the order shown.
        val tools = selection.filter { it.startsWith("tool:") }.map { it.removePrefix("tool:") }
        val items = selection.filter { it.startsWith("item:") }
            .map { it.removePrefix("item:") }
            .groupBy({ it.substringBefore('/') }, { it.substringAfter('/') })
        val plan = runCatching {
            engine.plan(m, sys.machine, tools.flatMap { answered.mechanismsOfTool[it].orEmpty() }.sorted()) +
                items.flatMap { (source, rows) -> engine.planSourceItems(m, source, rows.sorted()) }
        }.getOrElse { e ->
            state = state.copy(message = e.message?.lineSequence()?.firstOrNull())
            return
        }
        if (plan.isEmpty()) return
        ask(plan.map { PaneStep(it.label, it.command, sweep = it.sweep) }, scripts = false)
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
            state = state.copy(message = "nothing ticked — space ticks a script, a ticks them all")
            return
        }
        ask(steps.map { PaneStep(it.name, it.command, check = it.check) }, scripts = true)
    }

    /**
     * Ask before touching anything: these commands change the machine, and
     * the sweep ones change more than the rows you picked. Only non-
     * interactive commands can live in the pane — a password prompt behind it
     * would be invisible — so sudo's cache must already be warm (the check
     * counts too: the refresh runs it the same way).
     * The pane is an overlay: whatever was open stays open underneath, so
     * closing it shows the screen exactly as it was left.
     */
    private fun ask(plan: List<PaneStep>, scripts: Boolean) {
        val needsSudo = plan.any { commandNeedsSudo(it.command) || it.check?.let(::commandNeedsSudo) == true }
        if (needsSudo && !app.runner.capture("sudo -n true").success) {
            state = state.copy(message = "sudo needs a password — run `sudo -v` in a terminal, then press enter again")
            return
        }
        pending = plan
        state = state.copy(
            run = PaneRun(
                steps = plan.map { it.label },
                scripts = scripts,
                label = plan.joinToString(", ") { it.label },
                confirming = true,
                commands = plan.map { "[${it.label}]  ${it.command}" },
                sweeps = plan.filter { it.sweep }.map { it.label },
            ),
        )
    }

    /** The yes. Runs what [ask] showed, streaming into the pane. */
    fun confirmRun() {
        val m = manifest ?: return
        val sys = system ?: return
        val plan = pending ?: return
        pending = null
        cancelled = false
        val scripts = state.run?.scripts == true
        state = state.copy(run = state.run?.copy(confirming = false, label = plan.first().label))
        scope.launch {
            // Script runs are history the state file keeps (lastRun, exit
            // code); the refresh below decides each status from its check.
            val results = mutableMapOf<String, ScriptState>()
            for ((index, step) in plan.withIndex()) {
                if (cancelled) break
                // A rule before each step: five commands' output in one
                // scroll is otherwise one undifferentiated stream.
                val divider = "$RUN_DIVIDER${index + 1}/${plan.size}  ${step.label} "
                update {
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
                if (exit != 0) update { it.copy(failed = true, failures = it.failures + step.label) }
            }
            if (cancelled) {
                update { it.copy(done = true, cancelled = true, summary = "cancelled — state not refreshed") }
                return@launch
            }
            // The transaction moved what it moved, the scripts did what they
            // did: re-ask everything, the same observation `status` makes.
            update {
                it.copy(
                    label = "checking",
                    log = it.log + "" + if (scripts) "Re-checking every script…" else "Checking which installed versions changed…",
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
            // Close the re-check in the log itself: a trailing "…" line reads
            // as still running, and the footer alone is easy to miss.
            val recheck = when {
                fresh.isFailure ->
                    "Could not re-check and write the state file: ${fresh.exceptionOrNull()?.message?.lineSequence()?.firstOrNull()}"
                scripts && stillNot.isEmpty() -> "Done. All ${results.size} script(s) pass their checks; state file updated."
                scripts -> "Done. Still not done: $stillNotWhy; state file updated."
                changed == 0 -> "Done. No program in your loadout changed version; state file updated."
                else -> "Done. $changed program(s) in your loadout now have a new version; state file updated."
            }
            val rows = scriptRowsOf(m, sys, stored)
            // Name what failed: "finished with failures" makes you scroll
            // back through everything to find out which.
            val failed = (state.run?.failures.orEmpty() + stillNot).distinct()
            state = state.copy(
                sections = sectionsOf(m, sys, stored, fleet(), state.remote),
                scripts = rows,
                picked = preselect(rows),
                // The table underneath still lists what was just upgraded;
                // ask again so it's true when the pane closes.
                remote = if (scripts) state.remote else RemoteStatus.Asking,
                run = state.run?.copy(
                    log = state.run?.log.orEmpty() + recheck,
                    done = true,
                    failed = fresh.isFailure || failed.isNotEmpty(),
                    summary = when {
                        fresh.isFailure -> "state not written — the run above is not recorded"
                        failed.isNotEmpty() -> "not done: ${failed.joinToString()} — scroll up for the output"
                        scripts -> "all ${results.size} done — enter closes"
                        else -> "$changed program(s) changed version — enter closes"
                    },
                ),
            )
            if (!scripts) stored?.let { askRemotes(m, sys, it) }
        }
    }

    /** A finished pane closes on the screen as it was, minus what it just ran. */
    private fun closed(s: HomeState, run: PaneRun) =
        s.copy(run = null, selection = if (run.scripts) s.selection else emptySet())

    private fun update(transform: (PaneRun) -> PaneRun) {
        state = state.copy(run = state.run?.let(transform))
    }

    private fun appendRun(lines: List<String>) {
        if (lines.isEmpty()) return
        update { it.copy(log = (it.log + lines).takeLast(MAX_RUN_LINES)) }
    }

    private fun scrollRun(delta: Int, viewport: Int) {
        val run = state.run ?: return
        val lines = if (run.confirming) run.commands else run.log
        val max = (lines.size - viewport).coerceAtLeast(0)
        update { it.copy(scrollBack = (it.scrollBack + delta).coerceIn(0, max)) }
    }

    private fun cancelRun() {
        cancelled = true
        running?.kill()
    }

    private fun leaveFor(action: HomeAction): Boolean {
        state = state.copy(action = action, exit = true)
        return true
    }

    /** Move the focused detail line, keeping it inside the visible window. */
    private fun moveDetail(delta: Int, viewport: Int) {
        val s = state
        val total = detailLines(s, s.sections.getOrNull(s.cursor))
        if (total == 0) return
        val cursor = (s.detailCursor + delta).coerceIn(0, total - 1)
        val scroll = s.scroll.coerceIn((cursor - viewport + 1).coerceAtLeast(0), cursor)
        state = s.copy(detailCursor = cursor, scroll = scroll.coerceAtMost((total - viewport).coerceAtLeast(0)))
    }

    private fun scrollBy(delta: Int, viewport: Int) {
        val s = state
        val total = detailLines(s, s.sections.getOrNull(s.cursor))
        val max = (total - viewport).coerceAtLeast(0)
        state = s.copy(scroll = (s.scroll + delta).coerceIn(0, max))
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
                status = verdicts[name]?.status,
            )
        }
}

/** Anything not known-done starts ticked: that IS the work. */
internal fun preselect(rows: List<ScriptRow>): Set<String> =
    rows.filter { it.status != ScriptStatus.DONE }.map { it.name }.toSet()

/**
 * What ticking [row] selects. A package row selects the TOOL behind it (dnf,
 * brew — the sweep upgrades all of it); a custom source's row selects just
 * that row, because its items are independent. Null = loadout can't upgrade
 * it at all.
 */
internal fun selectionKey(answered: RemoteStatus.Answered, row: UpdateRow): String? {
    if (row.source in answered.upgradableSources) return "item:${row.source}/${row.name}"
    val tool = answered.toolOf[answered.mechanismOf[row.name]] ?: return null
    return "tool:$tool"
}

/** How many detail lines this section can open in place (0 = none). */
internal fun detailLines(state: HomeState, section: HomeSection?): Int = when (section?.action) {
    HomeAction.RUN_SCRIPTS -> state.scripts.size
    HomeAction.REVIEW_OUTDATED -> (state.remote as? RemoteStatus.Answered)?.updates?.size ?: 0
    HomeAction.SHOW_DIFF -> state.fleet?.rows?.count { it.drift || it.incomplete } ?: 0
    else -> 0
}

/** Pure: the four subject lines for a machine's observed state. */
internal fun sectionsOf(
    manifest: Manifest,
    system: SystemInfo,
    observed: MachineState?,
    fleet: loadout.core.diff.DiffReport?,
    remote: RemoteStatus?,
    checking: Boolean = false,
): List<HomeSection> {
    val programs = observed?.programs.orEmpty()
    val missing = programs.filterValues { it.status == ProgramStatus.MISSING }.keys.sorted()
    val installed = programs.count { it.value.status == ProgramStatus.INSTALLED }
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
            summary = if (observed == null) "$mapped mapped — not observed yet"
            else "$installed installed · ${missing.size} missing",
            verb = if (missing.isEmpty()) "nothing missing" else "install what's missing",
            action = if (missing.isEmpty()) HomeAction.NONE else HomeAction.INSTALL_MISSING,
            severity = if (missing.isEmpty()) null else true,
            busy = checking,
            offenders = missing,
        ),
        HomeSection(
            subject = "scripts",
            summary = if (observed == null) "not observed yet"
            else "$done done · ${unfinished.size} pending",
            verb = if (unfinished.isEmpty()) "nothing pending" else "run what's pending",
            action = if (pickable) HomeAction.RUN_SCRIPTS else HomeAction.NONE,
            severity = if (unfinished.isEmpty()) null else false,
            busy = checking,
            // No preview: this row's detail is the picker, and it opens on l.
            offenders = emptyList(),
        ),
        HomeSection(
            subject = "remote",
            summary = when (remote) {
                null -> "not asked yet"
                // Empty on purpose: the row shows the spinner instead.
                RemoteStatus.Asking -> ""
                is RemoteStatus.Unavailable -> "unavailable — ${remote.reason}"
                is RemoteStatus.Answered -> when {
                    remote.names.isEmpty() && remote.failedSources == 0 -> "everything up to date"
                    remote.names.isEmpty() -> "${remote.failedSources} source(s) failed"
                    else -> "${remote.names.size} update(s) available" +
                        if (remote.failedSources == 0) "" else " · ${remote.failedSources} source(s) failed"
                }
            },
            verb = "review them",
            action = HomeAction.REVIEW_OUTDATED,
            severity = when {
                remote is RemoteStatus.Answered && remote.failedSources > 0 -> true
                remote is RemoteStatus.Answered && remote.names.isNotEmpty() -> false
                else -> null
            },
            neutral = remote == null || remote is RemoteStatus.Asking || remote is RemoteStatus.Unavailable,
            busy = remote is RemoteStatus.Asking,
            // No inline preview here: this row's detail is the full table,
            // and it opens on enter — moving the cursor shouldn't spill it.
            offenders = emptyList(),
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
            // Like the remote row: the detail opens on enter, it doesn't
            // spill under the cursor.
            offenders = emptyList(),
        ),
    )
}
