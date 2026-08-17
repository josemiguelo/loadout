package io.github.josemiguelo.postinstaller

import com.github.ajalt.clikt.core.main
import com.github.ajalt.clikt.core.subcommands
import io.github.josemiguelo.postinstaller.cli.DiffCommand
import io.github.josemiguelo.postinstaller.cli.InitCommand
import io.github.josemiguelo.postinstaller.cli.InstallCommand
import io.github.josemiguelo.postinstaller.cli.RootCommand
import io.github.josemiguelo.postinstaller.cli.RunCommand
import io.github.josemiguelo.postinstaller.cli.StatusCommand
import io.github.josemiguelo.postinstaller.cli.SyncCommand
import io.github.josemiguelo.postinstaller.core.engine.ResolutionException
import io.github.josemiguelo.postinstaller.core.git.GitException
import io.github.josemiguelo.postinstaller.core.manifest.ManifestException
import kotlin.system.exitProcess

fun main(args: Array<String>) {
    val command = RootCommand()
        .subcommands(
            StatusCommand(),
            InstallCommand(),
            RunCommand(),
            DiffCommand(),
            SyncCommand(),
            InitCommand(),
        )
    try {
        command.main(args)
    } catch (e: ManifestException) {
        println("error: ${e.message}")
        exitProcess(1)
    } catch (e: ResolutionException) {
        println("error: ${e.message}")
        exitProcess(1)
    } catch (e: GitException) {
        println("error: ${e.message}")
        exitProcess(1)
    } catch (e: okio.IOException) {
        println("error: ${e.message}")
        exitProcess(1)
    }
}
