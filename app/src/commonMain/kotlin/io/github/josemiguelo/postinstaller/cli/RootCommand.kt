package io.github.josemiguelo.postinstaller.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.UsageError
import com.github.ajalt.clikt.core.obj
import com.github.ajalt.clikt.parameters.options.default
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import io.github.josemiguelo.postinstaller.core.TOOL_VERSION
import io.github.josemiguelo.postinstaller.core.model.PackageManager
import okio.Path.Companion.toPath

class RootCommand : CliktCommand(name = "post-installer") {
    override fun help(context: Context) =
        "Set up a machine from a shared config repo and track installed program versions. v$TOOL_VERSION"

    private val repo by option(
        "--repo",
        envvar = "POST_INSTALLER_REPO",
        help = "Path to the config repo (default: \$POST_INSTALLER_REPO, then the current directory)",
    ).default(".")
    private val manifest by option(
        "--manifest",
        help = "Manifest file, relative to the repo root",
    ).default("manifest.toml")
    private val machine by option(
        "--machine",
        envvar = "POST_INSTALLER_MACHINE",
        help = "Machine name for state tracking (default: hostname)",
    )
    private val pm by option(
        "--pm",
        help = "Package manager to use (${PackageManager.entries.joinToString("|") { it.id }}); default: auto-detect",
    )
    private val verbose by option("-v", "--verbose", help = "Verbose output").flag()

    override fun run() {
        val repoRoot = repo.toPath()
        currentContext.obj = AppContext(
            repoRoot = repoRoot,
            manifestPath = repoRoot / manifest,
            machineOverride = machine,
            pmOverride = pm?.let {
                PackageManager.fromId(it) ?: throw UsageError("Unknown package manager: $it", "--pm")
            },
            verbose = verbose,
        )
    }
}
