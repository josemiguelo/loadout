package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.default
import com.github.ajalt.clikt.parameters.arguments.help
import com.github.ajalt.clikt.parameters.options.flag
import com.github.ajalt.clikt.parameters.options.option
import loadout.core.git.GitClient
import loadout.core.manifest.LockFile
import okio.Path
import okio.Path.Companion.toPath

private val SETTINGS = """
    // A loadout config repo: `loadout compile` builds it into loadout.lock.json.
    // The plugin and the DSL ship with loadout, in its share directory.
    pluginManagement {
        val home = providers.environmentVariable("LOADOUT_HOME")
            .getOrElse("${'$'}{System.getProperty("user.home")}/.local/share/loadout")
        val version = java.io.File("${'$'}home/VERSION").readText().trim()
        repositories {
            maven(uri("${'$'}home/maven"))
            gradlePluginPortal()
        }
        plugins {
            id("io.github.josemiguelo.loadout") version version
        }
    }

    rootProject.name = "loadout-config"
""".trimIndent() + "\n"

private val BUILD = """
    plugins {
        id("io.github.josemiguelo.loadout")
    }

    // The manifest files, in compile order. Only files these globs match are
    // compiled (* = within a folder, ** = any depth; dot-files match only
    // when the glob spells the dot).
    loadout {
        sources(
            "loadout.kt",
            "programs/**/*.loadout.kt",
            "maintenance/**/*.loadout.kt",
            "machines.loadout.kt",
        )
    }
""".trimIndent() + "\n"

private fun rootFile(configs: Boolean) = """
    // The repo: its name, where loadout writes each machine's state, and the
    // data every machine carries (dotfile templates read it too).
    package repo

    import loadout.dsl.*

    val loadout = repo(name = "my machines", state = "state",${if (configs) " configs = \"configs\"," else ""} data = ::Data)

    /** Every per-machine setting, with its default. */
    class Data : MachineData() {
        /** A work machine. */
        var work by flag(false)
    }

    /** Lets machines say `data { work = true }`. */
    fun MachineScope.data(block: Data.() -> Unit) = data(::Data, block)

    // The built-in installers this repo uses (`loadout installers` lists them all).
    val dnf = Builtin.dnf
    val apt = Builtin.apt
    val pacman = Builtin.pacman
    val brew = Builtin.brew
""".trimIndent() + "\n"

private val PROGRAMS = """
    // Programs. A program says which installers can install it; a machine
    // picks one. `loadout explain ripgrep` shows what it resolves to. Paths
    // a file names (scripts, `file:` commands) are relative to its folder.
    package repo

    import loadout.dsl.*

    val ripgrep = program(
        name = "ripgrep",
        description = "fast grep",
    ) {
        installVia(
            dnf,
            apt,
            pacman,
            brew,
        )
    }
""".trimIndent() + "\n"

private fun machines(hostname: String) = """
    // Machines, by hostname, and the profiles they share. A machine installs
    // only what it (or a profile it extends) names, and runs only the scripts
    // it names.
    package repo

    import loadout.dsl.*

    val thisMachine = machine(hostname = "$hostname") {
        // install(dnf, ripgrep)
    }
""".trimIndent() + "\n"

private val GITIGNORE = """
    # Gradle's working files; loadout.lock.json is committed.
    /build/
    /.gradle/
    /.kotlin/
""".trimIndent() + "\n"

class InitCommand : CliktCommand(name = "init") {
    override fun help(context: Context) = commandHelp(
        "Scaffold a new config repo (Kotlin manifests, a Gradle wrapper, state/) and git init it.",
        "[path]     where to scaffold (default: current directory)",
        "--configs  hold your dotfiles too: chezmoi's source in configs/",
    )

    private val path by argument(name = "path").help("Where to create the repo").default(".")
    private val configs by option("--configs", help = "Hold dotfiles too (chezmoi's source in configs/)").flag()

    private val app by requireObject<AppContext>()

    override fun run() {
        val root = path.toPath()
        val fs = app.fs
        for (existing in listOf("loadout.kt", "settings.gradle.kts", "build.gradle.kts", LockFile.NAME)) {
            if (fs.exists(root / existing)) {
                echo("error: ${root / existing} already exists; refusing to overwrite.")
                throw ProgramResult(1)
            }
        }
        val home = LoadoutHome.find(fs)
        val hostname = app.detectSystem().machine

        for (dir in listOf("programs", "maintenance", "state", "gradle/wrapper")) fs.createDirectories(root / dir)
        fs.write(root / "settings.gradle.kts") { writeUtf8(SETTINGS) }
        fs.write(root / "build.gradle.kts") { writeUtf8(BUILD) }
        fs.write(root / "loadout.kt") { writeUtf8(rootFile(configs)) }
        fs.write(root / "programs" / "cli.loadout.kt") { writeUtf8(PROGRAMS) }
        fs.write(root / "machines.loadout.kt") { writeUtf8(machines(hostname)) }
        fs.write(root / ".gitignore") { writeUtf8(GITIGNORE) }
        fs.write(root / "state" / ".gitkeep") { }
        fs.write(root / "maintenance" / ".gitkeep") { }
        copyWrapper(home, root)
        if (configs) {
            // chezmoi reads only configs/; the compile writes its data and
            // the loadout/machine partial there.
            fs.createDirectories(root / "configs")
            fs.write(root / ".chezmoiroot") { writeUtf8("configs\n") }
            fs.write(root / "configs" / ".gitkeep") { }
        }
        val parts = listOf("loadout.kt", "programs/", "maintenance/", "machines.loadout.kt", "state/") +
            listOfNotNull("configs/ (chezmoi's source)".takeIf { configs })
        echo("Created $root: ${parts.joinToString()} and a Gradle wrapper")

        val git = GitClient(app.runner, root)
        if (git.isRepo()) {
            echo("Already inside a git repository; skipping git init.")
        } else {
            git.init()
            echo("Initialized git repository.")
        }

        echo("")
        echo(Style.header("Next steps:"))
        echo("  1. Open $root in your IDE (it's a Gradle project) and add programs and scripts")
        echo("  2. Say what this machine installs in machines.loadout.kt")
        echo("  3. loadout --repo $root compile   # writes ${LockFile.NAME}; needs a JDK")
        if (configs) {
            echo("     (and configs/.chezmoidata/loadout.json + .chezmoitemplates/loadout/machine:")
            echo("     templates read this machine's data with includeTemplate \"loadout/machine\" . | fromJson)")
        }
        echo("  4. loadout --repo $root status")
        echo("  5. Commit (the lock too), add a remote and push, then clone it on your other machines")
    }

    /** The Gradle wrapper loadout ships, so the repo builds with a known Gradle. */
    private fun copyWrapper(home: Path, root: Path) {
        val fs = app.fs
        for (file in listOf("gradlew", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties")) {
            fs.copy(home / "gradle" / file, root / file)
        }
        app.runner.capture("chmod +x '${root / "gradlew"}'")
    }
}
