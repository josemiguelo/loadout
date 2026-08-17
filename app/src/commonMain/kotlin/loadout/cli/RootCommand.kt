package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.obj
import com.github.ajalt.clikt.parameters.options.default
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.TOOL_VERSION
import okio.Path.Companion.toPath

class RootCommand : CliktCommand(name = "loadout") {
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
        currentContext.obj = AppContext(
            repoRoot = repo.toPath(),
            manifestName = manifest,
            machineOverride = machine,
            verbose = verbose,
        )
    }
}
