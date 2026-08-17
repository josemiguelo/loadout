package io.github.josemiguelo.postinstaller.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import io.github.josemiguelo.postinstaller.core.git.GitClient
import io.github.josemiguelo.postinstaller.core.git.GitException

class SyncCommand : CliktCommand(name = "sync") {
    override fun help(context: Context) =
        "Pull the config repo, refresh this machine's state file, and commit & push it"

    private val noPush by option("--no-push", help = "Commit locally but don't push").flag()
    private val message by option("-m", "--message", help = "Commit message")

    private val app by requireObject<AppContext>()

    override fun run() {
        val git = GitClient(app.runner, app.repoRoot)
        if (!git.isRepo()) {
            throw GitException("${app.repoRoot} is not a git repository (run `post-installer init` or `git init` first)")
        }

        val hasUpstream = git.hasUpstream()
        if (hasUpstream) {
            echo("Pulling latest changes...")
            git.pullRebase()
        } else {
            echo("No upstream configured; skipping pull.")
        }

        // Load after pulling so we see the latest manifest.
        val manifest = app.loadManifest()
        val system = app.detectSystem()
        echo("Refreshing state for ${system.machine}...")
        app.refreshAndWriteState(manifest, system)

        val statePath = "state/${system.machine}.json"
        val committed = git.addCommit(statePath, message ?: "${system.machine}: update state")
        if (!committed) {
            echo("State unchanged; nothing to commit.")
            return
        }
        echo("Committed $statePath.")

        when {
            noPush -> echo("Skipping push (--no-push).")
            !hasUpstream -> echo("No upstream configured; not pushing. Add a remote and run `git push -u`.")
            else -> {
                git.push()
                echo("Pushed.")
            }
        }
    }
}
