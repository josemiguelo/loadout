package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import loadout.core.exec.ShellCommand
import loadout.core.manifest.LockFile

/**
 * Builds the repo's Kotlin manifests into loadout.lock.json, the one thing
 * every other command reads. The repo is a small Gradle project, so this
 * needs a JDK; a machine that only reads the committed lock doesn't.
 */
class CompileCommand : CliktCommand(name = "compile") {
    override fun help(context: Context) = commandHelp(
        "Compile the repo's Kotlin manifests into ${LockFile.NAME} (needs a JDK).",
    )

    private val app by requireObject<AppContext>()

    override fun run() = compileRepo(app)
}

/**
 * Compiles [app]'s repo, saying what it wrote and warned; a failed compile
 * prints Gradle's output and stops with its exit. `sync` runs it too, for a
 * child whose parent's manifests changed.
 */
internal fun CliktCommand.compileRepo(app: AppContext) {
    val home = LoadoutHome.find(app.fs)
    val root = app.fs.canonicalize(app.repoRoot)
    if (!app.fs.exists(root / "gradlew")) {
        echo("error: $root has no gradlew — a config repo is a Gradle project (see: loadout init)")
        throw ProgramResult(1)
    }
    // Gradle's output only matters when it fails, so it's held until then.
    val result = spinning("compiling manifests…") {
        app.runner.capture(
            ShellCommand(
                "sh ./gradlew -q --console=plain loadoutCompile",
                cwd = root.toString(),
                env = mapOf("LOADOUT_HOME" to home.toString()),
            ),
        )
    }
    if (!result.success) {
        listOf(result.stdout, result.stderr).filter { it.isNotBlank() }.forEach { echo(it.trimEnd(), err = true) }
        throw ProgramResult(result.exitCode)
    }
    echo(" " + Style.ok("✔") + "  wrote ${LockFile.NAME}")
    // What the manifests declare but no machine uses.
    for (line in result.stdout.lines().filter { it.startsWith("warning: ") }) {
        echo(" " + Style.warn("!") + "  " + line.removePrefix("warning: "))
    }
    // Loadout builds outside the repo now (the Gradle plugin); an older
    // version's build/ stays, and an editor indexes its classes.
    if (app.fs.exists(root / "build" / "classes")) {
        echo(" " + Style.warn("!") + "  delete build/: it's left from an older loadout, and editors would show every declaration twice")
    }
}
