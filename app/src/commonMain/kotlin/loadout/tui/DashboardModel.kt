package loadout.tui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import loadout.cli.AppContext
import loadout.core.diff.DiffEngine
import loadout.core.diff.InstallState
import loadout.core.engine.InstallEngine
import loadout.core.engine.PlanItem
import loadout.core.engine.ScriptOutcome
import loadout.core.engine.ScriptRunner
import loadout.core.engine.VersionChecker
import loadout.core.git.GitClient
import loadout.core.model.Manifest
import loadout.core.model.ScriptStatus
import loadout.core.platform.blockingDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Key { UP, DOWN, R, I, A, S, D, L, Y, N, Q, ESC, ENTER }

enum class Mode { LOADING, NORMAL, DETAILS, LOG, CONFIRM_PLAN, CONFIRM_SCRIPT, BUSY }

enum class AsyncAction { LOAD, REFRESH, PREPARE_SELECTED, PREPARE_ALL, EXECUTE_PLAN, EXECUTE_SCRIPT, SYNC }

data class RowUi(
    val name: String,
    val isScript: Boolean,
    /** machine name -> cell text (version / "missing" / "done" / "pending" / "-"). */
    val cells: Map<String, String>,
    val flags: String,
)

data class TuiState(
    val repo: String = "",
    val machine: String = "",
    val machines: List<String> = emptyList(),
    val rows: List<RowUi> = emptyList(),
    val selected: Int = 0,
    val mode: Mode = Mode.LOADING,
    val log: List<String> = emptyList(),
    val message: String? = null,
    val confirmText: String = "",
    val exit: Boolean = false,
) {
    val selectedRow: RowUi? get() = rows.getOrNull(selected)
}

const val KEY_HELP = "ready"

class DashboardModel(private val app: AppContext) {
    var state by mutableStateOf(TuiState(repo = app.repoRoot.toString()))
        private set

    internal fun setStateForTest(s: TuiState) {
        state = s
    }

    private var manifest: Manifest? = null
    private var pendingPlan: List<PlanItem> = emptyList()
    private var pendingScript: String? = null

    // Async actions run on the model's own scope, deliberately outside the
    // Mosaic composition's job hierarchy: work parked there would keep
    // runMosaic from finishing on exit.
    private val scope = CoroutineScope(SupervisorJob() + blockingDispatcher)

    /** Fire-and-forget entry point for the UI; tests call [perform] directly. */
    fun dispatch(action: AsyncAction) {
        scope.launch { perform(action) }
    }

    /**
     * Synchronous reducer: mutates navigation/mode state and returns the async
     * action (if any) the caller must launch.
     */
    fun handleKey(key: Key): AsyncAction? {
        val s = state
        return when (s.mode) {
            Mode.LOADING, Mode.BUSY -> null
            Mode.NORMAL -> when (key) {
                Key.UP -> { move(-1); null }
                Key.DOWN -> { move(1); null }
                Key.D, Key.ENTER -> { if (s.rows.isNotEmpty()) state = s.copy(mode = Mode.DETAILS); null }
                Key.L -> { state = s.copy(mode = Mode.LOG); null }
                Key.R -> { busy("checking versions and scripts..."); AsyncAction.REFRESH }
                Key.I -> if (s.rows.isEmpty()) null else { busy("planning..."); AsyncAction.PREPARE_SELECTED }
                Key.A -> { busy("planning..."); AsyncAction.PREPARE_ALL }
                Key.S -> { busy("syncing..."); AsyncAction.SYNC }
                Key.Q, Key.ESC -> { scope.cancel(); state = s.copy(exit = true); null }
                else -> null
            }
            Mode.DETAILS -> when (key) {
                Key.D, Key.ESC, Key.ENTER, Key.Q -> { state = s.copy(mode = Mode.NORMAL); null }
                Key.UP -> { move(-1); null }
                Key.DOWN -> { move(1); null }
                else -> null
            }
            Mode.LOG -> when (key) {
                Key.L, Key.ESC, Key.Q -> { state = s.copy(mode = Mode.NORMAL); null }
                else -> null
            }
            Mode.CONFIRM_PLAN -> when (key) {
                Key.Y -> { busy("installing..."); AsyncAction.EXECUTE_PLAN }
                Key.N, Key.ESC, Key.Q -> { cancelConfirm(); null }
                else -> null
            }
            Mode.CONFIRM_SCRIPT -> when (key) {
                Key.Y -> { busy("running script..."); AsyncAction.EXECUTE_SCRIPT }
                Key.N, Key.ESC, Key.Q -> { cancelConfirm(); null }
                else -> null
            }
        }
    }

