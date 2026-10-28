package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.INSTALL_COMMAND
import loadout.core.LoadoutException
import loadout.core.TOOL_VERSION
import loadout.core.engine.ConfigException
import loadout.core.git.GitClient
import loadout.core.git.GitException
import loadout.core.manifest.ChezmoiData
import loadout.core.manifest.LockFile
import loadout.core.manifest.ManifestLoader
import loadout.core.manifest.ToolTooOldException
import loadout.core.model.MachineState
import loadout.core.model.ProgramStatus
import loadout.core.model.ScriptStatus
import loadout.core.platform.envVar
import loadout.core.platform.selfExecutable
import loadout.core.versionAtLeast

class SyncCommand : CliktCommand(name = "sync") {
    override fun help(context: Context) = commandHelp(
        "Pull the config repo, apply its configs, refresh this machine's state, commit only its state file, push. " +
            "When the pulled repo needs a newer loadout, upgrade loadout first and carry on with it. " +
            "A child repo pulls its parent first (never commits or pushes it), and recompiles itself when the " +
            "parent's manifests changed, committing the lock with the state.",
        "--no-push       commit locally, don't push",
        "-m, --message   override the commit message",
    )

    private val noPush by option("--no-push", help = "Commit locally but don't push").flag()
    private val message by option("-m", "--message", help = "Commit message")

    private val app by requireObject<AppContext>()

    override fun run() {
        val git = GitClient(app.runner, app.repoRoot)
        if (!git.isRepo()) {
            throw GitException("${app.repoRoot} is not a git repository (run `loadout init` or `git init` first)")
        }

        // A child repo (contract 18): the parent is pulled, nothing more. A
        // lock this loadout can't read yet waits for the upgrade below, whose
        // sync pulls it.
        val parentRoot = try {
            app.parentRoot
        } catch (e: ToolTooOldException) {
            null
        }
        parentRoot?.let { root ->
            val parent = GitClient(app.runner, root)
            if (parent.isRepo() && parent.hasUpstream()) {
                spinning("pulling parent ${app.layout.parent?.name}…") { parent.pullRebase() }
            }
        }

        val hasUpstream = git.hasUpstream()
        if (hasUpstream) {
            spinning("pulling latest changes…") { git.pullRebase() }
        } else {
            echo(Style.dim("No upstream configured; skipping pull."))
        }

        // A parent whose manifests moved needs the child compiled against them;
        // a compile that fails stops here with what Gradle said.
        // It reads the lock, so a repo that now needs a newer loadout says so here first.
        val compiledNow = try {
            ManifestLoader.parentChanged(app.fs, app.repoRoot)
        } catch (e: ToolTooOldException) {
            upgradeAndSyncAgain(e, recompiled = false)
            return
        }
        if (compiledNow) {
            echo(" " + Style.warn("↻") + "  parent ${app.layout.parent?.name} changed: compiling")
            compileRepo(app)
        }
        // A sync an upgrade started finds the lock already compiled by the
        // sync before it, and still commits it.
        val recompiled = compiledNow || envVar(RECOMPILED) != null

        // Load after pulling so we see the latest manifest, and read the
        // layout again: the pull or the compile can rename its folders.
        app.reloadLayout()
        val manifest = try {
            app.loadManifest()
        } catch (e: ToolTooOldException) {
            upgradeAndSyncAgain(e, recompiled)
            return
        }
        val system = app.detectSystem()
        // Configs land before the refresh, so the state committed is what
        // this machine has after the pull. A file edited here stops the sync
        // before anything is written: only the user knows which version wins.
        app.configs?.let { configs ->
            refuseEdited(configs)
            val result = spinning("applying configs…") { app.runner.capture(configs.applyCommand(null, force = false)) }
            if (!result.success) {
                val line = (result.stderr.lineSequence() + result.stdout.lineSequence()).firstOrNull { it.isNotBlank() }
                throw ConfigException("chezmoi apply failed" + (line?.let { ": ${it.trim()}" } ?: " (exit ${result.exitCode})"))
            }
            echo(" " + Style.ok("✔") + "  configs applied")
        }
        val state = spinning(Style.dim("refreshing state for ") + Style.machine(system.machine)) {
            app.refreshAndWriteState(manifest, system)
        }
        leftToDo(state)?.let { echo(" " + Style.warn("⚠") + "  " + Style.warn(it) + Style.dim("  (run: loadout)")) }

        val statePath = "${app.layout.state}/${system.machine}.json"
        // A recompile's lock (and the templates' data beside the configs) goes with the state.
        val compiled = if (recompiled) {
            listOf(LockFile.NAME) + manifest.layout.configs?.let { ChezmoiData.files(manifest, it).keys }.orEmpty()
        } else {
            emptyList()
        }
        val defaultMessage = if (recompiled) {
            "${system.machine}: compile against parent ${app.layout.parent?.name}, update state"
        } else {
            "${system.machine}: update state"
        }
        val committed = git.addCommit(compiled + statePath, message ?: defaultMessage)
        if (!committed) {
            echo(" " + Style.ok("\u2714") + "  state unchanged; nothing to commit")
            return
        }
        echo(" " + Style.ok("\u2714") + "  committed " + (compiled + statePath).joinToString(", "))

        when {
            noPush -> echo(Style.dim("Skipping push (--no-push)."))
            !hasUpstream -> echo("No upstream configured; not pushing. Add a remote and run `git push -u`.")
            else -> {
                spinning("pushing…") { git.push() }
                echo(" " + Style.ok("\u2714") + "  pushed")
            }
        }
    }

