package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import com.github.ajalt.clikt.core.Context
import com.github.ajalt.clikt.core.ProgramResult
import com.github.ajalt.clikt.core.requireObject
import com.github.ajalt.clikt.parameters.arguments.argument
import com.github.ajalt.clikt.parameters.arguments.default
import com.github.ajalt.clikt.parameters.arguments.help
import loadout.core.git.GitClient
import okio.Path.Companion.toPath

private val STARTER_MANIFEST = """
    # loadout manifest — programs and setup scripts for all your machines.

    [meta]
    name = "my machines"
    # Bump this when the repo starts using features of a newer loadout —
    # machines running older binaries then refuse with an "upgrade" error:
    #min-tool-version = "0.6.0"

    # Install mechanics (commands, version checks, probes) live once in
    # manifest.d/00_installers.toml — a standard package is one `via` line,
    # and `loadout explain ripgrep` prints what it resolves to. Programs that
    # need more declare [programs.<x>.install.<key>] variants (see the README).
    [programs.ripgrep]
    description = "fast grep"
    via = ["dnf", "apt", "pacman", "brew"]

    # Scripts run after installs; `check` exiting 0 means "already done".
    # Use `file` for a script in the repo (validated to exist) or `run` for
    # an inline command — exactly one of the two.
    #[scripts.dotfiles]
    #file = "scripts/dotfiles.sh"
    #check = "test -d ${'$'}HOME/.dotfiles"

    # Every machine must map each program to one of its install keys in its
    # own machines/<name>.toml file — installing fails for unmapped programs.
    # Large manifests can also be split into manifest.d/*.toml fragments.
""".trimIndent() + "\n"

private val STARTER_INSTALLERS = """
    # Installers: each mechanism's probe, install command, and version check,
    # defined once. {pkg} is the package id — it defaults to the program name.
    # Programs use them via `via = ["dnf", ...]` or an
    # [programs.<x>.install.<key>] variant referencing `installer = "..."`.
    [installers.dnf]
    probe = "dnf"
    install = "sudo dnf install -y {pkg}"
    check = "rpm -q {pkg}"
    regex = "([0-9]+\\.[0-9][0-9.]*)"

    [installers.apt]
    probe = "apt-get"
    install = "sudo apt-get install -y {pkg}"
    check = "dpkg-query -W {pkg}"
    regex = "([0-9]+\\.[0-9][0-9.]*)"

    [installers.pacman]
    probe = "pacman"
    install = "sudo pacman -S --noconfirm {pkg}"
    check = "pacman -Q {pkg}"
    regex = "([0-9]+\\.[0-9][0-9.]*)"

    [installers.brew]
    probe = "brew"
    install = "brew install {pkg}"
    check = "brew list --versions {pkg}"
    regex = "([0-9]+\\.[0-9][0-9.]*)"

    # A template turns a list of standard packages into one program each —
    # `[templates.pkg] packages = [...]` members expand with these installers:
    [templates.pkg]
    via = ["dnf", "apt", "pacman", "brew"]
""".trimIndent() + "\n"

private val STARTER_MACHINE = """
    # Per-machine config for the machine named like this file (machines/<name>.toml).

    # Scripts run only on machines that opt in. Entries are "name" or
    # "name args..." (args become positional params for file scripts and their
    # checks). NOTE: keep this line ABOVE [pm] — top-level keys placed after a
    # table header would belong to that table.
    #scripts = ["dotfiles", "setup-ssh fedora"]

    # Map every program to one entry of its install table:
    #[pm]
    #ripgrep = "dnf"
""".trimIndent() + "\n"

private val STARTER_FRAGMENT = """
    # Manifest fragment: same syntax as manifest.toml ([programs.*]/[scripts.*]
    # blocks; no [meta], no machine configs). All fragments in manifest.d/ are
    # merged with the root manifest — use them to keep it from growing huge,
    # e.g. one file per topic (cli-tools.toml, development.toml, desktop.toml).
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
        "Scaffold a new config repo (manifest, scripts/, state/, machines/) and git init it.",
        "[path]  where to scaffold (default: current directory)",
    )

    private val path by argument(name = "path").help("Where to create the repo").default(".")

    private val app by requireObject<AppContext>()

    override fun run() {
        val root = path.toPath()
        val manifestPath = root / "manifest.toml"
        if (app.fs.exists(manifestPath)) {
            echo("error: $manifestPath already exists; refusing to overwrite.")
            throw ProgramResult(1)
        }

        app.fs.createDirectories(root / "scripts")
        app.fs.createDirectories(root / "state")
        app.fs.createDirectories(root / "machines")
        app.fs.createDirectories(root / "manifest.d")
        app.fs.write(manifestPath) { writeUtf8(STARTER_MANIFEST) }
        app.fs.write(root / "state" / ".gitkeep") { }
        app.fs.write(root / "machines" / "example.toml.sample") { writeUtf8(STARTER_MACHINE) }
        app.fs.write(root / "manifest.d" / "example.toml.sample") { writeUtf8(STARTER_FRAGMENT) }
        app.fs.write(root / "manifest.d" / "00_installers.toml") { writeUtf8(STARTER_INSTALLERS) }
        echo("Created $manifestPath")
        echo("Created ${root / "manifest.d" / "00_installers.toml"} (installers + the pkg template)")
        echo("Created ${root / "scripts"}/")
        echo("Created ${root / "state"}/")
        echo("Created ${root / "machines"}/ (rename example.toml.sample to <your-machine>.toml)")
        echo("Created ${root / "manifest.d"}/ (optional manifest fragments; see example.toml.sample)")

        val git = GitClient(app.runner, root)
        if (git.isRepo()) {
            echo("Already inside a git repository; skipping git init.")
        } else {
            git.init()
            echo("Initialized git repository.")
        }

        echo("")
        echo("Next steps:")
        echo("  1. Edit ${manifestPath} — add your programs and scripts")
        echo("  2. Map each program to an install key in machines/<your-hostname>.toml")
        echo("  3. loadout --repo $root status")
        echo("  4. Add a remote and push, then clone it on your other machines")
    }
}