    suspend fun perform(action: AsyncAction): Unit = withContext(blockingDispatcher) {
        try {
            when (action) {
                AsyncAction.LOAD -> reload(KEY_HELP)
                AsyncAction.REFRESH -> { refreshThisMachine(); reload("refreshed") }
                AsyncAction.PREPARE_SELECTED -> prepareSelected()
                AsyncAction.PREPARE_ALL -> preparePlan(emptyList())
                AsyncAction.EXECUTE_PLAN -> executePlan()
                AsyncAction.EXECUTE_SCRIPT -> executeScript()
                AsyncAction.SYNC -> sync()
            }
        } catch (e: Exception) {
            state = state.copy(
                mode = Mode.NORMAL,
                message = "error: ${e.message?.lines()?.joinToString(" ")?.take(200)}",
            )
        }
    }

    private fun move(delta: Int) {
        val max = (state.rows.size - 1).coerceAtLeast(0)
        state = state.copy(selected = (state.selected + delta).coerceIn(0, max))
    }

    private fun busy(message: String) {
        state = state.copy(mode = Mode.BUSY, message = message)
    }

    private fun cancelConfirm() {
        pendingPlan = emptyList()
        pendingScript = null
        state = state.copy(mode = Mode.NORMAL, confirmText = "", message = "cancelled")
    }

    private fun log(line: String) {
        state = state.copy(log = (state.log + line).takeLast(200))
    }

    private suspend fun reload(message: String) {
        val m = app.loadManifest()
        manifest = m
        val machine = app.detectSystem().machine
        val states = app.stateStore.readAll()
        app.stateStore.lastWarnings.forEach { log("warning: $it") }
        val report = DiffEngine.diff(m, states.values)

        val programRows = report.rows.map { row ->
            RowUi(
                name = row.program,
                isScript = false,
                cells = row.perMachine.mapValues { (_, cell) ->
                    when (cell) {
                        is InstallState.Installed -> cell.version ?: "ok"
                        InstallState.Missing -> "missing"
                        InstallState.Unknown -> "-"
                    }
                },
                flags = buildList {
                    if (row.drift) add("drift")
                    if (row.incomplete) add("missing")
                }.joinToString(","),
            )
        }
        val scriptRows = m.scripts.keys.sorted().map { name ->
            RowUi(
                name = name,
                isScript = true,
                cells = report.machines.associateWith { mach ->
                    when (states[mach]?.scripts?.get(name)?.status) {
                        ScriptStatus.DONE -> "done"
                        ScriptStatus.PENDING -> "pending"
                        ScriptStatus.FAILED -> "failed"
                        null -> "-"
                    }
                },
                flags = "",
            )
        }
        val rows = programRows + scriptRows
        state = state.copy(
            machine = machine,
            machines = report.machines,
            rows = rows,
            selected = state.selected.coerceIn(0, (rows.size - 1).coerceAtLeast(0)),
            mode = Mode.NORMAL,
            message = message,
        )
    }

    private suspend fun refreshThisMachine() {
        val m = manifest ?: app.loadManifest()
        app.refreshAndWriteState(m, app.detectSystem())
    }

    private suspend fun prepareSelected() {
        val row = state.selectedRow ?: run { state = state.copy(mode = Mode.NORMAL); return }
        if (row.isScript) {
            val enabled = manifest?.machines?.get(state.machine)?.scriptArgs()?.containsKey(row.name) == true
            if (!enabled) {
                state = state.copy(
                    mode = Mode.NORMAL,
                    message = "script '${row.name}' is not enabled for ${state.machine} (scripts list in machines/${state.machine}.toml)",
                )
                return
            }
            pendingScript = row.name
            state = state.copy(mode = Mode.CONFIRM_SCRIPT, confirmText = "run script '${row.name}'? [y/n]")
        } else {
            preparePlan(listOf(row.name))
        }
    }

