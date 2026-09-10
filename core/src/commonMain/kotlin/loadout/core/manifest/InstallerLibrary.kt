package loadout.core.manifest

import loadout.core.model.Installer

/**
 * The installers loadout ships with. Mechanics belong to the tool, intent
 * belongs to the repo: a config repo says "1password, via dnf" and loadout
 * knows what dnf means.
 *
 * These are merged UNDER a repo's own `[installers.*]` at load
 * ([ManifestLoader.loadRepo]) — a repo definition of the same name replaces
 * the built-in outright — and they are never *detected*: nothing here probes the
 * machine or picks an installer for you, mapping still decides everything.
 *
 * Kept as TOML text, not as constructed objects, so `installers --eject`
 * hands you the exact thing loadout uses and `installers <name>` can show
 * it verbatim.
 */
object InstallerLibrary {
    val TOML: String = """
# Installers that ship with loadout: each mechanism's probe, install
# command, version check and update oracles, defined once. {pkg} is the
# package id — it defaults to the program name.
#
# A repo does not need this file: these are built in, and `via = ["dnf"]`
# resolves to the definition below. Declaring [installers.<name>] in your
# own manifest replaces the built-in of that name outright.
# `loadout installers --eject` writes this file into your repo when you
# want to pin or patch it.
#
# `outdated-all` asks the remote ONCE for everything ("<pkg> <candidate>"
# lines) — that is the only oracle these need. The per-pkg `outdated` key
# still exists for repos to use, but a batch oracle always wins over it
# (Manifest.resolveInstall), so spelling one out here would be dead config.

# --- exercised on the maintainer's fleet ---------------------------------
[installers.dnf]
probe = "dnf"
install = "sudo dnf install -y {pkg}"
check = "rpm -q {pkg}"
outdated-all = "dnf -q --cacheonly check-update | awk 'NF>=3 && $2 ~ /^[0-9]/ {name=$1; sub(/[.][^.]*$/, \"\", name); print name, $2}'"
regex = "([0-9]+\\.[0-9][0-9.]*)"

[installers.brew]
probe = "brew"
install = "brew install {pkg}"
check = "brew list --versions {pkg}"
outdated-all = "HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --verbose | awk '{n=$1; sub(/.*[/]/, \"\", n); v=${'$'}NF; gsub(/[()]/, \"\", v); print n, v}'"
regex = "([0-9]+\\.[0-9][0-9.]*)"

[installers.brew-cask]
probe = "brew"
install = "brew install --cask {pkg}"
check = "brew list --cask --versions {pkg}"
outdated-all = "HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --cask --verbose | awk '{n=$1; sub(/.*[/]/, \"\", n); v=${'$'}NF; gsub(/[()]/, \"\", v); print n, v}'"
regex = "([0-9]+\\.[0-9][0-9.]*)"

# Flatpak apps at user level; pkg is the application id. The batch line says
# "Version:" so the shared regex (shaped for remote-info) matches it too.
[installers.flatpak]
probe = "flatpak"
install = "flatpak --user install -y flathub {pkg}"
check = "flatpak --user info {pkg}"
outdated-all = "flatpak --user remote-ls --updates --cached --columns=application,version flathub | awk '{print $1, \"Version:\", $2}'"
regex = "Version: ([0-9][0-9.]*)"

# --- best effort: install/check only, no update oracle -------------------
# Not exercised by the maintainer; `loadout outdated` reports "no oracle"
# for programs mapped here. Override in your repo to add one.
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
""".trimIndent() + "\n"

    /** Parsed once; the same map every load merges under the repo's own. */
    val installers: Map<String, Installer> by lazy { ManifestLoader.parseInstallers(TOML) }

    val names: Set<String> get() = installers.keys
}
