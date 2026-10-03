package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.default
import com.github.ajalt.clikt.parameters.arguments.help
import loadout.core.git.GitClient
import loadout.core.manifest.ManifestLoader
import okio.Path.Companion.toPath

private val STARTER_MANIFEST = """
    # loadout root file — programs and setup scripts for all your machines.

    [meta]
    name = "my machines"
    # Bump this when the repo starts using features of a newer loadout —
    # machines running older binaries then refuse with an "upgrade" error:
    #min-tool-version = "1.0.0"

    # Where the repo's parts live, relative to this file. Only the files the
    # fragments globs match are loaded, in this order (* = within a folder,
    # ** = any depth; dot-files match only when the glob spells the dot).
    [layout]
    fragments = ["programs/**/*.toml", "maintenance/**/*.toml"]
    machines = "machines"
    profiles = "profiles"
    state = "state"

    # Per-machine settings (dotfile templates read them too): every key a
    # machine file may set, with its default. A machine setting a key not
    # declared here is a load error.
    #[data]
    #work = false

    # Install mechanics (commands, version checks, probes) ship with loadout:
    # `loadout installers` lists them, `via` names the ones that apply, and
    # `loadout explain ripgrep` prints what it resolves to. Declare your own
    # [installers.<name>] to add or replace one (`loadout installers --eject`
    # copies the built-ins into this repo). Programs that need more than a
    # plain package declare [programs.<x>.install.<key>] variants.
    [programs.ripgrep]
    description = "fast grep"
    via = ["dnf", "apt", "pacman", "brew"]

    # Scripts run after installs; `check` exiting 0 means "already done".
    # Use `file` for a script in the repo (validated to exist) or `run` for
    # an inline command — exactly one of the two.
    #[scripts.dotfiles]
    #file = "maintenance/dotfiles/dotfiles.sh"
    #check = "test -d ${'$'}HOME/.dotfiles"

    # A machine installs only the programs its machines/<name>.toml (or a
    # profile it extends) maps to one of their install keys. Programs and
    # scripts usually live in fragment files under programs/ and
    # maintenance/ rather than here.
""".trimIndent() + "\n"

private val STARTER_MACHINE = """
    # The machine named like this file (machines/<hostname>.toml).

    # Profiles this machine builds on (profiles/<name>.toml), in order; what
    # this file says overrides them.
    #extends = ["linux"]

    # One table per tool or concern: `install` names the install key of the
    # program named like the table (or a table of program = key for
    # several), `scripts` opts into setup scripts ("name" or "name args...",
    # args become positional params for file scripts and their checks).
    #[ripgrep]
    #install = "dnf"
    #
    #[dotfiles]
    #scripts = ["dotfiles"]

    # This machine's values for keys loadout.toml declares under [data]
    # (or [<table>.data], which is [data.<table>]):
    #[data]
    #work = true
""".trimIndent() + "\n"

private val STARTER_PROFILE = """
    # A profile: what every machine extending it shares (extends = ["<name>"]).
    # Same tables as a machine file; never a machine itself.
    #[ripgrep]
    #install = "dnf"
""".trimIndent() + "\n"

private val STARTER_FRAGMENT = """
    # Fragment: [installers.*], [programs.*], [scripts.*] and [outdated.*]
    # blocks (no [meta], no [layout], no machine configs). Every file the
    # [layout] fragments globs match is merged with loadout.toml — e.g. one
    # file per topic (cli-tools.toml, development.toml, desktop.toml).
    #
    #[programs.fzf]
    #description = "fuzzy finder"
    #via = ["dnf", "apt", "pacman", "brew"]
    #
    # Variants override what the installer can't know — a different package
    # id, a custom command, check, or probe:
    #[programs.fzf.install.brew-head]
    #installer = "brew"
    #command = "brew install --HEAD fzf"
""".trimIndent() + "\n"

class InitCommand : CliktCommand(name = "init") {
    override fun help(context: Context) = commandHelp(
        "Scaffold a new config repo (loadout.toml, programs/, maintenance/, machines/, profiles/, state/) and git init it.",
        "[path]  where to scaffold (default: current directory)",
    )

    private val path by argument(name = "path").help("Where to create the repo").default(".")

    private val app by requireObject<AppContext>()

    override fun run() {
        val root = path.toPath()
        val manifestPath = root / ManifestLoader.ROOT_FILE
        if (app.fs.exists(manifestPath)) {
            echo("error: $manifestPath already exists; refusing to overwrite.")
            throw ProgramResult(1)
        }

        for (dir in listOf("programs", "maintenance", "machines", "profiles", "state")) {
            app.fs.createDirectories(root / dir)
        }
        app.fs.write(manifestPath) { writeUtf8(STARTER_MANIFEST) }
        app.fs.write(root / "state" / ".gitkeep") { }
        app.fs.write(root / "maintenance" / ".gitkeep") { }
        app.fs.write(root / "machines" / "example.toml.sample") { writeUtf8(STARTER_MACHINE) }
        app.fs.write(root / "profiles" / "example.toml.sample") { writeUtf8(STARTER_PROFILE) }
        app.fs.write(root / "programs" / "example.toml.sample") { writeUtf8(STARTER_FRAGMENT) }
        echo("Created $manifestPath")
        echo("Created ${root / "programs"}/ (fragments: programs and installers; see example.toml.sample)")
        echo("Created ${root / "maintenance"}/ (fragments: scripts, one folder per concern)")
        echo("Created ${root / "machines"}/ (rename example.toml.sample to <your-machine>.toml)")
        echo("Created ${root / "profiles"}/ (what machines of a kind share; see example.toml.sample)")
        echo("Created ${root / "state"}/")

        val git = GitClient(app.runner, root)
        if (git.isRepo()) {
            echo("Already inside a git repository; skipping git init.")
        } else {
            git.init()
            echo("Initialized git repository.")
        }

        echo("")
        echo(Style.header("Next steps:"))
        echo("  1. Edit ${manifestPath} — add your programs and scripts")
        echo("  2. Map each program to an install key in machines/<your-hostname>.toml")
        echo("  3. loadout --repo $root status")
        echo("  4. Add a remote and push, then clone it on your other machines")
    }
}
