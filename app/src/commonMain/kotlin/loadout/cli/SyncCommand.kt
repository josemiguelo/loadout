package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.git.GitClient
import loadout.core.git.GitException

class SyncCommand : CliktCommand(name = "sync") {
    override fun help(context: Context) = commandHelp(
        "Pull the config repo, refresh this machine's state, commit only state/<machine>.json, push.",
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
            echo(Style.dim("Pulling latest changes..."))
            git.pullRebase()
        } else {
            echo(Style.dim("No upstream configured; skipping pull."))
        }

        // Load after pulling so we see the latest manifest.
        val manifest = app.loadManifest()
        val system = app.detectSystem()
        echo(Style.dim("Refreshing state for ") + Style.machine(system.machine) + Style.dim("..."))
        kotlinx.coroutines.runBlocking { app.refreshAndWriteState(manifest, system) }

        val statePath = "state/${system.machine}.json"
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
                git.push()
                echo(" " + Style.ok("\u2714") + "  pushed")
            }
        }
    }
}