    /**
     * The pulled repo needs a newer loadout: install the latest release, then
     * run this same sync with it. The second run pulls again (nothing new)
     * and carries on; [UPGRADED] keeps it from upgrading a second time when
     * the binary it runs is still too old (one self-upgrade didn't replace).
     */
    /** [recompiled]: this sync compiled the lock, so the one it starts commits it. */
    private fun upgradeAndSyncAgain(refusal: ToolTooOldException, recompiled: Boolean) {
        if (envVar(UPGRADED) != null) {
            throw SyncException(
                "loadout was upgraded, but ${selfExecutable() ?: "this binary"} is still $TOOL_VERSION; " +
                    "this config repo requires loadout >= ${refusal.required}",
            )
        }
        val latest = SelfVersion.latest(app.runner, app.fs, cached = false)
        if (latest != null && !versionAtLeast(latest, refusal.required)) {
            throw SyncException(
                "this config repo requires loadout >= ${refusal.required}, but the latest release is $latest",
            )
        }
        // Read before the install replaces the file: Linux then names it "(deleted)".
        val self = selfExecutable() ?: throw SyncException("can't find loadout's own binary to run the sync again")
        echo(" " + Style.warn("↑") + "  this config repo now needs loadout >= ${refusal.required} (you have $TOOL_VERSION): upgrading")
        val installed = app.runner.inherit(INSTALL_COMMAND)
        if (installed != 0) throw ProgramResult(installed)
        echo(" " + Style.ok("✔") + "  loadout upgraded; syncing with it")
        val argv = buildList {
            add(self)
            add("--repo"); add(app.repoRoot.toString())
            app.machineOverride?.let { add("--machine"); add(it) }
            if (app.verbose) add("-v")
            add(commandName)
            if (noPush) add("--no-push")
            message?.let { add("--message"); add(it) }
        }
        val env = "$UPGRADED=1 " + if (recompiled) "$RECOMPILED=1 " else ""
        val exit = app.runner.inherit(env + argv.joinToString(" ") { shQuote(it) })
        if (exit != 0) throw ProgramResult(exit)
    }

    /** What this machine still lacks after the sync, or null when nothing. */
    private fun leftToDo(state: MachineState): String? {
        val missing = state.programs.values.count { it.status == ProgramStatus.MISSING }
        val scripts = state.scripts.values.count { it.status != ScriptStatus.DONE }
        val parts = listOfNotNull(
            missing.takeIf { it > 0 }?.let { "$it ${if (it == 1) "program" else "programs"} missing" },
            scripts.takeIf { it > 0 }?.let { "$it ${if (it == 1) "script" else "scripts"} not done" },
        )
        return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    private companion object {
        /** Set on the sync an upgrade starts. */
        const val UPGRADED = "LOADOUT_SYNC_UPGRADED"

        /** Set on the sync an upgrade starts when the sync before it compiled the lock. */
        const val RECOMPILED = "LOADOUT_SYNC_RECOMPILED"
    }
}

/** A sync that couldn't carry on after the pulled repo needed a newer loadout. */
class SyncException(message: String) : LoadoutException(message)
