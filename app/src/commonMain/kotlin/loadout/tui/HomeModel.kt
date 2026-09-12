package loadout.tui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import loadout.cli.AppContext
import loadout.cli.UpdateRow
import loadout.cli.outdatedReport
import loadout.core.TOOL_VERSION
import loadout.core.diff.DiffEngine
import loadout.core.model.MachineState
import loadout.core.model.Manifest
import loadout.core.model.ProgramStatus
import loadout.core.model.ScriptStatus
import loadout.core.model.SystemInfo
import loadout.core.engine.UpgradeEngine
import loadout.core.engine.VersionChecker
import loadout.core.exec.RunningProcess
import loadout.core.platform.blockingDispatcher
import loadout.core.platform.envVar
import loadout.core.platform.terminalBackgroundLuma
import loadout.theme.detectDarkTerminal
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** A run happening inside the screen, shown in the floating pane. */
data class UpgradeRun(
    val steps: List<String>,
    val current: Int = 0,
    val label: String = "",
    val log: List<String> = emptyList(),
    val done: Boolean = false,
    val failed: Boolean = false,
    val cancelled: Boolean = false,
    val summary: String = "",
)

enum class HomeKey {
    UP, DOWN, PAGE_UP, PAGE_DOWN, ENTER, OPEN, CLOSE, ESC,
    SELECT, SELECT_ALL, UPGRADE_SELECTION,
    REFRESH, SYNC, UPGRADE, CONVERGE, THEME, QUIT,
}

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
    ) : RemoteStatus {
        val names: List<String> get() = updates.map { it.name }
    }
    data class Unavailable(val reason: String) : RemoteStatus
}

/** What the user chose. The screen decides; the matching command does it. */
enum class HomeAction {
    NONE,

