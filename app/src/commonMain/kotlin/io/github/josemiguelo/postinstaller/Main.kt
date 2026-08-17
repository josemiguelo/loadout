package io.github.josemiguelo.postinstaller

import com.github.ajalt.clikt.core.main
import com.github.ajalt.clikt.core.subcommands
import io.github.josemiguelo.postinstaller.cli.AppContext
import io.github.josemiguelo.postinstaller.cli.DiffCommand
import io.github.josemiguelo.postinstaller.cli.InitCommand
import io.github.josemiguelo.postinstaller.cli.InstallCommand
import io.github.josemiguelo.postinstaller.cli.RootCommand
import io.github.josemiguelo.postinstaller.cli.RunCommand
import io.github.josemiguelo.postinstaller.cli.StatusCommand
import io.github.josemiguelo.postinstaller.cli.SyncCommand
import io.github.josemiguelo.postinstaller.cli.TuiCommand
import io.github.josemiguelo.postinstaller.core.engine.ResolutionException
import io.github.josemiguelo.postinstaller.core.git.GitException
import io.github.josemiguelo.postinstaller.core.manifest.ManifestException
import io.github.josemiguelo.postinstaller.core.platform.envVar
import io.github.josemiguelo.postinstaller.core.platform.isStdoutTty
import io.github.josemiguelo.postinstaller.tui.runTui
import kotlin.system.exitProcess
import okio.Path.Companion.toPath

fun main(args: Array<String>) {
    try {
        // Bare invocation in a real terminal opens the dashboard; everything
        // else (args given, or stdout piped) goes through the CLI.
        if (args.isEmpty() && isStdoutTty()) {
            val repo = envVar("POST_INSTALLER_REPO") ?: "."
            runTui(
                AppContext(
                    repoRoot = repo.toPath(),
                    manifestName = "manifest.toml",
                    machineOverride = envVar("POST_INSTALLER_MACHINE"),
                    verbose = false,
                ),
            )
            return
        }

        RootCommand()
            .subcommands(
                StatusCommand(),
                InstallCommand(),
                RunCommand(),
                DiffCommand(),
                SyncCommand(),
                InitCommand(),
                TuiCommand(),
            )
            .main(args)
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
