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
import loadout.core.platform.isStdoutTty
import loadout.tui.HomeAction
import loadout.tui.runHomeTui
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
     * Render the home screen, then hand the terminal to whatever the user
     * chose. One TUI per invocation: Mosaic binds the tty once per process
     * ("Tty already bound"), so the screen cannot reopen afterwards and the
     * picker (another Mosaic app) cannot be an action — "run what's pending"
     * dispatches `run --pending`, which does exactly that set. Upgrades are
     * the exception: they stream INSIDE the screen's floating pane, because
     * they never prompt.
     */
    private fun home(app: AppContext) {
        val code = when (runHomeTui(app)) {
            HomeAction.NONE -> return
            HomeAction.RUN_PENDING -> dispatch(RunCommand(), app, listOf("--pending"))
            HomeAction.INSTALL_MISSING -> dispatch(InstallCommand(), app, listOf("--all"))
            HomeAction.REVIEW_OUTDATED -> dispatch(OutdatedCommand(), app)
            HomeAction.SHOW_DIFF -> dispatch(DiffCommand(), app)
            HomeAction.SYNC -> dispatch(SyncCommand(), app)
            HomeAction.UPGRADE -> dispatch(SelfUpgradeCommand(), app)
            HomeAction.SETUP -> dispatch(SetupCommand(), app)
        }
        echo("")
        echo(Style.dim("`loadout` opens this screen again."))
        if (code != 0) throw ProgramResult(code)
    }
}
