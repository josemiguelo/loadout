package loadout.core

import loadout.dsl.machine
import loadout.dsl.invoke
import loadout.dsl.manifestOf
import loadout.dsl.meta
import loadout.dsl.layout
import loadout.dsl.root

/**
 * The shared fixture: three installers of its own (replacing the built-ins
 * of their names, so commands stay short), git and ripgrep through them,
 * rustup by its own command, a dotfiles script no machine runs, and two
 * machines.
 */
val EXAMPLE_MANIFEST = manifestOf {
    meta(name = "example machines", minToolVersion = "0.1.0")
    layout(state = "state")
    val brew = root.installer("brew") { probe = "brew"; install = "brew install {pkg}" }
    val dnf = root.installer("dnf") { probe = "dnf"; install = "sudo dnf install -y {pkg}" }
    val apt = root.installer("apt") { probe = "apt-get"; install = "sudo apt-get install -y {pkg}" }
    val git = root.program("git", "version control") {
        installVia(brew, dnf, apt)
        version("git --version", "git version ([0-9.]+)")
    }
    val ripgrep = root.program("ripgrep", "fast grep") {
        tags("cli")
        dependsOn(git)
        installVia(brew, dnf)
        version("rg --version", "ripgrep ([0-9][0-9a-zA-Z.-]*)")
    }
    val rustup = root.program("rustup", "rust toolchain manager") {
        version("rustup --version", "rustup ([0-9.]+)")
        custom("script") { command = "curl -sSf https://sh.rustup.rs | sh -s -- -y" }
    }
    root.script("dotfiles", "clone and link dotfiles") {
        file("scripts/dotfiles.sh")
        check("test -d \$HOME/.dotfiles")
        runAfter(git)
    }
    machine("laptop") {
        via(dnf) {
            install(git, ripgrep)
        }
        install(rustup)
    }
    machine("macbook") {
        via(brew) {
            install(git, ripgrep)
        }
        install(rustup)
    }
}
