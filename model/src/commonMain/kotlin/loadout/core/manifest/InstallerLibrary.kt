package loadout.core.manifest

import loadout.core.model.Installer

/**
 * The installers loadout ships with. Mechanics belong to the tool, intent
 * belongs to the repo: a config repo says "1password, via dnf" and loadout
 * knows what dnf means.
 *
 * Merged UNDER a repo's own installers when the manifest is assembled — a
 * repo installer of the same name replaces the built-in outright — and never
 * *detected*: nothing here probes the machine or picks an installer for you,
 * mapping still decides everything.
 *
 * `upgrade` upgrades EVERYTHING the mechanism manages — loadout has no
 * per-package form, because partial upgrades are unsupported on Arch and
 * discouraged on Fedora, and a package manager resolves its own transaction
 * regardless. Converge never runs it; `loadout upgrade` is the explicit verb.
 *
 * `outdated-all` asks the remote ONCE for everything ("<pkg> <candidate>"
 * lines) — that is the only oracle these need. A batch oracle always wins
 * over the per-package `outdated` pattern (Manifest.resolveInstall), so
 * spelling one out here would be dead config.
 */
object InstallerLibrary {
    private const val VERSION = """([0-9]+\.[0-9][0-9.]*)"""

    private const val DNF_OUTDATED =
        """dnf -q --cacheonly check-update | awk 'NF>=3 && ${'$'}2 ~ /^[0-9]/ {name=${'$'}1; sub(/[.][^.]*${'$'}/, "", name); print name, ${'$'}2}'"""

    private const val BREW_AWK =
        """awk '{n=${'$'}1; sub(/.*[/]/, "", n); v=${'$'}NF; gsub(/[()]/, "", v); print n, v}'"""

    private const val PACMAN_OUTDATED = """checkupdates --nocolor | awk '${'$'}3 == "->" {print ${'$'}1, ${'$'}4}'"""

