package loadout

import com.github.ajalt.clikt.core.main
import com.github.ajalt.clikt.core.subcommands
import loadout.cli.AppContext
import loadout.cli.DiffCommand
import loadout.cli.ExplainCommand
import loadout.cli.InitCommand
import loadout.cli.InstallCommand
import loadout.cli.InstallersCommand
import loadout.cli.MaintainCommand
import loadout.cli.OutdatedCommand
import loadout.cli.RootCommand
import loadout.cli.RunCommand
import loadout.cli.SetupCommand
import loadout.cli.StatusCommand
import loadout.cli.SyncCommand
import loadout.cli.UpgradeCommand
import loadout.core.LoadoutException
import kotlin.system.exitProcess

fun main(args: Array<String>) {
    try {
        RootCommand()
            .subcommands(
                StatusCommand(),
                ExplainCommand(),
                InstallersCommand(),
                SetupCommand(),
                InstallCommand(),
                OutdatedCommand(),
                MaintainCommand(),
                RunCommand(),
                DiffCommand(),
                SyncCommand(),
                UpgradeCommand(),
                InitCommand(),
            )
            .main(args)
        // Every loadout refusal is a LoadoutException, so a new failure mode
        // reports cleanly without anyone remembering to add a catch here.
    } catch (e: LoadoutException) {
        println("error: ${e.message}")
        exitProcess(1)
    } catch (e: okio.IOException) {
        // Not ours: a missing/unreadable file surfacing from Okio.
        println("error: ${e.message}")
        exitProcess(1)
    }
}