    // Row verbs: what the focused subject needs.
    RUN_PENDING, INSTALL_MISSING, REVIEW_OUTDATED, SHOW_DIFF,

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
    /** The upgrade running in the floating pane, if any. */
    val run: UpgradeRun? = null,
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
        // Before Mosaic owns the terminal (OSC 11 query), like MaintainModel.
        HomeState(dark = detectDarkTerminal(terminalBackgroundLuma(), envVar("COLORFGBG"))),
    )
        private set

    internal fun setStateForTest(s: HomeState) {
        state = s
    }

    private val scope = CoroutineScope(SupervisorJob() + blockingDispatcher)
    private var running: RunningProcess? = null
    private var cancelled = false
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
        state = state.copy(
            machine = sys.machine,
            system = "${sys.os.id}${sys.distro?.let { "/$it" }.orEmpty()} · ${sys.arch}",
            sections = sectionsOf(m, sys, stored, report, null),
            fleet = report,
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
            state = state.copy(
                loading = false,
                stale = fresh.isFailure,
                fleet = report,
                sections = sectionsOf(m, sys, observed, report, state.remote),
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
     * scroll bound, the same way the maintain viewer takes its height.
     */
    fun handleKey(key: HomeKey, viewport: Int = 8): Boolean {
        val s = state
        // The floating pane owns the keyboard while it's up.
        s.run?.let { run ->
            when (key) {
                HomeKey.ESC, HomeKey.QUIT -> if (run.done) {
                    state = s.copy(run = null, selection = emptySet())
                } else {
                    cancelRun()
                }
                HomeKey.ENTER -> if (run.done) state = s.copy(run = null, selection = emptySet())
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
            when (key) {
                HomeKey.UP -> moveDetail(-1, viewport)
                HomeKey.DOWN -> moveDetail(1, viewport)
                HomeKey.PAGE_UP -> moveDetail(-viewport, viewport)
                HomeKey.PAGE_DOWN -> moveDetail(viewport, viewport)
                HomeKey.ENTER, HomeKey.ESC, HomeKey.CLOSE ->
                    state = s.copy(expanded = false, scroll = 0, detailCursor = 0)
                HomeKey.OPEN -> {} // already open
                HomeKey.SELECT -> if (onRemote && answered != null) {
                    // Selecting a package selects its MECHANISM: loadout only
                    // does whole upgrades, so anything else would be a lie
                    // about what pressing u will run.
                    val row = answered.updates.getOrNull(s.detailCursor)
                    val tool = row?.let { answered.toolOf[answered.mechanismOf[it.name]] }
                    state = when {
                        row == null -> s
                        tool == null -> s.copy(message = "${row.name} has no mechanism loadout can upgrade")
                        tool in s.selection -> s.copy(selection = s.selection - tool, message = null)
                        else -> s.copy(selection = s.selection + tool, message = null)
                    }
                }
                HomeKey.SELECT_ALL -> if (onRemote && answered != null) {
                    val every = answered.mechanismOf.values.mapNotNull { answered.toolOf[it] }.toSet()
                    state = s.copy(selection = if (s.selection.containsAll(every)) emptySet() else every)
                }
                HomeKey.UPGRADE_SELECTION -> if (onRemote && answered != null && s.selection.isNotEmpty()) {
                    // Selection is by tool; the engine takes mechanisms.
                    startUpgrade(s.selection.flatMap { answered.mechanismsOfTool[it].orEmpty() }.sorted())
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
                state = if (detailLines(s, section) > 0) {
                    s.copy(expanded = true, scroll = 0, detailCursor = 0)
                } else {
                    s.copy(message = "nothing to open there — enter acts on it")
                }
            }
            HomeKey.CLOSE -> {} // nothing open
            HomeKey.ENTER -> {
                val section = s.sections.getOrNull(s.cursor) ?: return false
                // When the answer is already in hand, enter opens it HERE
                // rather than leaving the screen to ask the same question.
                if (detailLines(s, section) > 0) {
                    state = s.copy(expanded = true, scroll = 0, detailCursor = 0)
                } else if (section.action == HomeAction.NONE) {
                    state = s.copy(message = "nothing to do there")
                } else {
                    // The screen closes so the action owns the terminal —
                    // sudo prompts and full-screen runners both need that.
                    state = s.copy(action = section.action, exit = true)
                    return true
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
    fun startUpgrade(installers: List<String>) {
        val m = manifest ?: return
        val sys = system ?: return
        if (state.run != null) return
        val engine = UpgradeEngine(app.runner, VersionChecker(app.runner, app.repoRoot.toString()), app.repoRoot)
        val plan = runCatching { engine.plan(m, sys.machine, installers) }.getOrElse { e ->
            state = state.copy(message = e.message?.lineSequence()?.firstOrNull())
            return
        }
        if (plan.any { "sudo" in it.command } && !app.runner.capture("sudo -n true").success) {
            state = state.copy(message = "sudo needs a password — run `sudo -v` in a terminal, then press u again")
            return
        }
        cancelled = false
        state = state.copy(
            expanded = false,
            run = UpgradeRun(steps = plan.map { it.label }, label = plan.first().label),
        )
        scope.launch {
            for ((index, step) in plan.withIndex()) {
                if (cancelled) break
                update { it.copy(current = index, label = step.label, log = it.log + "$ ${step.command}") }
                val exit = app.runner.stream(
                    step.command,
                    workDir = app.repoRoot.toString(),
                    onStart = { running = it },
                ) { line -> if (!cancelled) appendRun(displayLines(line)) }
                running = null
                if (cancelled) break
                appendRun(listOf("exit $exit"))
                if (exit != 0) update { it.copy(failed = true) }
            }
            if (cancelled) {
                update { it.copy(done = true, cancelled = true, summary = "cancelled — state not refreshed") }
                return@launch
            }
            // The transaction moved what it moved: re-ask everything.
            update { it.copy(label = "re-checking", log = it.log + "" + "re-checking every program…") }
            val fresh = runCatching { app.refreshAndWriteState(m, sys) }
            stored = fresh.getOrNull() ?: stored
            val changed = fresh.getOrNull()?.let { after ->
                after.programs.count { (name, now) -> now.version != null && now.version != before[name] }
            } ?: 0
            before = stored?.programs?.mapValues { it.value.version }.orEmpty()
            state = state.copy(
                sections = sectionsOf(m, sys, stored, fleet(), state.remote),
                run = state.run?.copy(
                    done = true,
                    summary = if (state.run?.failed == true) "finished with failures — enter closes"
                    else "$changed declared program(s) changed version — enter closes",
                ),
            )
        }
    }

    private fun update(transform: (UpgradeRun) -> UpgradeRun) {
        state = state.copy(run = state.run?.let(transform))
    }

    private fun appendRun(lines: List<String>) {
        if (lines.isEmpty()) return
        update { it.copy(log = (it.log + lines).takeLast(MAX_RUN_LINES)) }
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

/** Log lines the pane keeps; the viewer tails a long run. */
private const val MAX_RUN_LINES = 5_000

/** How many detail lines this section can open in place (0 = none). */
internal fun detailLines(state: HomeState, section: HomeSection?): Int = when (section?.action) {
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
            action = if (unfinished.isEmpty()) HomeAction.NONE else HomeAction.RUN_PENDING,
            severity = if (unfinished.isEmpty()) null else false,
            busy = checking,
            offenders = unfinished,
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
