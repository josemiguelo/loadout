package loadout

import com.github.ajalt.clikt.core.main
import com.github.ajalt.clikt.core.subcommands
import loadout.cli.AppContext
import loadout.cli.ApplyCommand
import loadout.cli.DiffCommand
import loadout.cli.ExplainCommand
import loadout.cli.InitCommand
import loadout.cli.InstallCommand
import loadout.cli.InstallersCommand
import loadout.cli.OutdatedCommand
import loadout.cli.RootCommand
import loadout.cli.RunCommand
import loadout.cli.SetupCommand
import loadout.cli.StatusCommand
import loadout.cli.SyncCommand
import loadout.cli.SelfUpgradeCommand
import loadout.cli.UpgradeCommand
import loadout.core.LoadoutException
import loadout.core.exec.InterruptedByUser
import loadout.core.platform.envVar
import loadout.core.platform.trapInterrupts
import loadout.theme.forcedDark
import kotlin.system.exitProcess

fun main(args: Array<String>) {
    try {
        // Checked HERE, not where it is used: the palette is chosen inside
        // `object Style`'s initializer, and Kotlin/Native wraps a throw from
        // one of those in FileFailedToInitializeException — not a
        // LoadoutException, so it escapes the catch below as a stack trace.
        forcedDark(envVar("LOADOUT_THEME"))
        // A home-screen hand-off's child (see Recorded.kt) takes Ctrl-C here, on
        // the terminal it shares with its command: it stops and exits 130, the
        // exit the hand-off reads as "interrupted", whatever the script(1) in between.
        if (envVar("LOADOUT_HANDOFF") == "1") trapInterrupts(true)
        RootCommand()
            .subcommands(
                StatusCommand(),
                ExplainCommand(),
                InstallersCommand(),
                SetupCommand(),
                InstallCommand(),
                OutdatedCommand(),
                RunCommand(),
                ApplyCommand(),
                DiffCommand(),
                SyncCommand(),
                UpgradeCommand(),
                SelfUpgradeCommand(),
                InitCommand(),
            )
            .main(args)
        // Every loadout refusal is a LoadoutException, so a new failure mode
        // reports cleanly without anyone remembering to add a catch here.
    } catch (e: InterruptedByUser) {
        exitProcess(INTERRUPTED)
    } catch (e: LoadoutException) {
        println("error: ${e.message}")
        exitProcess(1)
    } catch (e: okio.IOException) {
        // Not ours: a missing/unreadable file surfacing from Okio.
        println("error: ${e.message}")
        exitProcess(1)
    }
}

/** The exit a shell reports for a command stopped by Ctrl-C (128 + SIGINT). */
private const val INTERRUPTED = 130
