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
import loadout.core.manifest.ManifestLoader
import loadout.core.LoadoutException
import loadout.core.exec.InterruptedByUser
import loadout.core.platform.envVar
import loadout.core.platform.isStdoutTty
import loadout.core.platform.readKey
import loadout.core.platform.selfExecutable
import loadout.core.platform.takeInterrupt
import loadout.core.platform.terminalColumns
import loadout.core.platform.trapInterrupts
import loadout.core.platform.unameInfo
import loadout.tui.ALT_SCREEN_OFF
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
        help = "Root file, relative to the repo root",
    ).default(ManifestLoader.ROOT_FILE)
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
     *
     * Everything, commands included, happens on the alternate screen, so
     * quitting gives back the normal screen exactly as it was.
     */
    private fun home(app: AppContext) {
        try {
            homeLoop(app)
        } finally {
            print(ALT_SCREEN_OFF)
        }
    }

    private fun homeLoop(app: AppContext) {
        val screen = HomeScreen(app)
        while (true) {
            val closed = screen.show()
            val (command, args) = when (closed.action) {
                HomeAction.NONE, HomeAction.INSTALL_MISSING, HomeAction.RUN_SCRIPTS, HomeAction.APPLY_CONFIGS,
                HomeAction.REVIEW_OUTDATED, HomeAction.SHOW_DIFF -> return
                HomeAction.UPGRADE -> SelfUpgradeCommand() to emptyList()
                HomeAction.SYNC -> SyncCommand() to emptyList()
                HomeAction.SETUP -> SetupCommand() to emptyList()
                HomeAction.HAND_OFF -> closed.handoff?.let { commandFor(it) to argsFor(it) } ?: return
            }
            // A fresh window for the command, still on the alternate screen.
            print(CLEAR_SCREEN)
            if (screen.busy) echo(Style.dim("finishing the checks still running…"))
            screen.pause()
            // Rules frame the command's output; the top one names the exact
            // command (also how to run it by hand).
            echo(rule("loadout " + (listOf(command.commandName) + args).joinToString(" "), Style::accent))
            val transcript = transcriptFile()
            try {
                val code = handOff { runRecorded(app, command.commandName, args, transcript) }
                // The terminal echoed ^C where the cursor was: start the rule on a line of its own.
                if (code == INTERRUPTED) echo("")
                echo(
                    when (code) {
                        0 -> rule("✔ done", Style::ok)
                        INTERRUPTED -> rule("interrupted", Style::warn)
                        else -> rule("✘ exit $code", Style::error)
                    },
                )
                // Self-upgrade ends loadout: the binary on disk is now another version.
                val back = if (closed.action == HomeAction.UPGRADE) "enter quits" else "enter returns to loadout"
                val keys = Style.dim("$back · v views the full output · q quits")
                // One key, no Enter: Enter goes back, v views, q (or Ctrl-C,
                // or no terminal) quits; anything else is ignored.
                echo(keys)
                var quit: Boolean
                while (true) {
                    val key = readKey()
                    if (key == 'v' || key == 'V') {
                        viewTranscript(app, transcript)
                        echo(keys)
                        continue
                    }
                    quit = key == null || key == 'q' || key == 'Q' || key == '\u0003'
                    if (quit || key == '\r' || key == '\n') break
                }
                if (quit || closed.action == HomeAction.UPGRADE) {
                    if (code != 0) throw ProgramResult(code)
                    return
                }
                screen.resume(closed, ok = code == 0)
            } finally {
                // The output exists only while it's watched.
                app.fs.delete(transcript, mustExist = false)
            }
        }
    }

    /** Where a hand-off's output is recorded: the per-user runtime dir (Linux) or TMPDIR (macOS). */
    private fun transcriptFile(): okio.Path {
        val dir = (envVar("XDG_RUNTIME_DIR") ?: envVar("TMPDIR") ?: "/tmp").toPath()
        return dir / "loadout-handoff-${kotlin.random.Random.nextLong().toULong()}.log"
    }

    /**
     * [subcommand] as a child loadout under script(1) (see Recorded.kt),
     * recording into [transcript]. Pagers are off, so none takes over the
     * screen: one that did would leave the alternate screen on exit.
     */
    private fun runRecorded(app: AppContext, subcommand: String, args: List<String>, transcript: okio.Path): Int {
        val self = selfExecutable() ?: throw HandoffException("can't find loadout's own binary to run the command")
        val argv = buildList {
            add(self)
            add("--repo"); add(app.repoRoot.toString())
            add("--manifest"); add(app.manifestName)
            app.machineOverride?.let { add("--machine"); add(it) }
            if (app.verbose) add("-v")
            add(subcommand)
            addAll(args)
        }
        val script = recordCommand(argv, transcript.toString(), darwin = unameInfo().sysname == "Darwin")
        return app.runner.inherit("PAGER=cat GIT_PAGER=cat $script </dev/tty")
    }

    /** The whole recorded output in `less`, from the top, on this screen (-X keeps it off the normal one). */
    private fun viewTranscript(app: AppContext, transcript: okio.Path) {
        app.runner.inherit("awk ${shQuote(TRANSCRIPT_AWK)} ${shQuote(transcript.toString())} | less -RX")
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
        PaneKind.CONFIGS -> ApplyCommand()
        PaneKind.UPGRADE, PaneKind.LIST -> UpgradeCommand()
    }

    /** The pane already asked: skip the command's own confirmation. */
    private fun argsFor(handoff: Handoff): List<String> = when (handoff.kind) {
        PaneKind.INSTALL, PaneKind.UPGRADE, PaneKind.LIST -> handoff.args + "--yes"
        // `run` has no confirmation; --force runs a ticked script even when done.
        PaneKind.SCRIPTS -> handoff.args + "--force"
        // The screen already refused files edited here; never --force from it.
        PaneKind.CONFIGS -> handoff.args
    }
}

/** The exit a shell reports for a command stopped by Ctrl-C. */
private const val INTERRUPTED = 130

/** A hand-off that couldn't start. */
class HandoffException(message: String) : LoadoutException(message)

/** A heavy rule across the terminal with [label] in it: `━━ label ━━━━…`. */
private fun rule(label: String, color: (String) -> String): String {
    val head = "━━ $label "
    val width = terminalColumns() ?: 80
    return color(head + "━".repeat((width - head.length).coerceAtLeast(3)))
}
