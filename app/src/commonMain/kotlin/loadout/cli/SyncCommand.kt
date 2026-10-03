package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.engine.ConfigException
import loadout.core.git.GitClient
import loadout.core.git.GitException

class SyncCommand : CliktCommand(name = "sync") {
    override fun help(context: Context) = commandHelp(
        "Pull the config repo, apply its configs, refresh this machine's state, commit only its state file, push.",
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

        val hasUpstream = git.hasUpstream()
        if (hasUpstream) {
            spinning("pulling latest changes…") { git.pullRebase() }
        } else {
            echo(Style.dim("No upstream configured; skipping pull."))
        }

        // Load after pulling so we see the latest manifest.
        val manifest = app.loadManifest()
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
        spinning(Style.dim("refreshing state for ") + Style.machine(system.machine)) {
            app.refreshAndWriteState(manifest, system)
        }

        val statePath = "${app.layout.state}/${system.machine}.json"
        val committed = git.addCommit(statePath, message ?: "${system.machine}: update state")
        if (!committed) {
            echo(" " + Style.ok("\u2714") + "  state unchanged; nothing to commit")
            return
        }
        echo(" " + Style.ok("\u2714") + "  committed $statePath")

        when {
            noPush -> echo(Style.dim("Skipping push (--no-push)."))
            !hasUpstream -> echo("No upstream configured; not pushing. Add a remote and run `git push -u`.")
            else -> {
                spinning("pushing…") { git.push() }
                echo(" " + Style.ok("\u2714") + "  pushed")
            }
        }
    }
}
