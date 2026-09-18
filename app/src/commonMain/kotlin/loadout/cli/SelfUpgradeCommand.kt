package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import loadout.core.INSTALL_COMMAND
import loadout.core.TOOL_VERSION
import loadout.core.manifest.ManifestLoader

class SelfUpgradeCommand : CliktCommand(name = "self-upgrade") {
    override fun help(context: Context) = commandHelp(
        "Replace the loadout binary with the latest release. Needs no config repo, so it works even under a min-tool-version refusal (`upgrade` is for programs).",
    )

    private val app by requireObject<AppContext>()

    override fun run() {
        val latest = SelfVersion.latest(app.runner, app.fs, cached = false)
        if (latest != null && ManifestLoader.versionAtLeast(TOOL_VERSION, latest)) {
            echo("already on the latest release (v$TOOL_VERSION)")
            return
        }
        echo("current: v$TOOL_VERSION — installing ${latest?.let { "v$it" } ?: "the latest release"}…")
        val exit = app.runner.inherit(INSTALL_COMMAND)
        if (exit != 0) throw ProgramResult(exit)
    }
}
