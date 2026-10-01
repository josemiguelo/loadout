package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.obj
import com.github.ajalt.clikt.parameters.options.default
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.context
import com.github.ajalt.clikt.parameters.options.versionOption
import loadout.core.LoadoutException
import loadout.core.exec.InterruptedByUser
import loadout.core.platform.isStdoutTty
import loadout.core.platform.takeInterrupt
import loadout.core.platform.terminalColumns
import loadout.core.platform.trapInterrupts
import loadout.tui.CLEAR_SCREEN
import loadout.tui.Handoff
import loadout.tui.HomeAction
import loadout.tui.HomeScreen
import loadout.tui.PaneKind
import com.github.ajalt.clikt.core.terminal
import com.github.ajalt.mordant.terminal.Terminal
import loadout.core.TOOL_VERSION
import okio.Path.Companion.toPath

class RootCommand : CliktCommand(name = "loadout") {
    // The home screen is the bare invocation; every subcommand still runs
    // normally, and a pipe still gets help.
    override val invokeWithoutSubcommand = true

    init {
        versionOption(TOOL_VERSION, names = setOf("--version", "-V"))
        context {
            terminal = Terminal(theme = Style.cliktTheme())
            helpFormatter = { LoadoutHelpFormatter(it) }
        }
    }

    override fun help(context: Context) =
        "Set up a machine from a shared config repo and track installed program versions. v$TOOL_VERSION"

    private val repo by option(
        "--repo",
        envvar = "LOADOUT_REPO",
        help = "Path to the config repo (default: \$LOADOUT_REPO, then the current directory)",
    ).default(".")
    private val manifest by option(
        "--manifest",
        help = "Manifest file, relative to the repo root",
    ).default("manifest.toml")
    private val machine by option(
        "--machine",
        envvar = "LOADOUT_MACHINE",
        help = "Machine name for state tracking (default: hostname)",
    )
    private val verbose by option("-v", "--verbose", help = "Verbose output").flag()

    override fun run() {
        val app = AppContext(
            repoRoot = repo.toPath(),
            manifestName = manifest,
            machineOverride = machine,
            verbose = verbose,
        )
        currentContext.obj = app
        if (currentContext.invokedSubcommand != null) return
        if (!isStdoutTty()) {
            echoFormattedHelp()
            return
        }
        home(app)
    }

    /**
     * Show the home screen, run what the user chose on the real terminal,
     * then show the same screen again (HomeScreen keeps one model). Nothing
     * runs inside the screen: sudo, `gum confirm` and pagers need the
     * keyboard. Ends on q, or after self-upgrade (the binary on disk is then
     * a different version).
     */
    private fun home(app: AppContext) {
        val screen = HomeScreen(app)
        while (true) {
            val closed = screen.show()
            if (closed.action == HomeAction.UPGRADE) {
                screen.pause()
                val code = dispatch(SelfUpgradeCommand(), app)
                echo("")
                echo(Style.dim("`loadout` opens the new version's screen."))
                if (code != 0) throw ProgramResult(code)
                return
            }
            val (command, args) = when (closed.action) {
                HomeAction.NONE, HomeAction.INSTALL_MISSING, HomeAction.RUN_SCRIPTS,
                HomeAction.REVIEW_OUTDATED, HomeAction.SHOW_DIFF, HomeAction.UPGRADE -> return
                HomeAction.SYNC -> SyncCommand() to emptyList()
                HomeAction.SETUP -> SetupCommand() to emptyList()
                HomeAction.HAND_OFF -> closed.handoff?.let { commandFor(it) to argsFor(it) } ?: return
            }
            // The command gets a fresh window on the normal screen; the home
            // screen (alternate screen) covers it again on return.
            print(CLEAR_SCREEN)
            if (screen.busy) echo(Style.dim("finishing the checks still running…"))
            screen.pause()
            // Rules frame the command's output; the top one names the exact
            // command (also how to run it by hand).
            echo(rule("loadout " + (listOf(command.commandName) + args).joinToString(" "), Style::accent))
            val code = handOff { dispatch(command, app, args) }
            echo(
                when (code) {
                    0 -> rule("✔ done", Style::ok)
                    INTERRUPTED -> rule("interrupted", Style::warn)
                    else -> rule("✘ exit $code", Style::error)
                },
            )
            echo(Style.dim("enter returns to loadout, q quits"))
            val answer = readlnOrNull()?.trim()
            if (answer == null || answer.equals("q", ignoreCase = true)) {
                if (code != 0) throw ProgramResult(code)
                return
            }
            screen.resume(closed, ok = code == 0)
        }
    }

    /**
     * Run [command] on the real terminal and return its exit code. Ctrl-C
     * and errors (LoadoutException, okio's IOException) end the command,
     * not loadout.
     */
    private fun handOff(command: () -> Int): Int {
        trapInterrupts(true)
        return try {
            command()
        } catch (e: InterruptedByUser) {
            INTERRUPTED
        } catch (e: LoadoutException) {
            echo(Style.error("error: ") + (e.message ?: ""))
            1
        } catch (e: okio.IOException) {
            // e.g. an unwritable state file.
            echo(Style.error("error: ") + (e.message ?: ""))
            1
        } finally {
            trapInterrupts(false)
            // Drop a Ctrl-C that arrived after the last child exited.
            takeInterrupt()
        }
    }

    private fun commandFor(handoff: Handoff): CliktCommand = when (handoff.kind) {
        PaneKind.INSTALL -> InstallCommand()
        PaneKind.SCRIPTS -> RunCommand()
        PaneKind.UPGRADE, PaneKind.LIST -> UpgradeCommand()
    }

    /** The pane already asked: skip the command's own confirmation. */
    private fun argsFor(handoff: Handoff): List<String> = when (handoff.kind) {
        PaneKind.INSTALL, PaneKind.UPGRADE, PaneKind.LIST -> handoff.args + "--yes"
        // `run` has no confirmation; --force runs a ticked script even when done.
        PaneKind.SCRIPTS -> handoff.args + "--force"
    }
}

/** The exit a shell reports for a command stopped by Ctrl-C. */
private const val INTERRUPTED = 130

/** A heavy rule across the terminal with [label] in it: `━━ label ━━━━…`. */
private fun rule(label: String, color: (String) -> String): String {
    val head = "━━ $label "
    val width = terminalColumns() ?: 80
    return color(head + "━".repeat((width - head.length).coerceAtLeast(3)))
}
