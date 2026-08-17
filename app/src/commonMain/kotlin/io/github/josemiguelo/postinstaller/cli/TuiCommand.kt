package io.github.josemiguelo.postinstaller.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import io.github.josemiguelo.postinstaller.core.platform.isStdoutTty
import io.github.josemiguelo.postinstaller.tui.runTui

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
