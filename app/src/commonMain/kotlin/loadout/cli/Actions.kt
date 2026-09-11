package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.CliktError
import com.github.ajalt.clikt.core.context
import com.github.ajalt.clikt.core.obj
import com.github.ajalt.clikt.core.parse

/**
 * Run a subcommand in-process, as if it had been typed. The home screen
 * dispatches through this: it decides WHAT to do and the existing command
 * does it, so no action path exists twice.
 */
internal fun dispatch(command: CliktCommand, app: AppContext, args: List<String> = emptyList()): Int =
    try {
        command.context { obj = app }.parse(args)
        0
    } catch (e: CliktError) {
        e.message?.let { if (it.isNotBlank()) println(it) }
        e.statusCode
    }
