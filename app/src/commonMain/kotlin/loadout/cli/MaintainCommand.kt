package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.UsageError
import com.github.ajalt.clikt.core.requireObject
import loadout.core.platform.isStdoutTty
import loadout.tui.runMaintainTui

class MaintainCommand : CliktCommand(name = "maintain") {
    override fun help(context: Context) =
        "Interactively pick this machine's scripts and run them, watching each " +
            "one's output live (each script's check decides the resulting status)"

    private val app by requireObject<AppContext>()

    override fun run() {
        if (!isStdoutTty()) {
            throw UsageError("maintain is interactive — run it in a terminal (use `loadout run <name>` to script it)")
        }
        val code = runMaintainTui(app)
        if (code != 0) throw ProgramResult(code)
    }
}
