package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.UsageError
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.optional
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.manifest.InstallerLibrary

/**
 * What `via = ["dnf"]` actually means. Installers ship with loadout and are
 * merged under the repo's own, so this is where you see which definition
 * won — and `--eject` copies the built-ins into the repo when you want to
 * own them.
 */
class InstallersCommand : CliktCommand(name = "installers") {
    override fun help(context: Context) = commandHelp(
        "Show the install mechanisms available to this repo: loadout's built-ins plus your own.",
        "[name]     print one installer's full definition",
        "--eject    write the built-ins to manifest.d/00_installers.toml so the repo owns them",
        "--force    overwrite that file if it already exists",
    )

    private val name by argument(name = "name", help = "Installer to describe").optional()
    private val eject by option("--eject", help = "Copy the built-in installers into the repo").flag()
    private val force by option("--force", help = "Overwrite an existing 00_installers.toml").flag()

    private val app by requireObject<AppContext>()

    override fun run() {
        if (eject && name != null) throw UsageError("Give an installer name or --eject, not both")
        if (eject) return ejectLibrary()

        val manifest = app.loadManifest()
        // Style AFTER padding — escape codes would break the column width.
        fun source(key: String, width: Int = 0) =
            if (key in manifest.builtinInstallers) {
                Style.dim("built-in".padEnd(width))
            } else {
                Style.machine("repo".padEnd(width))
            }

        val single = name
        if (single != null) {
            val installer = manifest.installers[single]
                ?: throw UsageError("Unknown installer '$single' (see: loadout installers)")
            echo(Style.header("installer ") + Style.bold(single) + "  " + source(single))
            val rows = listOfNotNull(
                installer.probe?.let { "probe" to it },
                installer.params.takeIf { it.isNotEmpty() }?.let { "params" to it.joinToString() },
                installer.install?.let { "install" to it },
                installer.check?.let { "check" to it },
                installer.regex?.let { "regex" to it },
                installer.outdated?.let { "outdated" to it },
                installer.outdatedAll?.let { "outdated-all" to it },
            )
            val width = rows.maxOf { it.first.length }
            for ((label, value) in rows) echo("  " + Style.dim(label.padEnd(width)) + "  $value")
            return
        }

        val names = manifest.installers.keys.sorted()
        if (names.isEmpty()) {
            echo("No installers.")
            return
        }
        val nameWidth = (names.map { it.length } + 9).max() + 2
        echo(Style.header("  " + "INSTALLER".padEnd(nameWidth) + "SOURCE    INSTALL"))
        for (key in names) {
            val installer = manifest.installers.getValue(key)
            echo(
                "  " + key.padEnd(nameWidth) + source(key, 10) +
                    Style.dim(installer.install ?: "(no install command)"),
            )
        }
        echo("")
        echo(Style.dim("  A repo [installers.<name>] replaces the built-in of that name."))
    }

    private fun ejectLibrary() {
        val target = app.repoRoot / "manifest.d" / "00_installers.toml"
        if (app.fs.exists(target) && !force) {
            echo("error: $target already exists (use --force to overwrite)")
            throw ProgramResult(1)
        }
        app.fs.createDirectories(app.repoRoot / "manifest.d")
        app.fs.write(target) { writeUtf8(InstallerLibrary.TOML) }
        echo(" " + Style.ok("✔") + "  wrote $target")
        echo(Style.dim("  These now override the built-ins; delete the ones you don't want to own."))
    }
}