    private suspend fun preparePlan(requested: List<String>) {
        val m = manifest ?: app.loadManifest().also { manifest = it }
        val system = app.detectSystem()
        val current = app.stateStore.read(system.machine)?.programs.orEmpty()
        val engine = InstallEngine(app.runner, VersionChecker(app.runner, app.repoRoot.toString()), app.repoRoot)
        val plan = engine.plan(m, system.machine, requested, current) { app.detection.isPmAvailable(it) }
        val installs = plan.filterIsInstance<PlanItem.Install>()

        if (installs.isEmpty()) {
            state = state.copy(mode = Mode.NORMAL, message = "nothing to install")
            return
        }
        if (installs.any { "sudo" in it.command } && !app.runner.capture("sudo -n true").success) {
            state = state.copy(
                mode = Mode.NORMAL,
                message = "sudo needs a password — run 'sudo -v' in a terminal first, or use the CLI: loadout install",
            )
            return
        }
        pendingPlan = plan
        state = state.copy(
            mode = Mode.CONFIRM_PLAN,
            confirmText = "install ${installs.joinToString(", ") { it.program }}? [y/n]",
        )
    }

    private suspend fun executePlan() {
        val m = manifest ?: return
        val engine = InstallEngine(app.runner, VersionChecker(app.runner, app.repoRoot.toString()), app.repoRoot)
        val outcomes = engine.executeCaptured(m, pendingPlan) { log(it) }
        pendingPlan = emptyList()
        refreshThisMachine()
        val failed = outcomes.filterNot { it.success }
        reload(
            if (failed.isEmpty()) "${outcomes.size} installed"
            else "${outcomes.size - failed.size} installed, failed: ${failed.joinToString(", ") { it.program }}",
        )
        state = state.copy(confirmText = "")
    }

    private suspend fun executeScript() {
        val m = manifest ?: return
        val name = pendingScript ?: return
        pendingScript = null
        val step = m.scripts.getValue(name)
        val system = app.detectSystem()
        val args = m.machines[system.machine]?.scriptArgs()?.get(name).orEmpty()
        val outcome = ScriptRunner(app.runner, app.repoRoot).run(step, system.os, captureOutput = true, args = args)
        val message = when (outcome) {
            ScriptOutcome.NotApplicable -> "script '$name' does not apply to ${system.os.id}"
            ScriptOutcome.AlreadyDone -> "script '$name' already done (check passed)"
            is ScriptOutcome.Ran -> {
                log("==> ran script $name (exit ${outcome.state.exitCode})")
                outcome.output.lineSequence().filter { it.isNotBlank() }.forEach { log("    $it") }
                app.refreshAndWriteState(m, system, mapOf(name to outcome.state))
                "script '$name' ${if (outcome.state.status == ScriptStatus.DONE) "succeeded" else "FAILED"}"
            }
        }
        reload(message)
        state = state.copy(confirmText = "")
    }

    private suspend fun sync() {
        val git = GitClient(app.runner, app.repoRoot)
        if (!git.isRepo()) {
            state = state.copy(mode = Mode.NORMAL, message = "not a git repository — run git init first")
            return
        }
        val hasUpstream = git.hasUpstream()
        if (hasUpstream) {
            log("==> git pull --rebase")
            git.pullRebase()
        }
        refreshThisMachine()
        val machine = state.machine.ifEmpty { app.detectSystem().machine }
        val committed = git.addCommit("state/$machine.json", "$machine: update state")
        val message = when {
            !committed -> "state unchanged; nothing to commit"
            !hasUpstream -> "committed (no upstream to push to)"
            else -> {
                log("==> git push")
                git.push()
                "committed and pushed"
            }
        }
        reload(message)
    }

    /** Lines for the details pane of the selected row. */
    fun detailLines(): List<String> {
        val m = manifest ?: return emptyList()
        val row = state.selectedRow ?: return emptyList()
        return if (row.isScript) {
            val s = m.scripts.getValue(row.name)
            buildList {
                add("script ${row.name}  ${s.description}")
                add("  ${if (s.file != null) "file: ${s.file}" else "run: ${s.run}"}")
                s.check?.let { add("  check: $it") }
                if (s.os.isNotEmpty()) add("  os: ${s.os.joinToString()}")
                if (s.after.isNotEmpty()) add("  after: ${s.after.joinToString()}")
            }
        } else {
            val p = m.programs.getValue(row.name)
            val mapped = m.machines[state.machine]?.pm?.get(row.name)
            buildList {
                add("program ${row.name}  ${p.description}")
                if (p.dependsOn.isNotEmpty()) add("  depends-on: ${p.dependsOn.joinToString()}")
                p.version?.let { add("  version: ${it.command}  =~ /${it.regex}/") }
                for ((key, cmd) in p.install) {
                    val marker = if (key == mapped) " <- this machine" else ""
                    add("  install.$key: $cmd$marker")
                }
                if (mapped == null) add("  ! no mapping for ${state.machine} (machines/${state.machine}.toml)")
            }
        }
    }
}