    val installers: Map<String, Installer> = linkedMapOf(
        // --- exercised on the maintainer's fleet -------------------------
        "dnf" to Installer(
            probe = "dnf",
            install = "sudo dnf install -y {pkg}",
            upgrade = "sudo dnf upgrade --refresh -y",
            check = "rpm -q {pkg}",
            outdatedAll = DNF_OUTDATED,
            regex = VERSION,
        ),
        // HOMEBREW_NO_ASK: Homebrew asks before an install that pulls in
        // dependencies; a converge runs unattended.
        "brew" to Installer(
            probe = "brew",
            install = "HOMEBREW_NO_ASK=1 brew install {pkg}",
            upgrade = "brew upgrade",
            check = "brew list --versions {pkg}",
            outdatedAll = "HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --verbose | $BREW_AWK",
            regex = VERSION,
        ),
        "brew-cask" to Installer(
            probe = "brew",
            install = "HOMEBREW_NO_ASK=1 brew install --cask {pkg}",
            upgrade = "brew upgrade --cask",
            check = "brew list --cask --versions {pkg}",
            outdatedAll = "HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --cask --verbose | $BREW_AWK",
            regex = VERSION,
        ),
        // Flatpak apps at user level; pkg is the application id. The batch
        // line says "Version:" so the shared regex (shaped for remote-info)
        // matches it too.
        "flatpak" to Installer(
            probe = "flatpak",
            install = "flatpak --user install -y flathub {pkg}",
            upgrade = "flatpak --user update -y",
            check = "flatpak --user info {pkg}",
            outdatedAll = "flatpak --user remote-ls --updates --cached --columns=application,version flathub | " +
                """awk '{print ${'$'}1, "Version:", ${'$'}2}'""",
            regex = "Version: ([0-9][0-9.]*)",
        ),
        // A vendor rpm repository: `repofile` is its .repo file — a URL the
        // vendor publishes, or a path in your config repo. dnf imports the key
        // the file names at install time. dnf5 only (`config-manager
        // addrepo`); on dnf4 declare your own installer.
        "dnf-repo" to Installer(
            probe = "dnf",
            params = listOf("repofile"),
            install = "sudo dnf config-manager addrepo --overwrite --from-repofile={repofile} && sudo dnf install -y {pkg}",
            upgrade = "sudo dnf upgrade --refresh -y",
            check = "rpm -q {pkg}",
            outdatedAll = DNF_OUTDATED,
            regex = VERSION,
        ),
        // A COPR is dnf plus one enable step; `copr` names it (params).
        "dnf-copr" to Installer(
            probe = "dnf",
            params = listOf("copr"),
            install = "sudo dnf copr enable -y {copr} && sudo dnf install -y {pkg}",
            upgrade = "sudo dnf upgrade --refresh -y",
            check = "rpm -q {pkg}",
            outdatedAll = DNF_OUTDATED,
            regex = VERSION,
        ),
        // Arch repo packages. The oracle is `checkupdates` (pacman-contrib),
        // not `pacman -Qu`: nothing on Arch refreshes the sync databases
        // between upgrades, so -Qu answers from whenever the last -Syu ran,
        // while checkupdates syncs a private copy without root. Its lines read
        // "<pkg> <installed> -> <candidate>". Without pacman-contrib installed
        // the oracle finds nothing — map pacman-contrib itself so status
        // catches that.
        "pacman" to Installer(
            probe = "pacman",
            install = "sudo pacman -S --noconfirm {pkg}",
            upgrade = "sudo pacman -Syu --noconfirm",
            check = "pacman -Q {pkg}",
            outdatedAll = PACMAN_OUTDATED,
            regex = VERSION,
        ),
        // Arch packages the Omarchy way: `omarchy pkg add` (pacman -S
        // --needed, then its own pacman -Q verification) instead of a bare
        // pacman install. The upgrade is `omarchy update -y`, not pacman -Syu:
        // Omarchy's alpm hook refuses direct system upgrades, and the update
        // also runs Omarchy's migrations (-y skips the opening confirmation;
        // sudo and its other questions still ask, on the terminal). The oracle
        // is pacman's: the databases checkupdates syncs track Omarchy's pinned
        // mirror snapshot, exactly what `omarchy update` brings. Both commands
        // run sudo from inside.
        "omarchy" to Installer(
            probe = "omarchy",
            sudo = true,
            install = "omarchy pkg add {pkg}",
            upgrade = "omarchy update -y",
            check = "pacman -Q {pkg}",
            outdatedAll = PACMAN_OUTDATED,
            regex = VERSION,
        ),
        // AUR packages the Omarchy way: `omarchy pkg aur add` (yay, then
        // pacman -Q). The AUR is community build recipes, not Omarchy's repo:
        // map a program here only after deciding to trust it. The upgrade is
        // the same `omarchy update -y` (it upgrades AUR packages too), so
        // `loadout upgrade` runs it once for both. The oracle is yay's AUR
        // check, "<pkg> <installed> -> <candidate>". yay runs sudo from inside.
        "omarchy-aur" to Installer(
            probe = "omarchy",
            sudo = true,
            install = "omarchy pkg aur add {pkg}",
            upgrade = "omarchy update -y",
            check = "pacman -Q {pkg}",
            outdatedAll = """yay -Qua 2>/dev/null | awk '${'$'}3 == "->" {print ${'$'}1, ${'$'}4}'""",
            regex = VERSION,
        ),
        // --- best effort: install/check only, no update oracle -----------
        // Not exercised by the maintainer; `loadout outdated` reports "no
        // oracle" for programs mapped here. Override in your repo to add one.
        "apt" to Installer(
            probe = "apt-get",
            install = "sudo apt-get install -y {pkg}",
            upgrade = "sudo apt-get upgrade -y",
            check = "dpkg-query -W {pkg}",
            regex = VERSION,
        ),
    )

    val names: Set<String> get() = installers.keys
}
