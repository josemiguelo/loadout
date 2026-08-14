package io.github.josemiguelo.postinstaller

import com.github.ajalt.clikt.core.main
import com.github.ajalt.clikt.core.subcommands
import io.github.josemiguelo.postinstaller.cli.RootCommand
import io.github.josemiguelo.postinstaller.cli.StatusCommand
import io.github.josemiguelo.postinstaller.core.manifest.ManifestException
import kotlin.system.exitProcess

fun main(args: Array<String>) {
    val command = RootCommand()
        .subcommands(
            StatusCommand(),
        )
    try {
        command.main(args)
    } catch (e: ManifestException) {
        println("error: ${e.message}")
        exitProcess(1)
    } catch (e: okio.IOException) {
        println("error: ${e.message}")
        exitProcess(1)
    }
}
