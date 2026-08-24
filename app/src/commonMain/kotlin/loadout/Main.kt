package loadout

import com.github.ajalt.clikt.core.main
import com.github.ajalt.clikt.core.subcommands
import loadout.cli.AppContext
import loadout.cli.DiffCommand
import loadout.cli.ExplainCommand
import loadout.cli.InitCommand
import loadout.cli.MaintainCommand
import loadout.cli.OutdatedCommand
import loadout.cli.RootCommand
import loadout.cli.RunCommand
import loadout.cli.SetupCommand
import loadout.cli.StatusCommand
import loadout.cli.SyncCommand
import loadout.cli.UpgradeCommand
import loadout.core.engine.ResolutionException
import loadout.core.git.GitException
import loadout.core.manifest.ManifestException
import kotlin.system.exitProcess

fun main(args: Array<String>) {
    try {
        RootCommand()
            .subcommands(
                StatusCommand(),
                ExplainCommand(),
                SetupCommand(),
                OutdatedCommand(),
                MaintainCommand(),
                RunCommand(),
                DiffCommand(),
                SyncCommand(),
                UpgradeCommand(),
                InitCommand(),
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
