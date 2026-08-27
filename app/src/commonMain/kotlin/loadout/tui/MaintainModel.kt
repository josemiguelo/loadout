package loadout.tui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import loadout.cli.AppContext
import loadout.core.engine.ScriptRunner
import loadout.core.exec.ProcessRunner
import loadout.core.exec.RunningProcess
import loadout.core.manifest.ManifestLoader
import loadout.core.model.Manifest
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus
import loadout.core.model.SystemInfo
import loadout.core.platform.blockingDispatcher
import loadout.core.platform.envVar
import loadout.core.platform.nowIso
import loadout.core.platform.terminalBackgroundLuma
import loadout.theme.detectDarkTerminal
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class MaintainKey { UP, DOWN, PAGE_UP, PAGE_DOWN, SPACE, A, N, T, Q, ESC, ENTER }

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

enum class MaintainPhase { SELECT, RUNNING, DONE }

enum class RunStatus { WAITING, RUNNING, CHECKING, DONE, PENDING, FAILED, CANCELLED }

data class MaintainRow(
    val name: String,
    /** Shell command that runs the script itself (file/run, machine args applied). */
    val command: String,
    /** The script's check with args applied, when it has one — the post-run truth. */
    val checkCommand: String? = null,
    val status: RunStatus = RunStatus.WAITING,
    val log: List<String> = emptyList(),
)

data class MaintainState(
    val machine: String = "",
    val rows: List<MaintainRow> = emptyList(),
    val cursor: Int = 0,
    val selected: Set<String> = emptySet(),
    val phase: MaintainPhase = MaintainPhase.SELECT,
    /** Name of the row whose full log is open in the DONE-phase viewer. */
    val viewing: String? = null,
    val scroll: Int = 0,
    val message: String? = null,
    val exit: Boolean = false,
    val exitCode: Int = 0,
    val dark: Boolean = true,
)

/**
 * Interactive `loadout maintain`: pick which of this machine's scripts to run,
 * watch each one run with a live log, then browse any full log. Runs the
 * scripts THEMSELVES (forced — selecting one means you want it run); each
 * script's check, when it has one, decides the resulting status. All state
 * and logic here; TuiApp.kt renders it.
 */
