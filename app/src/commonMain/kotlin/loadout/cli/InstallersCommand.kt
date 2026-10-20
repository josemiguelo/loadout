package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.UsageError
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.optional

/**
 * What `installVia(dnf)` actually means. Installers ship with loadout and are
 * merged under the repo's own, so this is where you see which definition
 * won. To own a built-in, declare an installer of the same name.
 */
class InstallersCommand : CliktCommand(name = "installers") {
    override fun help(context: Context) = commandHelp(
        "Show the install mechanisms available to this repo: loadout's built-ins plus your own.",
        "[name]     print one installer's full definition",
    )

    private val name by argument(name = "name", help = "Installer to describe").optional()

    private val app by requireObject<AppContext>()

    override fun run() {
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
                installer.upgrade?.let { "upgrade" to it },
                ("sudo" to "yes — a run that installs or upgrades through it asks for the password first").takeIf { installer.sudo },
                installer.check?.let { "check" to it },
                installer.regex?.let { "regex" to it },
                installer.outdated?.let { "outdated" to it },
                installer.outdatedAll?.let { "outdated-all" to it },
                installer.requires.takeIf { it.isNotEmpty() }?.let { "requires" to it.joinToString() },
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
        echo(Style.dim("  A repo installer of the same name replaces the built-in."))
    }
}
