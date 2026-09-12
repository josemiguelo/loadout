package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import loadout.core.INSTALL_COMMAND
import loadout.core.TOOL_VERSION

class SelfUpgradeCommand : CliktCommand(name = "self-upgrade") {
    override fun help(context: Context) = commandHelp(
        "Replace the loadout binary with the latest release. Needs no config repo, so it works even under a min-tool-version refusal (`upgrade` is for programs).",
    )

    private val app by requireObject<AppContext>()

    override fun run() {
        echo("current: v$TOOL_VERSION — installing the latest release…")
        val exit = app.runner.inherit(INSTALL_COMMAND)
        if (exit != 0) throw ProgramResult(exit)
    }
}