class MaintainModel(
    private val app: AppContext,
    private val runner: ProcessRunner = app.runner,
) {
    var state by mutableStateOf(
        // The OSC query must happen before Mosaic owns the terminal, i.e. the
        // model must be constructed outside runMosaic (see runMaintainTui).
        MaintainState(dark = detectDarkTerminal(terminalBackgroundLuma(), envVar("COLORFGBG"))),
    )
        private set

    internal fun setStateForTest(s: MaintainState) {
        state = s
    }

    // Runs live on the model's own scope, outside the Mosaic composition's
    // job hierarchy (a job parked there would keep runMosaic from finishing).
    private val scope = CoroutineScope(SupervisorJob() + blockingDispatcher)
    private var current: RunningProcess? = null
    private var cancelled = false
    private var manifest: Manifest? = null
    private var system: SystemInfo? = null

    /** Load this machine's opted-in scripts. Call before runMosaic; may throw. */
    fun load() {
        val m = app.loadManifest()
        val sys = app.detectSystem()
        manifest = m
        system = sys
        val enabled = m.machines[sys.machine]?.scriptArgs().orEmpty()
        val targets = ManifestLoader.scriptOrder(m, enabled.keys)
            .filter { name ->
                name in enabled &&
                    m.scripts.getValue(name).appliesTo(sys.os) &&
                    m.scripts.getValue(name).runsIn("maintain")
            }
        state = state.copy(
            machine = sys.machine,
            rows = targets.map { name ->
                val step = m.scripts.getValue(name)
                val args = enabled.getValue(name)
                MaintainRow(
                    name = name,
                    command = ScriptRunner.commandFor(step, args),
                    checkCommand = step.check?.let { ScriptRunner.withArgs(it, args) },
                )
            },
        )
    }

    /** Fire-and-forget entry point for the UI; tests call [runSelected] directly. */
    fun startRun() {
        scope.launch { runSelected() }
    }

    /**
     * Synchronous reducer. Returns true when the caller must [startRun].
     * [viewerHeight] is how many log lines the viewer shows (bounds scrolling).
     */
    fun handleKey(key: MaintainKey, viewerHeight: Int = 10): Boolean {
        val s = state
        when (s.phase) {
            MaintainPhase.SELECT -> when (key) {
                MaintainKey.UP -> move(-1)
                MaintainKey.DOWN -> move(1)
                MaintainKey.SPACE -> s.rows.getOrNull(s.cursor)?.let { row ->
                    state = s.copy(
                        selected = if (row.name in s.selected) s.selected - row.name else s.selected + row.name,
                    )
                }
                MaintainKey.A -> state = s.copy(selected = s.rows.map { it.name }.toSet())
                MaintainKey.N -> state = s.copy(selected = emptySet())
                MaintainKey.ENTER ->
                    if (s.selected.isEmpty()) {
                        state = s.copy(message = "nothing selected — space toggles, a selects all")
                    } else {
                        return true
                    }
                MaintainKey.T -> toggleTheme()
                MaintainKey.Q, MaintainKey.ESC -> state = s.copy(exit = true)
                else -> {}
            }
            MaintainPhase.RUNNING -> when (key) {
                MaintainKey.ESC, MaintainKey.Q -> cancelRun()
                MaintainKey.T -> toggleTheme()
                else -> {}
            }
            MaintainPhase.DONE ->
                if (s.viewing == null) when (key) {
                    MaintainKey.UP -> move(-1)
                    MaintainKey.DOWN -> move(1)
                    MaintainKey.ENTER, MaintainKey.SPACE -> s.rows.getOrNull(s.cursor)
                        ?.takeIf { it.log.isNotEmpty() }
                        ?.let { state = s.copy(viewing = it.name, scroll = 0) }
                    MaintainKey.T -> toggleTheme()
                    MaintainKey.Q, MaintainKey.ESC -> state = s.copy(exit = true)
                    else -> {}
                } else when (key) {
                    MaintainKey.UP -> scrollBy(-1, viewerHeight)
                    MaintainKey.DOWN -> scrollBy(1, viewerHeight)
                    MaintainKey.PAGE_UP -> scrollBy(-viewerHeight, viewerHeight)
                    MaintainKey.PAGE_DOWN -> scrollBy(viewerHeight, viewerHeight)
                    MaintainKey.ENTER, MaintainKey.ESC -> state = s.copy(viewing = null, scroll = 0)
                    MaintainKey.T -> toggleTheme()
                    MaintainKey.Q -> state = s.copy(exit = true)
                    else -> {}
                }
        }
        return false
    }

    internal suspend fun runSelected(): Unit = withContext(blockingDispatcher) {
        val targets = state.rows.filter { it.name in state.selected }
        // Streamed output would swallow a sudo password prompt; refuse unless
        // sudo's credential cache is warm (same guard as the dashboard).
        if (targets.any { "sudo" in it.command } && !runner.capture("sudo -n true").success) {
            state = state.copy(message = "sudo needs a password — run 'sudo -v' in a terminal first, then retry")
            return@withContext
        }
        cancelled = false
        state = state.copy(phase = MaintainPhase.RUNNING, message = null)
        val results = mutableMapOf<String, ScriptState>()
        for (target in targets) {
            if (cancelled) break
            // Seed the log with the command so every run has a viewable log,
            // even when the script itself stays silent.
            setRow(target.name) { it.copy(status = RunStatus.RUNNING, log = listOf("$ ${target.command}")) }
            val exit = runner.stream(
                target.command,
                workDir = app.repoRoot.toString(),
                onStart = { current = it },
            ) { line ->
                if (!cancelled) displayLines(line).forEach { appendLog(target.name, it) }
            }
            current = null
            // After a cancel the state was already finalized by cancelRun();
            // a late stream return must not touch it.
            if (cancelled) return@withContext
            results[target.name] = ScriptState(
                status = if (exit == 0) ScriptStatus.DONE else ScriptStatus.FAILED,
                lastRun = nowIso(),
                exitCode = exit,
            )
            appendLog(target.name, "exit $exit")
            // The check, when there is one, has the final word on status. It
            // can take minutes (asdf probes every version) — surface it as
            // its own visible state instead of pretending the script still runs.
            val status = when {
                target.checkCommand == null -> if (exit == 0) RunStatus.DONE else RunStatus.FAILED
                else -> {
                    // Stream the check too: slow checks (asdf probes every
                    // version) show their findings live and esc can kill them.
                    setRow(target.name) { it.copy(status = RunStatus.CHECKING) }
                    val checkExit = runner.stream(
                        target.checkCommand,
                        workDir = app.repoRoot.toString(),
                        onStart = { current = it },
                    ) { line ->
                        if (!cancelled) displayLines(line).forEach { appendLog(target.name, it) }
                    }
                    current = null
                    if (cancelled) return@withContext
                    if (checkExit == 0) {
                        appendLog(target.name, "check: passed")
                        RunStatus.DONE
                    } else {
                        appendLog(target.name, "check: still failing")
                        RunStatus.PENDING
                    }
                }
            }
            if (cancelled) return@withContext
            setRow(target.name) { it.copy(status = status) }
        }
        if (cancelled) return@withContext
        writeState(results)
        finishRun()
    }

    private suspend fun writeState(results: Map<String, ScriptState>) {
        val m = manifest ?: return
        val sys = system ?: return
        if (results.isEmpty()) return
        state = state.copy(message = "updating state…")
        runCatching {
            val previous = app.stateStore.read(sys.machine)
            if (previous == null) {
                // No state file yet — build a complete one the normal way.
                app.refreshAndWriteState(m, sys, results)
            } else {
                // Merge the run's own results: the checks this run just
                // executed already decided each script's status, so a full
                // refresh here would only repeat minutes of probing.
                val statuses = state.rows.associate { it.name to it.status }
                val merged = previous.copy(
                    scripts = previous.scripts + results.mapValues { (name, run) ->
                        run.copy(
                            status = when (statuses[name]) {
                                RunStatus.DONE -> ScriptStatus.DONE
                                RunStatus.PENDING -> ScriptStatus.PENDING
                                else -> run.status
                            },
                        )
                    },
                    updatedAt = nowIso(),
                )
                if (merged.copy(updatedAt = previous.updatedAt) != previous) app.stateStore.write(merged)
            }
        }
    }

    private fun cancelRun() {
        cancelled = true
        current?.kill()
        state = state.copy(
            rows = state.rows.map {
                if (it.status == RunStatus.RUNNING || it.status == RunStatus.CHECKING) {
                    it.copy(status = RunStatus.CANCELLED)
                } else {
                    it
                }
            },
            phase = MaintainPhase.DONE,
            exitCode = 1,
            message = "cancelled — state not written",
        )
    }

    private fun finishRun() {
        val bad = state.rows.count { it.status == RunStatus.PENDING || it.status == RunStatus.FAILED }
        val ran = state.rows.count { it.status != RunStatus.WAITING }
        state = state.copy(
            phase = MaintainPhase.DONE,
            exitCode = if (bad > 0) 1 else 0,
            message =
                if (bad == 0) "all $ran done — enter opens a script's log"
                else "$bad of $ran failed or still pending — enter opens the logs",
        )
    }

    private fun setRow(name: String, transform: (MaintainRow) -> MaintainRow) {
        state = state.copy(rows = state.rows.map { if (it.name == name) transform(it) else it })
    }

    private fun appendLog(name: String, line: String) {
        setRow(name) { it.copy(log = (it.log + line).takeLast(10_000)) }
    }

    private fun move(delta: Int) {
        val max = (state.rows.size - 1).coerceAtLeast(0)
        state = state.copy(cursor = (state.cursor + delta).coerceIn(0, max))
    }

    private fun scrollBy(delta: Int, viewerHeight: Int) {
        val log = state.rows.firstOrNull { it.name == state.viewing }?.log ?: return
        val max = (log.size - viewerHeight).coerceAtLeast(0)
        state = state.copy(scroll = (state.scroll + delta).coerceIn(0, max))
    }

    private fun toggleTheme() {
        val dark = !state.dark
        state = state.copy(dark = dark, message = "theme: ${if (dark) "dark (Tokyo Night)" else "light"}")
    }
}
