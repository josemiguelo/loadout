package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import loadout.core.platform.isStdoutTty
import loadout.tui.runTui

class TuiCommand : CliktCommand(name = "tui") {
    override fun help(context: Context) = "Open the interactive dashboard (requires a real terminal)"

    private val app by requireObject<AppContext>()

    override fun run() {
        if (!isStdoutTty()) {
            echo("error: the TUI needs a terminal (stdout is not a TTY)")
            throw ProgramResult(1)
        }
        runTui(app)
    }
}
