package loadout

import com.github.ajalt.clikt.core.main
import com.github.ajalt.clikt.core.subcommands
import loadout.cli.AppContext
import loadout.cli.CheckCommand
import loadout.cli.DiffCommand
import loadout.cli.InitCommand
import loadout.cli.MaintainCommand
import loadout.cli.OutdatedCommand
import loadout.cli.RootCommand
import loadout.cli.RunCommand
import loadout.cli.SetupCommand
import loadout.cli.ShowCommand
import loadout.cli.StatusCommand
import loadout.cli.SyncCommand
import loadout.cli.TuiCommand
import loadout.core.engine.ResolutionException
import loadout.core.git.GitException
import loadout.core.manifest.ManifestException
import loadout.core.platform.envVar
import loadout.core.platform.isStdoutTty
import loadout.tui.runTui
import kotlin.system.exitProcess
import okio.Path.Companion.toPath

fun main(args: Array<String>) {
    try {
        // Bare invocation in a real terminal opens the dashboard; everything
        // else (args given, or stdout piped) goes through the CLI.
        if (args.isEmpty() && isStdoutTty()) {
            val repo = envVar("LOADOUT_REPO") ?: "."
            runTui(
                AppContext(
                    repoRoot = repo.toPath(),
                    manifestName = "manifest.toml",
                    machineOverride = envVar("LOADOUT_MACHINE"),
                    verbose = false,
                ),
            )
            return
        }

        RootCommand()
            .subcommands(
                StatusCommand(),
                ShowCommand(),
                SetupCommand(),
                OutdatedCommand(),
                CheckCommand(),
                MaintainCommand(),
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
